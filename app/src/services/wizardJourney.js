/**
 * Wizard Journey service
 *
 * Orchestrates AI-driven journey generation based on answers collected by
 * the Journey Wizard UI. Produces a normalised plan (steps + paths) that is
 * then materialised in the database by the /api/wizard/generate route.
 *
 * Uses the configured AI provider and chat model (services/aiProvider.js).
 */

import { aiFetch, getAiConfig, isAiConfigured } from './aiProvider.js';


// Wizard generation can take a while: mistral-large-latest produces up to a
// 4000-token JSON plan with up to 12 steps, which routinely takes 30-90s.
// 45s was too tight and caused "operation aborted due to timeout" errors when
// makers picked a long journey. We allow up to 3 minutes by default and let
// ops override via env without redeploying.
const WIZARD_MISTRAL_TIMEOUT_MS = Number(process.env.WIZARD_MISTRAL_TIMEOUT_MS) || 180000;

// Placeholder media for wizard-generated journeys. The AI doesn't have access
// to the maker's media library, so when the maker ticks "Video" or "Image"
// on the components page we drop in safe, license-friendly placeholders that
// they can swap out in the builder. Both are overridable via .env so ops can
// switch to a brand-themed asset without a code change.
//   - Video:  a generic Gryffi welcome clip on YouTube.
//   - Image:  a free-to-use "Coming Soon" photo by Vie Studio on Pexels.
const PLACEHOLDER_VIDEO_URL = process.env.WIZARD_PLACEHOLDER_VIDEO_URL ||
  'https://www.youtube.com/watch?v=MLpWrANjFbI';
const PLACEHOLDER_IMAGE_URL = process.env.WIZARD_PLACEHOLDER_IMAGE_URL ||
  'https://images.pexels.com/photos/4439444/pexels-photo-4439444.jpeg';

/**
 * Length is intentionally a "feel" rather than a fixed step count: the maker
 * picks a position on the slider, and the AI decides the actual number of
 * steps based on the source material. We pass a soft min/max range to Mistral
 * and let it choose within that band so a rich document can produce a longer
 * journey while a thin source stays compact.
 *
 * Backwards compatibility: the original 3-option wizard sent 'short' / 'medium'
 * / 'long', so those values remain valid here.
 */
const LENGTH_RANGES = {
  'very-short': { min: 3, max: 4 },
  short:        { min: 4, max: 5 },
  medium:       { min: 5, max: 7 },
  long:         { min: 7, max: 9 },
  'very-long':  { min: 9, max: 12 }
};

const DEFAULT_LENGTH_RANGE = LENGTH_RANGES.medium;

/**
 * Compute the soft step-count band passed to the AI.
 * Generous source material is allowed to stretch the band by one extra step on
 * the upper side so the AI can match the richness of the input. Thin material
 * keeps the band as-is so we don't pad with filler.
 */
function getStepRange(lengthHint, documentText) {
  const base = LENGTH_RANGES[lengthHint] || DEFAULT_LENGTH_RANGE;
  const { min } = base;
  let { max } = base;
  const docChars = typeof documentText === 'string' ? documentText.length : 0;
  // ~12k chars roughly corresponds to a long document (the upload cap is 50MB
  // / 60 pages, and we slice to 12k for the prompt anyway). Allow one extra
  // step of headroom when the source is meaty.
  if (docChars >= 6000) max = Math.min(max + 1, 14);
  return { min, max };
}

const LANGUAGE_NAMES = {
  en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish',
  it: 'Italian', pt: 'Portuguese', da: 'Danish', no: 'Norwegian',
  fi: 'Finnish', sv: 'Swedish', pl: 'Polish', ro: 'Romanian', tr: 'Turkish'
};

const JOURNEY_TERM = {
  en: 'journey', nl: 'expeditie', de: 'Expedition', fr: 'parcours', es: 'expedición',
  it: 'percorso', pt: 'percurso', da: 'rejse', no: 'reise', fi: 'matka',
  sv: 'resa', pl: 'podróż', ro: 'parcurs', tr: 'yolculuk'
};

const PURPOSE_HINTS = {
  onboarding: 'Welcoming new employees. Warm, practical tone, first-week focus.',
  compliance: 'Safety/compliance training. Precise, confident tone. Must include a knowledge check.',
  product:    'Product or procedure training. Step-by-step, clear visuals, concrete examples.',
  tour:       'Tour or location intro. Spatial storytelling, describe rooms/areas. Prefer Space steps.',
  knowledge:  'Internal knowledge sharing. Informative, neutral tone. Light on challenges.',
  guest:      'Welcoming guests or visitors at a hospitality venue (hotel, campsite, holiday park, B&B, conference venue, attraction, event). Friendly, hospitable, second-person tone. Address the guest directly ("you"), not an employee. Focus on practical on-site information: arrival, check-in, facilities, rules, Wi-Fi, opening hours, nearby tips, contact for help. Keep challenges light or skip them; prefer Content and Space steps. A short feedback Poll near the end is welcome.'
};

