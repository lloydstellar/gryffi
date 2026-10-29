/**
 * Mistral AI Service - Gryffi Guide Chat
 * Based on NoirQuest NPC system but adapted for corporate guides
 * Now with RAG (Retrieval-Augmented Generation) support
 */

import { retrieveKnowledge, verifyAndCleanCitations, parseCitations } from './knowledge.js';
import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';


/**
 * "I don't have that info, please ask a human" fallback messages.
 * Used when:
 *   - The guide has knowledge sources but RAG retrieved zero relevant chunks
 *   - The model returned an answer to a knowledge question without any citation
 *
 * Each message is intentionally short, natural and points the user to a human.
 * Covers all 14 supported player languages.
 */
const NO_KNOWLEDGE_FALLBACKS = {
  en: "I don't have specific information about that in my knowledge base. I'd recommend asking your manager, a colleague, or the relevant department for accurate information.",
  nl: "Daar heb ik helaas geen specifieke informatie over in mijn kennisbank. Ik raad je aan dit aan je manager, een collega of de juiste afdeling te vragen voor betrouwbare informatie.",
  de: "Dazu habe ich leider keine spezifischen Informationen in meiner Wissensdatenbank. Ich empfehle, deine Vorgesetzten, einen Kollegen oder die zuständige Abteilung für genaue Informationen zu fragen.",
  fr: "Je n'ai pas d'informations spécifiques à ce sujet dans ma base de connaissances. Je te recommande de demander à ton manager, un collègue ou le service concerné pour obtenir des informations précises.",
  es: "No tengo información específica sobre eso en mi base de conocimientos. Te recomiendo preguntar a tu responsable, a un compañero o al departamento correspondiente para obtener información precisa.",
  it: "Non ho informazioni specifiche su questo nella mia base di conoscenza. Ti consiglio di chiedere al tuo responsabile, a un collega o al reparto competente per informazioni accurate.",
  pt: "Não tenho informações específicas sobre isso na minha base de conhecimento. Recomendo perguntar ao teu gestor, a um colega ou ao departamento competente para obter informações precisas.",
  da: "Jeg har desværre ikke specifik information om det i min vidensbase. Jeg vil anbefale, at du spørger din leder, en kollega eller den relevante afdeling for nøjagtige oplysninger.",
  no: "Jeg har dessverre ikke spesifikk informasjon om dette i kunnskapsbasen min. Jeg anbefaler at du spør lederen din, en kollega eller den relevante avdelingen for nøyaktig informasjon.",
  fi: "Minulla ei valitettavasti ole tarkkaa tietoa tästä tietopohjassani. Suosittelen kysymään esihenkilöltäsi, kollegalta tai asianomaiselta osastolta tarkat tiedot.",
  sv: "Jag har tyvärr ingen specifik information om det i min kunskapsbas. Jag rekommenderar att du frågar din chef, en kollega eller den berörda avdelningen för korrekt information.",
  pl: "Niestety nie mam konkretnych informacji na ten temat w mojej bazie wiedzy. Polecam zapytać przełożonego, kolegę lub odpowiedni dział, aby uzyskać dokładne informacje.",
  ro: "Nu am informații specifice despre acest subiect în baza mea de cunoștințe. Îți recomand să întrebi managerul, un coleg sau departamentul relevant pentru informații precise.",
  tr: "Bu konuda bilgi tabanımda ayrıntılı bilgiye sahip değilim. Doğru bilgi için yöneticinize, bir iş arkadaşınıza veya ilgili departmana danışmanızı öneririm."
};

/**
 * Get the language-appropriate "I don't know" fallback message.
 * Falls back to English if the requested language is not supported.
 *
 * @param {string} language - ISO 639-1 language code (e.g. 'en', 'nl', 'tr')
 * @returns {string} - Fallback message in the requested language
 */
function getNoKnowledgeFallback(language) {
  return NO_KNOWLEDGE_FALLBACKS[language] || NO_KNOWLEDGE_FALLBACKS.en;
}

/**
 * Merge two Mistral usage objects (e.g. classifier + main call) into one.
 * Used so AI credit tracking sums tokens from all calls made for a single user message.
 *
 * @param {Object|null} a - First usage object {promptTokens, completionTokens, totalTokens, model}
 * @param {Object|null} b - Second usage object
 * @returns {Object|null} - Merged usage, or whichever side is non-null
 */
function mergeUsage(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: (a.promptTokens || 0) + (b.promptTokens || 0),
    completionTokens: (a.completionTokens || 0) + (b.completionTokens || 0),
    totalTokens: (a.totalTokens || 0) + (b.totalTokens || 0),
    // Report the *main* model so credit logs reflect the heavy lift, not the classifier
    model: b.model || a.model
  };
}

/**
 * Clean AI response by removing surrounding quotes
 * Sometimes the AI wraps responses in quotes which we don't want
 * @param {string} text - Raw AI response
 * @returns {string} - Cleaned response
 */
function cleanResponse(text) {
  if (!text) return text;
  
  let cleaned = text.trim();
  
  // Remove surrounding double quotes
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1);
  }
  // Remove surrounding single quotes
  else if (cleaned.startsWith("'") && cleaned.endsWith("'")) {
    cleaned = cleaned.slice(1, -1);
  }
  // Remove markdown code block quotes
  else if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.slice(3, -3).trim();
  }
  
  return cleaned.trim();
}

/**
 * Personality presets for guides
 * These define the tone and behavior of different guide types
 */
export const PERSONALITY_PRESETS = {
  friendly: {
    name: 'Friendly & Warm',
    description: 'Welcoming and helpful, like a friendly colleague',
    traits: 'You are warm, approachable, and enthusiastic. You use casual but professional language. You enjoy helping people and make them feel comfortable. You might use light humor and always maintain a positive attitude.',
    example: 'Hey there! Great question - let me help you with that!'
  },
  professional: {
    name: 'Professional & Formal',
    description: 'Polished and business-like',
    traits: 'You are professional, precise, and courteous. You use formal language and maintain a respectful distance. You are efficient and focus on providing accurate information clearly and concisely.',
    example: 'Good afternoon. I would be happy to assist you with your inquiry.'
  },
  mentor: {
    name: 'Mentor & Teacher',
    description: 'Patient and educational, explains things thoroughly',
    traits: 'You are patient, wise, and encouraging. You love to teach and explain concepts clearly. You ask questions to understand needs better. You provide context and background. You celebrate small wins and learning moments.',
    example: 'That\'s a great question! Let me walk you through this step by step...'
  },
  energetic: {
    name: 'Energetic & Enthusiastic',
    description: 'High-energy, motivating personality',
    traits: 'You are upbeat, energetic, and motivating. You express excitement and passion. You use positive language and encourage action. You make even routine tasks feel important and exciting.',
    example: 'Awesome! You\'re going to love this - let\'s get started!'
  },
  calm: {
    name: 'Calm & Reassuring',
    description: 'Soothing and supportive, reduces anxiety',
    traits: 'You are calm, patient, and reassuring. You speak in a measured, relaxed way. You acknowledge concerns and provide comfort. You help people feel at ease, especially in stressful situations.',
    example: 'No worries at all, take your time. I\'m here to help whenever you\'re ready.'
  },
  technical: {
    name: 'Technical Expert',
    description: 'Knowledgeable specialist who can explain complex topics',
    traits: 'You are knowledgeable, precise, and detail-oriented. You can explain complex concepts in simple terms. You appreciate when people want to understand the "why" behind things. You use technical terms but always explain them.',
    example: 'Great question about the system architecture. Let me break that down for you...'
  },
  custom: {
    name: 'Custom Personality',
    description: 'Define your own personality in the instructions',
    traits: '',
    example: ''
  }
};

/**
 * Language names for display in prompts
 * Includes base languages (en, nl, de, fr, es) and extended player languages
 */
const LANGUAGE_NAMES = {
  en: 'English',
  nl: 'Dutch (Nederlands)',
  de: 'German (Deutsch)',
  fr: 'French (Français)',
  es: 'Spanish (Español)',
  it: 'Italian (Italiano)',
  pt: 'Portuguese (Português)',
  da: 'Danish (Dansk)',
  no: 'Norwegian (Norsk)',
  fi: 'Finnish (Suomi)',
  sv: 'Swedish (Svenska)',
  pl: 'Polish (Polski)',
  ro: 'Romanian (Română)',
  tr: 'Turkish (Türkçe)'
};

/**
 * Tiny safety-net heuristic for when the classifier API call fails.
 * Tries to recognise obvious greetings/thanks/farewells across the 14 supported
 * languages so a network blip doesn't trigger a "I don't know" reply on "hi".
 *
 * Returns 'conversational' if the message clearly looks like smalltalk,
 * otherwise 'knowledge_question' (the safer default - it triggers our citation
 * validation, so a wrong guess won't produce a hallucination).
 *
 * @param {string} message - The user's message
 * @returns {'conversational'|'knowledge_question'}
 */
function heuristicIntent(message) {
  if (!message) return 'conversational';
  const lower = message.trim().toLowerCase();

  // Empty or single-character messages
  if (lower.length < 2) return 'conversational';

  // Question marks are a strong signal of a factual question
  if (lower.includes('?')) return 'knowledge_question';

  // Very short messages without a question mark are usually smalltalk
  const wordCount = lower.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 2) return 'conversational';

  // Common greetings/thanks/farewells across our 14 languages
  // Kept intentionally conservative - we only catch obvious cases
  const conversationalStarts = [
    // greetings
    'hi', 'hey', 'hello', 'hallo', 'hoi', 'goedemorgen', 'goedemiddag', 'goedenavond',
    'guten ', 'bonjour', 'salut', 'bonsoir', 'hola', 'buenos ', 'buenas ',
    'ciao', 'buongiorno', 'buonasera', 'olá', 'ola ', 'bom dia', 'boa tarde',
    'hej', 'goddag', 'hei', 'god morgen', 'moi', 'terve', 'hyvää',
    'cześć', 'dzień dobry', 'witaj', 'bună', 'salut',
    'merhaba', 'selam', 'günaydın', 'iyi ',
    // thanks
    'thanks', 'thank you', 'bedankt', 'dank je', 'dank u', 'danke',
    'merci', 'gracias', 'grazie', 'obrigado', 'obrigada',
    'tak', 'takk', 'kiitos', 'tack', 'dziękuję', 'mulțumesc', 'teşekkür',
    // farewells
    'bye', 'goodbye', 'doei', 'dag', 'tot ziens', 'tschüss', 'auf wiedersehen',
    'au revoir', 'adiós', 'arrivederci', 'tchau', 'até logo',
    'farvel', 'ha det', 'näkemiin', 'hej då', 'do widzenia', 'la revedere', 'hoşça kal', 'görüşürüz'
  ];
  for (const start of conversationalStarts) {
    if (lower.startsWith(start)) return 'conversational';
  }

  return 'knowledge_question';
}

/**
 * Classify a user message as either 'conversational' (greetings, smalltalk,
 * thanks, farewells, questions about the AI itself, acknowledgements) or
 * 'knowledge_question' (any request for factual information about the company,
 * policies, processes, locations, people, products, training material, etc.).
 *
 * Uses the lightweight classifier model (ai.classifierModel) with JSON output for speed and
 * cost. Works across all 14 supported languages because the prompt explicitly
 * states the message can be in any language and includes few-shot examples.
 *
 * On API failure, falls back to a small built-in heuristic so a blip never
 * blocks the chat. Default on ambiguity is 'knowledge_question' (safer, because
 * citation validation will catch hallucinated responses).
 *
 * @param {string} userMessage - Latest user message
 * @param {Array} conversationHistory - Previous messages [{role, content}] (last few used for context)
 * @returns {Promise<{intent: 'conversational'|'knowledge_question', usage: Object|null}>}
 */