/**
 * Build the AI plan for a journey.
 *
 * @param {Object} opts
 * @param {string} [opts.documentText]  Plain text extracted from an uploaded document
 * @param {string} [opts.topic]         Free-text description (when no document)
 * @param {string} opts.purpose         onboarding | compliance | product | tour | knowledge | guest
 * @param {string} [opts.audience]      Free-text audience description
 * @param {string} opts.guide           none | existing | newWithKb | newNoKb
 * @param {string} opts.length          short | medium | long
 * @param {string} opts.branching       yes | no
 * @param {string} opts.reward          none | voucher | certificate | thankyou | later
 * @param {string} [opts.rewardDetails] Free-text extra info for voucher/certificate/thankyou
 * @param {string} opts.language        Target content language (ISO 639-1)
 * @param {string} opts.title           Journey title entered by the user
 * @returns {Promise<{ title: string, steps: Array, paths: Array, suggested_guide: Object|null }>}
 */
export async function buildJourneyPlan(opts) {
  if (!(await isAiConfigured())) {
    throw new Error('No AI provider is configured');
  }
  const { chatModel } = await getAiConfig();

  const { min: minSteps, max: maxSteps } = getStepRange(opts.length, opts.documentText);
  const lang = opts.language || 'en';
  const langName = LANGUAGE_NAMES[lang] || 'English';
  const journeyTerm = JOURNEY_TERM[lang] || 'journey';
  const purposeHint = PURPOSE_HINTS[opts.purpose] || '';

  const wantsBranching = opts.branching === 'yes';
  // Branching complexity slider stop. Defaults to "routes" (the middle stop)
  // when the maker enabled branching but the field is missing — keeps legacy
  // payloads working without surprising the maker.
  const branchingLevel = wantsBranching
    ? (BRANCHING_PROFILES[opts.branchingComplexity] ? opts.branchingComplexity : DEFAULT_BRANCHING_LEVEL)
    : null;
  const branchingProfile = wantsBranching ? getBranchingProfile(branchingLevel) : null;
  const wantsGuide = opts.guide === 'existing' || opts.guide === 'newWithKb' || opts.guide === 'newNoKb';
  const wantsReward = opts.reward && opts.reward !== 'none';
  const chosenGuideName = (opts.guideName || '').trim();

  // Component checkboxes from the wizard's "What goes in your journey?" page.
  // Content steps are always allowed (they're the structural backbone), so
  // they're not on the checkbox list. Each flag toggles between "include at
  // least one" and "do NOT include any" in the prompt — which is much firmer
  // than relying on Mistral to guess the maker's preference.
  const components = opts.components || {};
  const wantsQuiz  = components.quiz  === true;
  const wantsPoll  = components.poll  === true;
  const wantsForm  = components.form  === true;
  const wantsSpace = components.space === true;
  // Media flags. Video means "include at least one content step that embeds a
  // YouTube video"; Image means "include at least one content step with an
  // image, and put a placeholder image on space steps too". Mistral can't pick
  // real media for the maker, so we mark these slots and the maker swaps them.
  const wantsVideo = components.video === true;
  const wantsImage = components.image === true;

  const sourceBlock = opts.documentText
    ? `SOURCE DOCUMENT (primary content basis, extract real knowledge from it):\n${opts.documentText.slice(0, 12000)}`
    : `TOPIC DESCRIPTION (user wrote this, use it as the topic):\n${(opts.topic || '').slice(0, 4000)}`;

  const audienceBlock = opts.audience
    ? `TARGET AUDIENCE: ${opts.audience}`
    : 'TARGET AUDIENCE: (not specified, write for a general professional audience)';

  const rewardInstruction = buildRewardInstruction(opts);

  const systemPrompt = `You are a journey designer for Gryffi, a B2B employee onboarding and training platform.
Your task is to design an interactive ${journeyTerm} based on the input supplied by the user.

LENGTH:
- The maker indicated their preferred length on a 5-point slider; this maps to a step-count range of ${minSteps}-${maxSteps} steps.
- YOU choose the exact number of steps within that range. Pick the lower end when the source material is thin or the topic is simple, and the upper end when the material is rich, complex, or covers many sub-topics.
- Do not pad with filler steps just to reach the upper end. Quality over quantity.

LANGUAGE: Write ALL content in ${langName}. Never translate the word "${journeyTerm}" into other words.

PURPOSE: ${opts.purpose}. ${purposeHint}

STYLE RULES:
- Warm, clear, non-technical wording. No jargon.
- Use short sentences. Avoid emojis entirely.
- Do not invent facts that are not supported by the source material.
- Do not use quotes around identifiers in option text.

STEP TYPES YOU MAY USE:
- "content": a step with a title and body (HTML allowed: <p>, <strong>, <em>, <ul>, <li>).
  Content steps can be text-only, video, or image. Use "media_type" to indicate which.
  For "video" or "image" content steps, write a short body that introduces the media —
  do not describe the placeholder; the maker will swap it for their own asset.
- "challenge": a multiple-choice knowledge check. Provide a "questions" array with 1 to 3 questions; each question has 3-4 options, exactly one correct. Aim for 2-3 questions when the source material supports it (multiple distinct concepts to test); fall back to 1 question when there's only one key idea to check.
- "guide": a chat step powered by an AI Guide. Provide guide_role, suggested_topic, suggested_greeting.
${wantsGuide ? (chosenGuideName
  ? `  The AI Guide's name is "${chosenGuideName}" (chosen by the maker). If you mention a name in the greeting, you MUST use exactly this name. Do not invent any other name.`
  : '  Write a short, warm greeting WITHOUT introducing the guide by a personal name (the maker has not chosen one yet).') : ''}
- "form": a short form collecting info from the user (provide 1-3 fields, each with label + type: text|textarea|email).
- "poll": a single-question survey with 2-4 options.
- "space": a location/place step that describes a physical space (room, area, venue). Provide a short space_description.
- "reward": a closing reward step. Provide a title and description only.