async function classifyIntent(userMessage, conversationHistory = []) {
  if (!(await isAiConfigured())) {
    return { intent: heuristicIntent(userMessage), usage: null };
  }
  const { classifierModel } = await getAiConfig();

  // Build a short context block from the last 2 messages so follow-ups
  // like "ja", "tell me more" can be classified correctly.
  const recentHistory = conversationHistory
    .slice(-2)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || '').slice(0, 200)}`)
    .join('\n');

  const systemPrompt = `You are an intent classifier for an AI guide that helps employees in a corporate training and onboarding app.

Classify the LATEST user message into one of exactly two categories:

- "conversational": greetings, farewells, thanks, smalltalk, questions about the AI itself ("who are you?", "what can you do?"), simple acknowledgements ("ok", "yes", "got it"), jokes, opinions, social niceties.
- "knowledge_question": any request for factual information about the company, policies, procedures, locations, people, products, processes, training material, schedules, rules, contact details, or any specific topic the user expects a factual answer about.

Important rules:
- The user message may be in any of 14 languages (English, Dutch, German, French, Spanish, Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish). Classify the same way regardless of language.
- Short follow-ups ("yes", "tell me more", "and?") that respond to a previous assistant question should be classified the same as the original turn — if the assistant just asked a factual question, treat it as knowledge_question.
- When in doubt, choose "knowledge_question".

Examples:
"Hi" -> conversational
"Hoi, hoe gaat het?" -> conversational
"Bedankt!" -> conversational
"Doei" -> conversational
"Wie ben jij?" -> conversational
"Vertel een grapje" -> conversational
"ok" -> conversational
"Wat is ons verlofbeleid?" -> knowledge_question
"How do I request vacation days?" -> knowledge_question
"Quelles sont les heures d'ouverture?" -> knowledge_question
"Erkläre mir die Onboarding-Prozesse" -> knowledge_question
"Wie werkt de schoonmaakroutine?" -> knowledge_question
"Where is the cafeteria?" -> knowledge_question

Respond with ONLY a valid JSON object, no extra text:
{"intent": "conversational"} or {"intent": "knowledge_question"}`;

  const userPrompt = recentHistory
    ? `Recent conversation:\n${recentHistory}\n\nLatest user message to classify: "${userMessage}"`
    : `User message to classify: "${userMessage}"`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await aiFetch('/chat/completions', {
      body: JSON.stringify({
        model: classifierModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0,
        max_tokens: 30,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.warn(`[Mistral] Classifier API error: ${response.status} - falling back to heuristic`);
      return { intent: heuristicIntent(userMessage), usage: null };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      return { intent: heuristicIntent(userMessage), usage: null };
    }

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_e) {
      console.warn('[Mistral] Classifier returned non-JSON, falling back to heuristic. Raw:', content.slice(0, 100));
      return { intent: heuristicIntent(userMessage), usage: null };
    }

    const intent = parsed.intent === 'conversational' ? 'conversational' : 'knowledge_question';

    const usage = data.usage ? {
      promptTokens: data.usage.prompt_tokens || 0,
      completionTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0,
      model: data.model || classifierModel
    } : null;

    return { intent, usage };

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      console.warn('[Mistral] Classifier timed out (5s) - falling back to heuristic');
    } else {
      console.warn('[Mistral] Classifier error:', error.message, '- falling back to heuristic');
    }
    return { intent: heuristicIntent(userMessage), usage: null };
  }
}

/**
 * Build the system prompt for a guide
 * @param {Object} guide - Guide configuration
 * @param {string} journeyContext - Optional context about the journey
 * @param {Array} knowledgeContext - Retrieved knowledge chunks for RAG
 * @param {'conversational'|'knowledge_question'} intent - Classified intent of the user message
 * @returns {{systemPrompt: string, chunkIdMap: Object}} - System prompt and chunk ID mapping
 */
function buildSystemPrompt(guide, journeyContext = '', knowledgeContext = [], intent = 'knowledge_question') {
  const personality = PERSONALITY_PRESETS[guide.personality] || PERSONALITY_PRESETS.friendly;
  const language = guide.language || 'en';
  const languageName = LANGUAGE_NAMES[language] || 'English';
  const isConversational = intent === 'conversational';

  const languageInstruction = language !== 'en'
    ? `\n=== LANGUAGE ===\nIMPORTANT: You MUST respond in ${languageName}. All your responses should be in ${languageName}, not English. This is critical.\n`
    : '';

  const personalityBlock = guide.personality === 'custom'
    ? (guide.customPersonality || personality.traits)
    : personality.traits;

  // ─────────────────────────────────────────────────────────────────────────
  // CONVERSATIONAL MODE
  // The user is just being social (greeting, thanks, smalltalk, etc.).
  // No knowledge retrieval, no citations needed. The critical guardrail here
  // is: DO NOT make factual claims about the company - those belong in
  // knowledge mode where they can be cited and verified.
  // ─────────────────────────────────────────────────────────────────────────
  if (isConversational) {
    const systemPrompt = `You are ${guide.name}, a ${guide.role} in an interactive corporate training and onboarding system called Gryffi.
${languageInstruction}

=== YOUR IDENTITY ===
Name: ${guide.name}
Role: ${guide.role}
${guide.personality !== 'custom' ? `Personality Type: ${personality.name}` : ''}

=== YOUR PERSONALITY ===
${personalityBlock}

=== CURRENT MODE: CASUAL CONVERSATION ===
The user is being social — saying hello, thanking you, making smalltalk, or asking about you personally. This is NOT a factual question about the company.