COMPONENT INCLUSION (the maker explicitly picked these on the "What goes in your journey?" page — follow EXACTLY):
- "content" steps: ALWAYS allowed and are the backbone of the journey.
${wantsQuiz  ? '- Quiz: INCLUDE at least one "challenge" step somewhere in the middle.'  : '- Quiz: DO NOT include any "challenge" step.'}
${wantsPoll  ? '- Poll: INCLUDE exactly one "poll" step (a short, friendly opinion check).' : '- Poll: DO NOT include any "poll" step.'}
${wantsForm  ? '- Form: INCLUDE exactly one "form" step (1-3 fields, label + type).'        : '- Form: DO NOT include any "form" step.'}
${wantsSpace ? '- Location: INCLUDE one or more "space" steps where it fits the topic (introducing a room, venue, or area).' : '- Location: DO NOT include any "space" step.'}
${wantsVideo ? '- Video: INCLUDE EXACTLY ONE "content" step with "media_type":"video" (no video_url — the maker will pick the actual video).' : '- Video: DO NOT mark any content step as "video" (use "text" instead).'}
${wantsImage ? '- Image: INCLUDE AT LEAST ONE "content" step with "media_type":"image" (no image_url — the maker will pick the actual image). Space steps will also get a placeholder image automatically.' : '- Image: DO NOT mark any content step as "image" (use "text" instead).'}
${wantsGuide ? '- AI Guide: INCLUDE EXACTLY ONE "guide" step, ideally around the middle or near the end.' : '- AI Guide: DO NOT include any "guide" step.'}
${rewardInstruction}

RULES:
- Produce between ${minSteps} and ${maxSteps} steps in the "steps" array (inclusive). Choose the count that best fits the source material.
- Step 1 must be a "content" step that introduces the ${journeyTerm}.
- The LAST step must feel like a closing step.
${wantsBranching ? buildBranchingInstruction(branchingLevel, maxSteps) : '- The journey is linear: each step leads to the next, no branches.'}

TITLE + DESCRIPTION:
- The maker did NOT provide a name for this ${journeyTerm}. You MUST invent one.
- Write a short, concrete title (max 8 words) in ${langName} that reflects the actual content. Do not use the word "${journeyTerm}" in the title.
- Write a one-sentence description (max 25 words) in ${langName} that describes what the user will learn or do.
- Do not use quotes around the title or description.

OUTPUT FORMAT (strict JSON, no prose, no code fences):
{
  "title": "short, concrete title in ${langName} (max 8 words)",
  "description": "one-sentence summary in ${langName}",
  "steps": [
    {
      "id": 1,
      "type": "content|challenge|guide|form|poll|space|reward",
      "title": "step title",
      // content:
      "body": "<p>HTML body</p>",
      "media_type": "text|video|image",  // optional, only for content steps
      // space:
      "space_description": "short description of the room/venue",
      // challenge:
      "questions": [
        {
          "question": "question text",
          "options": [{ "text": "...", "is_correct": true }, ...]
        }
      ],
      "feedback_correct": "short positive feedback (shown when user passes the whole quiz)",
      "feedback_incorrect": "short helpful feedback (shown when user does not pass)",
      // guide:
      "guide_role": "professional job title",
      "suggested_topic": "what the guide covers",
      "suggested_greeting": "first message from the guide",
      // form:
      "form_intro": "one sentence",
      "form_fields": [{ "label": "Your name", "type": "text", "required": true }],
      // poll:
      "poll_question": "...",
      "poll_options": ["Yes", "No"],
      // reward:
      "reward_title": "...",
      "reward_description": "...",
      // branching (only relevant for adventure/open complexity):
      "is_end_route": false  // optional; set to true when this step closes a branch route
    }
  ],
  "paths": [
    { "from": 1, "to": 2, "label": "Continue" }
    // for branching, a single "from" step may have 2 outgoing paths,
    // where each "label" is the user's answer to a question embedded in the step.
  ],
  ${wantsGuide
    ? (chosenGuideName
        ? `"suggested_guide": { "name": "${chosenGuideName}", "role": "role", "greeting": "short opening (use exactly the name \\"${chosenGuideName}\\" if you mention a name)", "topics": ["..."] }`
        : '"suggested_guide": { "name": "", "role": "role", "greeting": "short opening WITHOUT a personal name", "topics": ["..."] }')
    : '"suggested_guide": null'}
}

IMPORTANT:
- Respond with ONE JSON object only.
- Every step referenced in "paths" must exist in "steps" by its "id".
- Make sure the graph is connected from step 1 forward. No orphan steps.
`;

  const userPrompt = `${sourceBlock}

${audienceBlock}