=== GUIDELINES ===
1. STAY IN CHARACTER: You are ${guide.name}. Never mention you're an AI.
2. BE WARM AND BRIEF: Keep the reply to 1-2 short sentences. Match your personality type.
3. NO FACTUAL CLAIMS: Do NOT mention any specific company information — no policies, procedures, names, dates, numbers, departments, locations, products, or processes. You have no verified sources loaded in this turn.
4. INVITE QUESTIONS: If appropriate, end by inviting the user to ask you something specific.
5. NO EMOJIS or emoticons.
6. NO bracketed disclaimers like [note] or [I don't have...].
${guide.instructions ? `
=== SPECIFIC INSTRUCTIONS (apply only when they fit a casual reply) ===
${guide.instructions}
` : ''}
Remember: this is just smalltalk. Stay friendly, stay short, and don't invent facts about the organisation.`;

    return { systemPrompt, chunkIdMap: {} };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // KNOWLEDGE MODE
  // The user is asking for factual information. Either we have relevant
  // chunks (RAG context) and we ground every answer in them with citations,
  // or we have none and we honestly say we don't know.
  // ─────────────────────────────────────────────────────────────────────────
  const hasKnowledge = knowledgeContext && knowledgeContext.length > 0;

  // Use sequential IDs <<1>>, <<2>> to prevent the model from hallucinating
  // complex UUIDs. The post-processor maps these back to real chunk UUIDs.
  const chunkIdMap = {};
  let knowledgeSection = '';

  if (hasKnowledge) {
    knowledgeContext.forEach((chunk, i) => {
      const seqId = String(i + 1);
      chunkIdMap[seqId] = chunk.chunk_id || `chunk-${i + 1}`;
    });

    // Language-specific natural phrases the model can use to say "I don't know"
    // when a question touches a topic NOT covered by the retrieved excerpts.
    const unknownPhrases = {
      en: ["I don't have specific information about that in my sources", "That's not covered in the documents I have access to", "I don't have that information available"],
      nl: ["Daar heb ik helaas geen specifieke informatie over in mijn bronnen", "Dat staat niet in de documenten waar ik toegang toe heb", "Die informatie heb ik niet beschikbaar"],
      de: ["Dazu habe ich leider keine spezifischen Informationen in meinen Quellen", "Das steht nicht in den Dokumenten, auf die ich Zugriff habe", "Diese Information habe ich nicht verfügbar"],
      fr: ["Je n'ai pas d'informations spécifiques à ce sujet dans mes sources", "Ce n'est pas couvert dans les documents auxquels j'ai accès", "Je n'ai pas cette information disponible"],
      es: ["No tengo información específica sobre eso en mis fuentes", "Eso no está cubierto en los documentos a los que tengo acceso", "No tengo esa información disponible"],
      it: ["Non ho informazioni specifiche su questo nelle mie fonti", "Questo non è trattato nei documenti a cui ho accesso", "Non ho quell'informazione disponibile"],
      pt: ["Não tenho informações específicas sobre isso nas minhas fontes", "Isso não está coberto nos documentos a que tenho acesso", "Não tenho essa informação disponível"],
      da: ["Jeg har ikke specifik information om det i mine kilder", "Det er ikke dækket af de dokumenter, jeg har adgang til", "Den information har jeg ikke tilgængelig"],
      no: ["Jeg har ikke spesifikk informasjon om det i kildene mine", "Det er ikke dekket av dokumentene jeg har tilgang til", "Den informasjonen har jeg ikke tilgjengelig"],
      fi: ["Minulla ei ole tarkkoja tietoja tästä lähteissäni", "Tätä ei käsitellä asiakirjoissa, joihin minulla on pääsy", "Minulla ei ole tuota tietoa saatavilla"],
      sv: ["Jag har ingen specifik information om det i mina källor", "Det täcks inte av dokumenten jag har tillgång till", "Den informationen har jag inte tillgänglig"],
      pl: ["Nie mam konkretnych informacji na ten temat w moich źródłach", "Nie jest to omówione w dokumentach, do których mam dostęp", "Nie mam tej informacji dostępnej"],
      ro: ["Nu am informații specifice despre acest subiect în sursele mele", "Acest lucru nu este acoperit în documentele la care am acces", "Nu am acea informație disponibilă"],
      tr: ["Bu konuda kaynaklarımda belirli bilgilere sahip değilim", "Bu, erişebildiğim belgelerde ele alınmamış", "Bu bilgiye sahip değilim"]
    };
    const phrases = unknownPhrases[language] || unknownPhrases.en;

    knowledgeSection = `
=== YOUR KNOWLEDGE BASE ===
Below are numbered excerpts from verified company documents. These are your ONLY source of truth.
Each excerpt has a unique ID like <<1>>, <<2>>, etc.

${knowledgeContext.map((chunk, i) => {
      const sourceName = chunk.source_name || chunk.original_filename || 'Document';
      return `<<${i + 1}>> (from: ${sourceName})\n${chunk.content}`;
    }).join('\n\n')}

=== STRICT CITATION RULES ===

1. **EVERY FACTUAL SENTENCE MUST CITE A SOURCE**: For every sentence that contains a specific fact, name, number, date, procedure, location, policy, or any company-specific detail, you MUST place a citation like <<1>>, <<2>>, etc. right after the relevant statement. No fact without a citation. Ever.

2. **CITE THE SPECIFIC EXCERPT**: Different facts from different excerpts MUST use different citation numbers. Do NOT use the same citation number for facts from different excerpts.

3. **MATCH FACTS TO THEIR SOURCE**: If excerpt <<1>> talks about infrastructure and excerpt <<3>> talks about security, then infrastructure facts MUST cite <<1>> and security facts MUST cite <<3>>. NEVER cite <<1>> for information that appears in <<3>>.

4. **ONLY USE THE EXCERPTS ABOVE**: You may ONLY state facts that appear in excerpts <<1>> through <<${knowledgeContext.length}>>. Do NOT invent, guess, infer, or extrapolate beyond what is written.

5. **NO FABRICATION - ZERO TOLERANCE**: NEVER make up company names, policies, procedures, dates, times, locations, contact details, schedules, or any other specifics not explicitly in the excerpts. Common knowledge is fine; company-specific knowledge MUST come from an excerpt.

6. **WHEN YOU DON'T KNOW**: If the user's question is NOT covered by the excerpts above:
   - Say so honestly and naturally: "${phrases[0]}" or "${phrases[1]}"
   - Suggest they ask their manager, a colleague, or the relevant department
   - Do NOT guess. Do NOT fill the gap with plausible-sounding content. Do NOT use general world knowledge to fabricate a company-specific answer.

7. **NO INVENTED SOURCES**: NEVER reference an excerpt number higher than <<${knowledgeContext.length}>>. NEVER invent document names or section references.

8. **IF UNSURE, DON'T SAY IT**: If you are not 100% certain a fact is in the excerpts, do not include it.

=== POSITIVE & NEGATIVE EXAMPLES ===

GOOD: "The office opens at 8:30 AM <<2>>."
BAD:  "The office opens at 8:30 AM." (no citation = treated as fabricated and removed)

GOOD: "I don't have specific information about parking policies in my sources. I'd recommend checking with your manager or the facilities team."
BAD:  "Parking is free for employees and visitors park in section B." (when nothing in the excerpts mentions parking)

GOOD: "According to the policy <<1>>, employees get 25 days of leave per year, and special leave can be requested via HR <<3>>."
BAD:  "Employees get 25 days <<1>> and special leave via HR <<1>>." (same citation reused for unrelated facts)
`;
  } else {
    // Knowledge intent but RAG returned nothing. Tell the model explicitly that
    // it has no sources for this turn so it doesn't try to wing it.
    knowledgeSection = `
=== YOUR KNOWLEDGE BASE ===
You currently have NO verified excerpts for this question. This means the topic the user is asking about is NOT in your knowledge base.

=== WHAT TO DO ===
- Tell the user honestly and naturally that you don't have specific information about this topic
- Suggest they ask their manager, a colleague, or the relevant department
- Do NOT guess, invent, or use general world knowledge to fabricate a company-specific answer
- Keep the reply short (1-2 sentences)
`;
  }

  const systemPrompt = `You are ${guide.name}, a ${guide.role} in an interactive corporate training and onboarding system called Gryffi.
${languageInstruction}

=== YOUR IDENTITY ===
Name: ${guide.name}
Role: ${guide.role}
${guide.personality !== 'custom' ? `Personality Type: ${personality.name}` : ''}

=== YOUR PERSONALITY ===
${personalityBlock}
${knowledgeSection}
=== BEHAVIOR GUIDELINES ===
1. STAY IN CHARACTER: You are ${guide.name}, always. Never break character or mention you're an AI.
2. BE HELPFUL: Your primary goal is to help employees with verified information.
3. BE CONCISE: Keep responses to 2-4 sentences unless explaining something complex.
4. BE NATURAL: Respond like a real person would. NEVER use bracketed disclaimers or meta-commentary.
5. REMEMBER CONTEXT: This is an ongoing conversation. Reference what you said earlier naturally.
6. HONESTY OVER HELPFULNESS: NEVER fabricate company information. If something is not in your excerpts, simply say so and suggest asking a colleague or manager. An incorrect answer damages trust far more than admitting you don't know.
7. NO EMOJIS: Do NOT use emojis or emoticons in your responses. Keep communication professional and text-only.
${guide.instructions ? `
=== SPECIFIC INSTRUCTIONS ===
${guide.instructions}
` : ''}
${guide.topics && guide.topics.length > 0 ? `
=== TOPICS YOU CAN HELP WITH ===
${guide.topics.map(t => `- ${t}`).join('\n')}
If asked about topics outside your expertise, politely redirect to the appropriate resource.
` : ''}
${journeyContext ? `
=== CURRENT JOURNEY CONTEXT ===
${journeyContext}
` : ''}
=== RESPONSE STYLE ===
- Respond naturally as ${guide.name} would
- Use the appropriate tone for your personality type
- Be conversational but professional
- NEVER use emojis, emoticons, or special symbols like 😊 🎉 👍
- NEVER use bracketed text like [note], [disclaimer], or [I don't have...] - always speak naturally
- If you don't know something, say so naturally in a conversational way
- Help guide the user to their next steps when appropriate
${hasKnowledge ? `- ONLY use citation format <<1>> through <<${knowledgeContext.length}>>. Match each fact to its correct excerpt number. EVERY factual sentence MUST end with a citation.` : ''}

Remember: You are helping real employees. Be supportive and helpful, but NEVER make up information about the company. Honesty builds trust.`;

  return { systemPrompt, chunkIdMap };
}