Now design the ${journeyTerm}. Remember: invent a short fitting title and a one-sentence description in ${langName}. Respond with valid JSON only.`;

  let response;
  try {
    response = await aiFetch('/chat/completions', {
      body: JSON.stringify({
        model: chatModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.65,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      }),
      signal: AbortSignal.timeout(WIZARD_MISTRAL_TIMEOUT_MS)
    });
  } catch (err) {
    // AbortSignal.timeout() rejects with a DOMException whose name is
    // "TimeoutError". Re-throw as a tagged error so the route handler can
    // map it to a user-friendly i18n key instead of leaking the raw
    // "operation was aborted due to timeout" string.
    if (err && (err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
      const wrapped = new Error(`Mistral request did not complete within ${Math.round(WIZARD_MISTRAL_TIMEOUT_MS / 1000)}s`);
      wrapped.code = 'mistral_timeout';
      throw wrapped;
    }
    throw err;
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const e = new Error(`Mistral API error ${response.status}: ${errBody.slice(0, 200)}`);
    if (response.status === 429) e.code = 'mistral_rate_limit';
    else if (response.status >= 500) e.code = 'mistral_unavailable';
    throw e;
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from Mistral');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Mistral did not return valid JSON');
  }

  return normalisePlan(parsed, {
    minSteps, maxSteps,
    wantsGuide, wantsBranching, wantsReward,
    branchingLevel, branchingProfile,
    wantsQuiz, wantsPoll, wantsForm, wantsSpace,
    wantsVideo, wantsImage,
    placeholderVideoUrl: PLACEHOLDER_VIDEO_URL,
    placeholderImageUrl: PLACEHOLDER_IMAGE_URL,
    opts
  });
}

function buildRewardInstruction(opts) {
  if (!opts.reward || opts.reward === 'none') {
    return '- Do NOT include any "reward" step.';
  }
  if (opts.reward === 'later') {
    return '- Include a closing "reward" step with a neutral placeholder title and description; the maker will fill it in later.';
  }
  const kind = {
    voucher:     'a voucher or discount code',
    certificate: 'a completion certificate',
    thankyou:    'a warm thank-you message'
  }[opts.reward];
  const details = opts.rewardDetails ? ` Extra context from the maker: "${opts.rewardDetails}".` : '';
  return `- Include a closing "reward" step that represents ${kind}.${details} Do not invent codes or dates; keep the description short and friendly.`;
}

// Five named branching profiles that the maker picks via the wizard slider.
// Each profile shapes the prompt instruction Mistral receives, so the actual
// graph structure tracks the maker's intent. Keep these keys in sync with the
// BRANCHING_STOPS array in journey-wizard.js.
const BRANCHING_PROFILES = {
  // Smallest accent: one split, paths merge straight back. Great for "are you
  // a manager or an employee?" style flavour without extending the journey.
  subtle:    { multiEnd: false },
  // One split with one or two unique steps per path before merging.
  variation: { multiEnd: false },
  // One split with several unique steps per path. Routes feel genuinely
  // different but eventually merge again at a shared closing step.
  routes:    { multiEnd: false },
  // Two splits along the journey, routes stay separate for several steps and
  // can merge at different points. Some end steps may be route-specific.
  adventure: { multiEnd: true },
  // Multiple splits, the most "choose your own adventure" shape. Routes do
  // not have to merge; multiple distinct ending steps are allowed.
  open:      { multiEnd: true }
};

const DEFAULT_BRANCHING_LEVEL = 'routes';

function getBranchingProfile(level) {
  return BRANCHING_PROFILES[level] || BRANCHING_PROFILES[DEFAULT_BRANCHING_LEVEL];
}

function buildBranchingInstruction(level, maxSteps) {
  const lvl = BRANCHING_PROFILES[level] ? level : DEFAULT_BRANCHING_LEVEL;
  // The instruction is intentionally specific per level — Mistral struggles
  // with vague guidance ("make it more branched") but follows concrete
  // step-count and merge-strategy rules well. Each path label rule is shared
  // because that's a hard player-UX requirement regardless of complexity.
  const sharedFooter = [
    '- Each branching step must be a "content" step whose body asks a short, clear question.',
    '- Each outgoing path MUST have a meaningful "label" that is the literal answer the user picks (no "Option A"/"Option B" — use the actual answer text).',
    '- Pick path labels that mirror the user\'s perspective ("I prefer X", "Show me Y", "Beginner", "Manager"…).',
    `- Stay within the agreed total step range (no more than ${maxSteps} steps in total, including all routes).`
  ].join('\n');

  switch (lvl) {
    case 'subtle':
      return `- Include EXACTLY ONE branching moment in the journey.
- The branching step has TWO outgoing paths, each leading to a SINGLE different next step.
- After those two unique steps, both paths merge back to the SAME shared next step.
- This is a "subtle" branching: the two unique steps reflect the chosen answer (different example, different tone) but the rest of the journey is shared.
${sharedFooter}`;

    case 'variation':
      return `- Include EXACTLY ONE branching moment around the middle of the journey.
- The branching step has TWO outgoing paths.
- Each path has 1 to 2 UNIQUE steps that genuinely differ in content (different examples, different focus).
- After those unique steps, both paths MERGE BACK to a shared next step that wraps up the journey.
${sharedFooter}`;

    case 'routes':
      return `- Include EXACTLY ONE branching moment in the journey.
- The branching step has TWO outgoing paths (you may use THREE if the source material clearly supports a third meaningful answer).
- Each path has 2 to 3 UNIQUE steps with genuinely different content suited to the answer.
- All paths MERGE BACK to a shared closing step (or the last step before the reward).
- Make the routes feel substantively different — different angles, different content, different examples.
${sharedFooter}`;

    case 'adventure':
      return `- Include TWO branching moments at different points in the journey.