/**
 * Chat with an AI Guide using Mistral
 * @param {Object} guide - Guide configuration (name, role, personality, instructions, topics, stepId, guideId, organizationId)
 * @param {string} userMessage - User's message
 * @param {Array} conversationHistory - Previous messages [{role, content}]
 * @param {string} journeyContext - Optional context about the current journey/location
 * @returns {Promise<string>} - Guide's response
 */
// Input bounds for guide chats. All callers pass text that comes from the
// browser, so without limits one request could fill the model context.
const CHAT_MAX_MESSAGE_CHARS = 2000;
const CHAT_MAX_HISTORY_MESSAGES = 20;
const CHAT_MAX_HISTORY_CHARS = 4000;
const CHAT_MAX_CONTEXT_CHARS = 12000;

/**
 * Normalize client-supplied chat history: only user/assistant turns (a client
 * must never be able to add "system" instructions), bounded in size.
 */
function normalizeChatHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-CHAT_MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role, content: String(m.content ?? '').slice(0, CHAT_MAX_HISTORY_CHARS) }));
}

export async function chatWithGuide(guide, userMessage, conversationHistory = [], journeyContext = '') {
  userMessage = String(userMessage ?? '').slice(0, CHAT_MAX_MESSAGE_CHARS);
  conversationHistory = normalizeChatHistory(conversationHistory);
  journeyContext = String(journeyContext ?? '').slice(0, CHAT_MAX_CONTEXT_CHARS);

  if (!(await isAiConfigured())) {
    console.warn('[AI] No AI provider configured - using fallback response');
    return { response: getFallbackResponse(guide, userMessage), usage: null };
  }

  const { chatModel } = await getAiConfig();
  const language = guide.language || 'en';
  const hasKnowledgeBase = !!(guide.stepId || guide.guideId);

  // ─── Step 1: classify intent ────────────────────────────────────────────
  // Skip classification when the guide has no knowledge base linked — without
  // sources there's nothing to ground in anyway, so treat everything as casual.
  // This also avoids spending a classifier call for guides that don't use RAG.
  let intent = 'conversational';
  let classifierUsage = null;
  if (hasKnowledgeBase) {
    const classification = await classifyIntent(userMessage, conversationHistory);
    intent = classification.intent;
    classifierUsage = classification.usage;
  }
  const isKnowledgeMode = intent === 'knowledge_question';

  console.log('[Mistral] === Guide Chat ===');
  console.log('[Mistral] Guide:', guide.name, '| Personality:', guide.personality, '| Language:', language);
  console.log('[Mistral] Intent:', intent, hasKnowledgeBase ? '' : '(no KB linked, defaulted to conversational)');
  console.log('[Mistral] History length:', conversationHistory.length);
  console.log('[Mistral] User message:', userMessage.substring(0, 80));

  // ─── Step 2: retrieve knowledge (only for knowledge questions) ──────────
  // SECURITY: organizationId is passed for defense-in-depth verification.
  let knowledgeContext = [];
  if (isKnowledgeMode && hasKnowledgeBase) {
    try {
      knowledgeContext = await retrieveKnowledge(
        guide.stepId || null,
        userMessage,
        5,
        guide.guideId || null,
        guide.organizationId || null
      );
      console.log(`[Mistral] RAG: ${knowledgeContext.length} relevant chunks above similarity threshold`);
    } catch (error) {
      console.warn('[Mistral] RAG retrieval failed:', error.message);
    }
  }

  // ─── Step 3: early exit ─ knowledge question without any relevant chunks ─
  // Save a Mistral call: nothing in the KB matched, so we KNOW the answer is
  // "I don't have that info". Returning the localized fallback directly is
  // faster, cheaper, and impossible to hallucinate.
  if (isKnowledgeMode && knowledgeContext.length === 0 && hasKnowledgeBase) {
    console.log('[Mistral] No relevant chunks for knowledge question → serving fallback directly');
    return {
      response: getNoKnowledgeFallback(language),
      usage: classifierUsage,
      intent,
      fallback: 'no_relevant_knowledge'
    };
  }

  // ─── Step 4: build mode-aware system prompt ─────────────────────────────
  const { systemPrompt, chunkIdMap } = buildSystemPrompt(guide, journeyContext, knowledgeContext, intent);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.slice(-10),
    { role: 'user', content: userMessage }
  ];

  // ─── Step 5: pick generation parameters based on mode ───────────────────
  // Knowledge mode: low temperature + tight top_p ⇒ more deterministic,
  // less creative writing, less risk of fabrication.
  // Conversational mode: normal temperature ⇒ warm, natural smalltalk.
  const temperature = isKnowledgeMode ? 0.1 : 0.7;
  const topP = isKnowledgeMode ? 0.7 : 0.9;

  const MAX_RETRIES = 2;
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        const delay = 1000 * attempt;
        console.log(`[Mistral] Retry ${attempt}/${MAX_RETRIES} after ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await aiFetch('/chat/completions', {
        body: JSON.stringify({
          model: chatModel,
          messages: messages,
          temperature,
          max_tokens: 500,
          top_p: topP
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Mistral] API error (attempt ${attempt + 1}):`, response.status, errorText);
        lastError = { status: response.status, text: errorText };
        if (response.status === 502 || response.status === 503 || response.status === 429) {
          continue;
        }
        return {
          response: getFallbackResponse(guide, userMessage),
          usage: classifierUsage,
          intent,
          error: `API error: ${response.status}`
        };
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        console.error('[Mistral] Empty response from API');
        return {
          response: getFallbackResponse(guide, userMessage),
          usage: classifierUsage,
          intent
        };
      }

      let cleanedContent = cleanResponse(content);

      // ─── Step 6: post-process citations ────────────────────────────────
      // Replaces <<N>> with real UUIDs, strips hallucinated ones, corrects
      // lazy citing (same source used for everything).
      if (knowledgeContext.length > 0 && Object.keys(chunkIdMap).length > 0) {
        cleanedContent = verifyAndCleanCitations(cleanedContent, chunkIdMap, knowledgeContext);
      }

      // ─── Step 7: citation-presence validation ──────────────────────────
      // If this was a knowledge question and we had chunks available but the
      // model produced an answer with ZERO valid citations, it means the
      // answer is ungrounded. Replace the entire reply with the localized
      // fallback so the user is not exposed to potentially fabricated facts.
      //
      // We only enforce this when chunks were actually provided to the model
      // — if the model honestly said "I don't have that info" in a no-chunks
      // turn, that's already handled by the early-exit in step 3.
      //
      // We use parseCitations() so this stays consistent with the rest of the
      // codebase — it accepts full UUIDs, 8-char partial UUIDs, and the
      // legacy "chunk-N" format.
      let fallbackReason = null;
      if (isKnowledgeMode && knowledgeContext.length > 0) {
        const citationsFound = parseCitations(cleanedContent);
        if (citationsFound.length === 0) {
          console.warn('[Mistral] Knowledge question answered without ANY citation → replacing with fallback');
          console.warn('[Mistral] Dropped response was:', cleanedContent.substring(0, 200));
          cleanedContent = getNoKnowledgeFallback(language);
          fallbackReason = 'no_citation_in_response';
        }
      }

      console.log(`[Mistral] Response (${cleanedContent.length} chars):`, cleanedContent.substring(0, 120));
      console.log('[Mistral] Token usage:', JSON.stringify(data.usage), classifierUsage ? `+ classifier ${classifierUsage.totalTokens}t` : '');

      const mainUsage = {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
        model: data.model || chatModel
      };

      const result = {
        response: cleanedContent,
        usage: mergeUsage(classifierUsage, mainUsage),
        intent
      };
      if (fallbackReason) result.fallback = fallbackReason;
      return result;

    } catch (error) {
      console.error(`[Mistral] Chat error (attempt ${attempt + 1}):`, error.message);
      lastError = error;
      if (error.name === 'AbortError') {
        continue;
      }
      if (attempt < MAX_RETRIES) continue;
    }
  }

  console.error(`[Mistral] All ${MAX_RETRIES + 1} attempts failed for guide ${guide.name}`);
  return {
    response: getFallbackResponse(guide, userMessage),
    usage: classifierUsage,
    intent,
    error: lastError?.status ? `API error: ${lastError.status}` : 'Service temporarily unavailable'
  };
}