- Each branching step has 2 outgoing paths (or 3 where it fits).
- Each path has 2 to 3 UNIQUE steps before merging or reaching another branch.
- Routes may stay separate for several steps; some routes may merge while others continue independently.
- Some routes may have their OWN closing step instead of merging back to a single shared end.
- Mark every step that ends a route as "is_end_route": true (set is_end_route on the step's record). This signals to the maker that this step is where that branch finishes.
${sharedFooter}`;

    case 'open':
      return `- Include TWO or THREE branching moments distributed through the journey.
- Each branching step has 2 to 3 outgoing paths.
- Routes are designed to remain LARGELY SEPARATE: each route can end at its OWN closing step.
- The journey may have MULTIPLE different ending steps — one per route. The maker is fine with this; do not force everything to merge.
- Make sure every route eventually reaches a satisfying closing step (a meaningful conclusion or, if "reward" is enabled, the reward).
- Mark every closing step as "is_end_route": true so the maker knows it ends a route.
${sharedFooter}`;

    default:
      return buildBranchingInstruction(DEFAULT_BRANCHING_LEVEL, maxSteps);
  }
}

/**
 * Validate and sanitise the Mistral output into our internal plan shape:
 * { title, description, steps: [{ id, type, basic_props, advanced_props, is_start, is_end }], paths: [{ from, to, label }], suggested_guide }
 */
function normalisePlan(raw, ctx) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid plan object');
  const stepsIn = Array.isArray(raw.steps) ? raw.steps : [];
  if (stepsIn.length < 2) throw new Error('Plan must have at least 2 steps');

  const title = sanitize(raw.title || ctx.opts.title || 'Untitled', 200);
  const description = sanitize(raw.description || ctx.opts.description || '', 500);

  const allowed = new Set(['content', 'challenge', 'guide', 'form', 'poll', 'space', 'reward']);
  const steps = stepsIn.map((s, i) => {
    const type = allowed.has(s.type) ? s.type : 'content';
    const base = {
      id: Number(s.id) || (i + 1),
      type,
      title: sanitize(s.title || `Step ${i + 1}`, 200),
      is_start: i === 0,
      is_end: i === stepsIn.length - 1
    };
    base.basic_props = basicPropsFor(type, s, ctx);
    base.advanced_props = advancedPropsFor(type, s);
    return base;
  });

  // Belt-and-braces: Mistral usually respects the COMPONENT INCLUSION rules,
  // but if it slips up and adds a step type the maker did NOT pick, demote it
  // to a generic content step so the journey still matches the maker's intent.
  // Guide and reward have their own dedicated branches below; we only handle
  // quiz/poll/form/space here to avoid double-processing.
  const componentRule = {
    challenge: ctx.wantsQuiz,
    poll:      ctx.wantsPoll,
    form:      ctx.wantsForm,
    space:     ctx.wantsSpace
  };
  steps.forEach((s) => {
    if (Object.prototype.hasOwnProperty.call(componentRule, s.type) && componentRule[s.type] === false) {
      s.type = 'content';
      s.basic_props = basicPropsFor('content', {});
      s.advanced_props = advancedPropsFor('content', {});
    }
  });

  // Enforce guide presence per wizard answer
  if (ctx.wantsGuide && !steps.some(s => s.type === 'guide')) {
    // Swap the second-to-last content/challenge step into a guide if possible
    for (let i = steps.length - 2; i >= 1; i--) {
      if (steps[i].type !== 'reward') {
        steps[i].type = 'guide';
        steps[i].basic_props = basicPropsFor('guide', {});
        steps[i].advanced_props = advancedPropsFor('guide', {});
        steps[i].title = ctx.opts.guideName || steps[i].title || 'AI Guide';
        break;
      }
    }
  }
  if (!ctx.wantsGuide) {
    steps.forEach((s) => {
      if (s.type === 'guide') {
        s.type = 'content';
        s.basic_props = basicPropsFor('content', {});
        s.advanced_props = advancedPropsFor('content', {});
      }
    });
  }

  // Enforce reward step behaviour
  if (ctx.wantsReward && !steps.some(s => s.type === 'reward')) {
    // Promote last step to reward if it isn't already something important.
    // We don't set is_end here; the leaf-detection pass below decides which
    // step(s) are end steps based on the final path graph.
    const last = steps[steps.length - 1];
    last.type = 'reward';
    last.basic_props = basicPropsFor('reward', { reward_title: last.title });
    last.advanced_props = advancedPropsFor('reward', {});
  }
  if (!ctx.wantsReward) {
    steps.forEach((s) => {
      if (s.type === 'reward') {
        s.type = 'content';
        s.basic_props = basicPropsFor('content', { body: '<p></p>' });
        s.advanced_props = advancedPropsFor('content', {});
      }
    });
  }

  // First step is always the start; we recompute is_end below after path
  // normalisation, since "end" really means "has no outgoing path" — that's
  // the only definition that works for both linear journeys AND open-ended
  // branched journeys with multiple parallel ending steps.
  steps.forEach((s, i) => {
    s.is_start = i === 0;
  });

  // Normalise paths
  let pathsIn = Array.isArray(raw.paths) ? raw.paths : [];
  const stepIdSet = new Set(steps.map(s => s.id));
  pathsIn = pathsIn
    .map((p, i) => ({
      from: Number(p.from),
      to: Number(p.to),
      label: sanitize(p.label || 'Continue', 100),
      sort_order: i
    }))
    .filter(p => stepIdSet.has(p.from) && stepIdSet.has(p.to) && p.from !== p.to);

  // If no paths, build a linear spine
  if (pathsIn.length === 0) {
    pathsIn = [];
    for (let i = 0; i < steps.length - 1; i++) {
      pathsIn.push({ from: steps[i].id, to: steps[i + 1].id, label: 'Continue', sort_order: i });
    }
  } else if (!ctx.branchingProfile || ctx.branchingProfile.multiEnd !== true) {
    // Linear or merge-back branching: every non-last step must have an outgoing
    // path or the player would dead-end before the last step. For multi-end
    // shapes (adventure/open) we explicitly allow steps to have no outgoing
    // path, since that's how a route closes — so we skip this top-up there.
    for (let i = 0; i < steps.length - 1; i++) {
      const hasOut = pathsIn.some(p => p.from === steps[i].id);
      if (!hasOut) {
        pathsIn.push({ from: steps[i].id, to: steps[i + 1].id, label: 'Continue', sort_order: pathsIn.length });
      }
    }
  }

  // Force branching shape when requested but the model didn't comply. The
  // shape we force depends on the maker's complexity choice — at "subtle" we
  // only need a single 2-way split, at "open" we want the model to have
  // produced two splits, but if it didn't we still inject at least one rather
  // than ship a fully linear journey when the maker explicitly asked for
  // branches.
  if (ctx.wantsBranching) {
    const branchCounts = new Map();
    pathsIn.forEach(p => branchCounts.set(p.from, (branchCounts.get(p.from) || 0) + 1));
    const branchingSteps = Array.from(branchCounts.entries()).filter(([, n]) => n >= 2);
    const desiredSplits = (ctx.branchingLevel === 'adventure' || ctx.branchingLevel === 'open') ? 2 : 1;

    if (branchingSteps.length < desiredSplits && steps.length >= 3) {
      // Inject simple splits at evenly spaced positions in the middle of the
      // journey, picking step ids that aren't already a branch source.
      const usedSources = new Set(branchingSteps.map(([id]) => id));
      const candidates = [];
      const stride = Math.max(2, Math.floor(steps.length / (desiredSplits + 1)));
      for (let i = stride; i < steps.length - 1 && candidates.length < (desiredSplits - branchingSteps.length); i += stride) {
        if (!usedSources.has(steps[i].id)) candidates.push(i);
      }
      candidates.forEach((idx) => {
        const fromId = steps[idx].id;
        const nextId = steps[idx + 1].id;
        // Avoid emitting a duplicate path to the same target.
        if (!pathsIn.some(p => p.from === fromId && p.to === nextId)) {
          pathsIn.push({ from: fromId, to: nextId, label: 'Answer A', sort_order: pathsIn.length });
        }
        if (idx + 2 < steps.length) {
          const altId = steps[idx + 2].id;
          if (!pathsIn.some(p => p.from === fromId && p.to === altId)) {
            pathsIn.push({ from: fromId, to: altId, label: 'Answer B', sort_order: pathsIn.length });
          }
        }
      });
      // For multi-end profiles, also let the secondary paths terminate at
      // their next step (no outgoing) so the route really feels separate
      // instead of immediately funneling back into the spine. We do this by
      // simply NOT topping up outgoing paths for those steps; the leaf detect
      // below will mark them as ends.
    }
  }

  // Compute is_end from the final path graph: any step with no outgoing path
  // is an end step. This is what the builder's "End step" dropdown displays in
  // the Journey Settings panel, so multi-end shapes (adventure/open) end up
  // with multiple selectable endings out of the box.
  const outgoingByStep = new Map();
  pathsIn.forEach(p => {
    outgoingByStep.set(p.from, (outgoingByStep.get(p.from) || 0) + 1);
  });
  steps.forEach((s) => {
    s.is_end = !outgoingByStep.has(s.id);
  });
  // Safety net: if the graph somehow ended up with no end step at all (every
  // step has an outgoing path, e.g. a cycle), fall back to flagging the last
  // step in the array. This should not happen in practice after the path
  // normalisation above, but it keeps the journey openable in all cases.
  if (!steps.some(s => s.is_end)) {
    steps[steps.length - 1].is_end = true;
  }

  const suggestedGuide = raw.suggested_guide && typeof raw.suggested_guide === 'object'
    ? {
        name: sanitize(raw.suggested_guide.name || ctx.opts.guideName || 'Gryffi Assistant', 100),
        role: sanitize(raw.suggested_guide.role || 'Guide', 100),
        greeting: sanitize(raw.suggested_guide.greeting || '', 500),
        topics: Array.isArray(raw.suggested_guide.topics)
          ? raw.suggested_guide.topics.slice(0, 8).map(t => sanitize(t, 80))
          : []
      }
    : null;

  return { title, description, steps, paths: pathsIn, suggested_guide: suggestedGuide };
}

function basicPropsFor(type, s, ctx) {
  // `ctx` carries wizard component flags so we can drop in placeholder media
  // URLs when the maker asked for video/image steps. It's optional — callers
  // that don't have a wizard context (e.g. unit tests) just get text content.
  ctx = ctx || {};
  switch (type) {
    case 'content': {
      // Honour the AI's chosen media type when the wizard told it that video
      // or image content is allowed; otherwise fall back to plain text. We
      // attach a placeholder URL so the step is immediately previewable in
      // the builder, with a hint in the description that the maker should
      // swap it out.
      let mediaType = 'text';
      if (s.media_type === 'video' && ctx.wantsVideo) mediaType = 'video';
      else if (s.media_type === 'image' && ctx.wantsImage) mediaType = 'image';

      const props = {
        body: sanitizeHtml(s.body || ''),
        media_type: mediaType,
        video_url: '',
        image_url: '',
        media_description: '',
        text_position: 'above'
      };
      if (mediaType === 'video') {
        props.video_url = ctx.placeholderVideoUrl || PLACEHOLDER_VIDEO_URL;
        props.media_description = sanitize(s.media_description || '', 300);
      } else if (mediaType === 'image') {
        props.image_url = ctx.placeholderImageUrl || PLACEHOLDER_IMAGE_URL;
        props.media_description = sanitize(s.media_description || '', 300);
      }
      return props;
    }
    case 'challenge': {
      // Accept both the new multi-question format ("questions": [...]) and the
      // legacy single-question format ("question" + "options"). Always emit the
      // builder-friendly "questions" array so the maker can edit/extend in the
      // properties panel without an implicit migration step.
      const rawQuestions = Array.isArray(s.questions) && s.questions.length > 0
        ? s.questions
        : [{ question: s.question, options: s.options }];

      const buildQuestion = (q, idx) => {
        const options = Array.isArray(q && q.options) && q.options.length >= 2
          ? q.options.slice(0, 5)
          : [
              { text: 'Option A', is_correct: true },
              { text: 'Option B', is_correct: false }
            ];
        const hasCorrect = options.some(o => o && o.is_correct === true);
        return {
          id: `q${idx + 1}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          question: sanitize((q && q.question) || '', 500),
          options: options.map((o, i) => ({
            id: String.fromCharCode(97 + i),
            text: sanitize((o && o.text) || `Option ${i + 1}`, 300),
            correct: hasCorrect ? (o && o.is_correct === true) : (i === 0)
          }))
        };
      };

      // Cap to a sensible upper bound so a runaway model can't generate 20+ Qs.
      const questions = rawQuestions
        .slice(0, 3)
        .map((q, i) => buildQuestion(q, i))
        .filter(q => q.question);

      // If nothing usable came back, fall back to a single placeholder question
      // so the wizard never produces an empty challenge step.
      if (questions.length === 0) {
        questions.push(buildQuestion({}, 0));
      }

      return {
        type: 'multiple_choice',
        questions,
        shuffle_questions: false
      };
    }
    case 'guide':
      return {
        name: sanitize(s.name || s.guide_name || 'Gryffi Assistant', 100),
        role: sanitize(s.guide_role || 'Guide', 100),
        avatar_url: null,
        greeting: sanitize(s.suggested_greeting || '', 500),
        personality: 'friendly'
      };
    case 'form':
      return {
        intro: sanitize(s.form_intro || '', 300),
        fields: Array.isArray(s.form_fields) && s.form_fields.length > 0
          ? s.form_fields.slice(0, 6).map((f, i) => ({
              id: `field_${i + 1}`,
              label: sanitize(f.label || `Field ${i + 1}`, 200),
              type: ['text', 'textarea', 'email'].includes(f.type) ? f.type : 'text',
              required: !!f.required
            }))
          : [{ id: 'field_1', label: 'Your answer', type: 'text', required: false }]
      };
    case 'poll': {
      // Builder renders each option via `opt.text` — must be objects, not strings.
      const rawOptions = Array.isArray(s.poll_options) && s.poll_options.length >= 2
        ? s.poll_options.slice(0, 5)
        : ['Yes', 'No'];
      return {
        question: sanitize(s.poll_question || s.question || '', 300),
        options: rawOptions.map((o, i) => ({
          id: String.fromCharCode(97 + i),
          text: sanitize(typeof o === 'string' ? o : (o && o.text) || `Option ${i + 1}`, 200)
        })),
        allow_multiple: false,
        is_required: true
      };
    }
    case 'reward':
      return {
        title: sanitize(s.reward_title || s.title || 'Reward', 200),
        description: sanitize(s.reward_description || s.body || '', 500),
        redemption_location: '',
        terms_conditions: '',
        valid_until: null,
        is_random_codes: false,
        manual_codes: ''
      };
    case 'space':
      // Space steps always show an image, so we drop in the Pexels placeholder
      // when the maker ticked "Image" on the components page. Without that flag
      // the builder still shows a placeholder UI, but we leave the field empty
      // so the maker is gently nudged to add one of their own.
      return {
        description: sanitize(s.space_description || s.body || s.description || '', 500),
        image_url: ctx.wantsImage ? (ctx.placeholderImageUrl || PLACEHOLDER_IMAGE_URL) : '',
        is_panorama: false
      };
    default:
      return {};
  }
}

function advancedPropsFor(type, s) {
  switch (type) {
    case 'content':
      return { read_time: null };
    case 'challenge':
      return {
        hint: '',
        max_attempts: 3,
        pass_message: sanitize(s.feedback_correct || '', 500),
        fail_message: sanitize(s.feedback_incorrect || '', 500)
      };
    case 'guide':
      return {
        ai_instructions: sanitize(s.suggested_topic || '', 1000),
        topics: []
      };
    case 'form':
      return { confirmation_message: '' };
    case 'poll':
      return { show_results: true };
    case 'reward':
      return { celebration: true };
    case 'space':
      return {};
    default:
      return {};
  }
}

function sanitize(str, maxLen = 500) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .slice(0, maxLen)
    .trim();
}

function sanitizeHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .slice(0, 8000);
}

/**
 * Compute (x, y) positions for every step in a wizard plan so the builder
 * canvas opens with a tidy graph instead of overlapping arrows.
 *
 * Algorithm (Sugiyama-style, lite):
 *   1. Build adjacency maps from `plan.paths`.
 *   2. Assign each step a "layer" = longest path from any source step. Merge
 *      points naturally end up on the layer matching their deepest predecessor,
 *      so a diamond renders as 4 columns with the merge in the rightmost one.
 *   3. Walk layers left-to-right and pick a desired Y for each step from the
 *      mean Y of its already-placed parents (yBase for layer 0). Sort steps
 *      in the layer by that desired Y and pack them with at least ySpacing
 *      between centres, then re-centre the layer around yBase. This keeps
 *      branches visually anchored to the step that spawned them, so an upper
 *      branch stays "up" all the way through the journey instead of hopping
 *      around.
 *   4. Place each layer at x = xStart + layer * xSpacing.
 *
 * Linear journeys come out as a single row (one step per layer), identical
 * to what the old naive layout produced — so nothing regresses for the 90%
 * case. Branched journeys (including multi-end "open" shapes from the
 * branching-complexity slider) get the vertical separation they need without
 * the maker having to drag steps apart manually.
 *
 * @param {{steps:Array, paths:Array}} plan
 * @param {Object} [opts]
 * @param {number} [opts.xStart=100]
 * @param {number} [opts.xSpacing=280]
 * @param {number} [opts.yBase=240]
 * @param {number} [opts.ySpacing=180]
 * @returns {Map<*, {x:number, y:number}>} positions keyed by plan step id
 */