/**
 * Generate an opening greeting from the AI Guide
 * This makes the AI "own" its opening message, so it remembers what it said
 * @param {Object} guide - Guide configuration
 * @param {string} journeyContext - Optional context about the journey
 * @returns {Promise<string>} - AI-generated opening greeting
 */
export async function generateGuideOpening(guide, journeyContext = '') {
  journeyContext = String(journeyContext ?? '').slice(0, CHAT_MAX_CONTEXT_CHARS);
  
  if (!(await isAiConfigured())) {
    console.warn('[AI] No AI provider configured - using static greeting');
    // Return the configured greeting or a default
    return {
      response: guide.greeting || `Hello! I'm ${guide.name}, ${guide.role}. How can I help you today?`,
      usage: null
    };
  }

  const { chatModel, fallbackModel } = await getAiConfig();
  
  const personality = PERSONALITY_PRESETS[guide.personality] || PERSONALITY_PRESETS.friendly;
  const language = guide.language || 'en';
  const languageName = LANGUAGE_NAMES[language] || 'English';
  
  // Language instruction for non-English guides
  const languageInstruction = language !== 'en'
    ? `\n=== LANGUAGE ===\nIMPORTANT: Generate the greeting in ${languageName}. The entire greeting MUST be in ${languageName}.\n`
    : '';
  
  // Build a special prompt for generating the opening
  const openingPrompt = `You are ${guide.name}, a ${guide.role} in an interactive corporate training system.
${languageInstruction}
=== YOUR PERSONALITY ===
${guide.personality === 'custom' ? guide.customPersonality || personality.traits : personality.traits}

=== YOUR TASK ===
Generate a natural, warm opening greeting to start a conversation with a new employee or visitor.
${guide.greeting ? `Use this as inspiration (but make it natural and in your own words): "${guide.greeting}"` : ''}
${guide.instructions ? `Context: ${guide.instructions}` : ''}
${journeyContext ? `Current situation: ${journeyContext}` : ''}

=== GUIDELINES ===
- Introduce yourself briefly (name and role)
- Be welcoming and set a friendly tone
- Keep it to 2-3 sentences maximum
- Match your personality type: ${personality.name}
- Don't ask too many questions at once
- Make the person feel comfortable
${language !== 'en' ? `- RESPOND IN ${languageName.toUpperCase()} ONLY` : ''}

Generate ONLY the greeting, nothing else.`;

  // Helper function to make opening request with timeout
  const makeOpeningRequest = async (model, timeoutMs) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
      const response = await aiFetch('/chat/completions', {
        body: JSON.stringify({
          model: model,
          messages: [
            { role: 'system', content: openingPrompt },
            { role: 'user', content: 'Please introduce yourself and start the conversation.' }
          ],
          temperature: 0.8,
          max_tokens: 150,
          top_p: 0.9
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      if (!response.ok) {
        return { success: false };
      }
      
      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      
      if (!content) {
        return { success: false };
      }
      
      return { success: true, content, data };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return { success: false, timedOut: true };
      }
      return { success: false };
    }
  };
  
  try {
    const startTime = Date.now();
    console.log(`[Mistral] Generating opening for: ${guide.name} (using ${chatModel})`);
    
    // Try primary model with 15 second timeout
    const primaryResult = await makeOpeningRequest(chatModel, 15000);
    const primaryDuration = Date.now() - startTime;
    
    if (primaryResult.success) {
      const cleanedContent = cleanResponse(primaryResult.content);
      console.log(`[Mistral] ✓ Generated opening in ${primaryDuration}ms:`, cleanedContent.substring(0, 100) + '...');
      console.log('[Mistral] Token usage:', JSON.stringify(primaryResult.data.usage));
      
      return {
        response: cleanedContent,
        usage: {
          promptTokens: primaryResult.data.usage?.prompt_tokens || 0,
          completionTokens: primaryResult.data.usage?.completion_tokens || 0,
          totalTokens: primaryResult.data.usage?.total_tokens || 0,
          model: primaryResult.data.model || chatModel
        }
      };
    }
    
    // If primary timed out, try fallback model
    if (primaryResult.timedOut && fallbackModel !== chatModel) {
      console.warn(`[Mistral] ⏱ Primary model TIMED OUT after ${primaryDuration}ms`);
      console.log(`[Mistral] → Switching to fallback model: ${fallbackModel}`);
      
      const fallbackStart = Date.now();
      const fallbackResult = await makeOpeningRequest(fallbackModel, 15000);
      const fallbackDuration = Date.now() - fallbackStart;
      
      if (fallbackResult.success) {
        const cleanedContent = cleanResponse(fallbackResult.content);
        console.log(`[Mistral] ✓ Fallback generated opening in ${fallbackDuration}ms (total: ${Date.now() - startTime}ms):`, cleanedContent.substring(0, 100) + '...');
        console.log('[Mistral] Token usage:', JSON.stringify(fallbackResult.data.usage));
        
        return {
          response: cleanedContent,
          usage: {
            promptTokens: fallbackResult.data.usage?.prompt_tokens || 0,
            completionTokens: fallbackResult.data.usage?.completion_tokens || 0,
            totalTokens: fallbackResult.data.usage?.total_tokens || 0,
            model: fallbackResult.data.model || fallbackModel
          }
        };
      }
      
      if (fallbackResult.timedOut) {
        console.error(`[Mistral] ✗ Fallback model ALSO TIMED OUT after ${fallbackDuration}ms`);
      }
    } else if (primaryResult.timedOut) {
      console.warn(`[Mistral] ⏱ Opening generation TIMED OUT after ${primaryDuration}ms (no different fallback configured)`);
    } else {
      console.error(`[Mistral] Opening generation failed after ${primaryDuration}ms`);
    }
    
    // Return static greeting as fallback
    console.log('[Mistral] Using static greeting as fallback');
    return {
      response: guide.greeting || `Hello! I'm ${guide.name}, ${guide.role}. How can I help you today?`,
      usage: null
    };
    
  } catch (error) {
    console.error('[Mistral] Opening generation error:', error.message);
    return {
      response: guide.greeting || `Hello! I'm ${guide.name}, ${guide.role}. How can I help you today?`,
      usage: null
    };
  }
}

/**
 * Fallback response when AI is unavailable
 * Uses personality to generate appropriate response
 * @param {Object} guide - Guide configuration
 * @param {string} userMessage - User's message
 */
function getFallbackResponse(guide, userMessage) {
  const _personality = PERSONALITY_PRESETS[guide.personality] || PERSONALITY_PRESETS.friendly;
  const lowerMessage = userMessage.toLowerCase();
  
  // Greeting detection - respond naturally (we've already introduced ourselves in the opening)
  if (lowerMessage.match(/^(hi|hello|hey|good morning|good afternoon|howdy)/)) {
    const responses = {
      friendly: `Hey! Good to hear from you. So, what can I help you with?`,
      professional: `Good to hear from you. How may I assist you today?`,
      mentor: `Great! What would you like to learn about today?`,
      energetic: `Awesome! So what brings you here? How can I help?`,
      calm: `I'm here for you. What would you like to know?`,
      technical: `Ready to help. What do you need assistance with?`,
      custom: `How can I help you today?`
    };
    return responses[guide.personality] || responses.friendly;
  }
  
  // Help request
  if (lowerMessage.includes('help')) {
    return `Of course! I'm ${guide.name}, and I'm here to assist you. What would you like help with?`;
  }
  
  // Thanks
  if (lowerMessage.includes('thank')) {
    const thanks = {
      friendly: "You're so welcome! Let me know if you need anything else!",
      professional: "You're welcome. Please don't hesitate to ask if you have further questions.",
      mentor: "You're very welcome! Remember, there are no silly questions. Come back anytime!",
      energetic: "You got it! You're doing great - keep it up!",
      calm: "Of course. I'm always here if you need me.",
      technical: "You're welcome. Feel free to return if you have more questions.",
      custom: "You're welcome! Let me know if there's anything else."
    };
    return thanks[guide.personality] || thanks.friendly;
  }
  
  // Location/where questions
  if (lowerMessage.includes('where')) {
    return `Great question! Let me help you find your way. What specifically are you looking for?`;
  }
  
  // How questions
  if (lowerMessage.includes('how')) {
    return `I'd be happy to explain that! Could you tell me a bit more about what you're trying to do?`;
  }
  
  // Goodbye
  if (lowerMessage.match(/(bye|goodbye|see you|talk later)/)) {
    const goodbyes = {
      friendly: "Bye! It was great chatting with you. Come back anytime!",
      professional: "Goodbye. Have a productive day.",
      mentor: "Take care! Remember what we discussed, and don't hesitate to come back if you have questions.",
      energetic: "See you later! You've got this - go crush it!",
      calm: "Goodbye. Wishing you a peaceful rest of your day.",
      technical: "Goodbye. Feel free to return if you encounter any issues.",
      custom: "Goodbye! Take care."
    };
    return goodbyes[guide.personality] || goodbyes.friendly;
  }
  
  // Default contextual response
  const defaults = {
    friendly: `That's a great question! As ${guide.name}, I'm here to help. Could you tell me a bit more about what you need?`,
    professional: `Thank you for your inquiry. I'd be happy to assist. Could you provide more details?`,
    mentor: `Good question! Let me help you understand this better. What aspect would you like to explore first?`,
    energetic: `Ooh, good one! Let's figure this out together. What specifically can I help you with?`,
    calm: `I understand. Let's take this one step at a time. What would you like to know?`,
    technical: `I can help with that. To give you the most accurate information, could you be more specific?`,
    custom: `I'm here to help! What would you like to know?`
  };
  
  return defaults[guide.personality] || defaults.friendly;
}

/**
 * Get all personality presets for UI dropdown
 */
export function getPersonalityPresets() {
  return Object.entries(PERSONALITY_PRESETS).map(([key, value]) => ({
    id: key,
    name: value.name,
    description: value.description,
    example: value.example
  }));
}

export default { chatWithGuide, getPersonalityPresets, PERSONALITY_PRESETS };