export function computePlanLayout(plan, opts = {}) {
  const xStart   = opts.xStart   ?? 100;
  const xSpacing = opts.xSpacing ?? 280;
  const yBase    = opts.yBase    ?? 240;
  const ySpacing = opts.ySpacing ?? 180;

  const positions = new Map();
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const paths = Array.isArray(plan?.paths) ? plan.paths : [];
  if (steps.length === 0) return positions;

  const stepIds = steps.map(s => s.id);
  const incoming = new Map(stepIds.map(id => [id, []]));
  for (const p of paths) {
    if (incoming.has(p.to)) incoming.get(p.to).push(p.from);
  }

  // First-touch ordering (used as a stable tiebreaker when two siblings have
  // the same desired Y, e.g. layer 0 or two children of the same parent).
  const firstSeenOrder = new Map();
  steps.forEach((s, i) => firstSeenOrder.set(s.id, i));
  paths.forEach((p, i) => {
    if (!firstSeenOrder.has(p.to)) firstSeenOrder.set(p.to, steps.length + i);
  });

  // Memoised longest-path layering with cycle guard. Mistral can in theory
  // emit a self-referential path; we treat any back-edge as layer 0 to keep
  // the recursion bounded.
  const layer = new Map();
  const computing = new Set();
  function layerOf(id) {
    if (layer.has(id)) return layer.get(id);
    if (computing.has(id)) return 0;
    computing.add(id);
    const preds = incoming.get(id) || [];
    let max = 0;
    for (const pred of preds) {
      const l = layerOf(pred) + 1;
      if (l > max) max = l;
    }
    computing.delete(id);
    layer.set(id, max);
    return max;
  }
  for (const id of stepIds) layerOf(id);

  // Group ids by layer.
  const byLayer = new Map();
  for (const id of stepIds) {
    const l = layer.get(id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(id);
  }
  const sortedLayers = Array.from(byLayer.keys()).sort((a, b) => a - b);

  // Walk layers left to right. For each step in a layer, use the average y
  // of its already-placed parents as a "desired y", then sort by desired y
  // and pack with at least ySpacing between neighbours. Finally, re-centre
  // the layer around yBase so the journey stays vertically balanced.
  for (const l of sortedLayers) {
    const ids = byLayer.get(l).slice();

    const desiredY = new Map();
    ids.forEach(id => {
      const parents = incoming.get(id) || [];
      const placed = parents
        .map(pid => positions.get(pid))
        .filter(p => !!p);
      if (placed.length === 0) {
        desiredY.set(id, yBase);
      } else {
        const sum = placed.reduce((acc, p) => acc + p.y, 0);
        desiredY.set(id, sum / placed.length);
      }
    });

    ids.sort((a, b) => {
      const da = desiredY.get(a) ?? yBase;
      const db = desiredY.get(b) ?? yBase;
      if (da !== db) return da - db;
      return (firstSeenOrder.get(a) ?? 0) - (firstSeenOrder.get(b) ?? 0);
    });

    const x = xStart + l * xSpacing;
    if (ids.length === 1) {
      positions.set(ids[0], { x, y: Math.round(desiredY.get(ids[0]) ?? yBase) });
      continue;
    }

    // Greedy packing: each step gets at least ySpacing vertical separation.
    const ys = [];
    let prev = -Infinity;
    for (const id of ids) {
      const want = desiredY.get(id) ?? yBase;
      const y = Math.max(prev + ySpacing, want);
      ys.push(y);
      prev = y;
    }
    // Re-centre so the layer is symmetric around yBase. Without this, layers
    // that only get "downward" desired ys would all drift below the spine.
    const mid = (ys[0] + ys[ys.length - 1]) / 2;
    const offset = yBase - mid;
    ids.forEach((id, i) => {
      positions.set(id, { x, y: Math.round(ys[i] + offset) });
    });
  }

  return positions;
}

export default { buildJourneyPlan, computePlanLayout };
