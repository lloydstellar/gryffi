---
feature_id: ai-guides-overview
related_features: [guide-step, guide-knowledge-base, guide-personality, guide-identity, guide-ai-instructions, language-settings, journey-settings, copy-translate, journey-wizard]
---

# AI Guides Overview

AI Guides are intelligent conversational assistants powered by AI that can answer questions, provide help, and guide participants through your content.

![The AI Guides page: Create Guide (1), a guide (2) and its menu (3)](images/ai-guides-overview/list.en.webp)

1. Create Guide: set up a new AI guide.
2. A guide with its role, personality, the journeys that use it and its knowledge (sources and pieces of text). Click it to edit the guide.
3. The menu of a guide: make a copy or delete it.

## Overview

AI Guides enable:

- Conversational Q&A with your content
- Smart assistance within journeys
- Knowledge-based answers with source citations
- Customizable personality and behavior
- Integration into AI guide steps

[[goto:/dashboard/guides]]

## What is an AI Guide?

An AI Guide is a chatbot trained on your specific content:

- Upload documents, FAQs, and information
- The AI learns from your content
- Participants can ask questions naturally
- Answers are based on your knowledge base
- Sources are cited for transparency

## Creating an AI Guide

There are two ways to create an AI Guide:

1. **Manually** from the Guides page (the classic flow, described below). You fully control name, role, personality, knowledge base and extra instructions for the guide from the start.
2. **Via the Journey Wizard** when creating a new journey. The wizard can create a new Guide for you (with a name you choose) and optionally seed its knowledge base with the document you uploaded in step 1. It can also attach an existing Guide to the generated journey without creating a new one. This is the fastest way to get a journey + Guide combination running. See: journey-wizard.

### Step 1: Create New Guide

1. Go to Guides
2. Click "Create Guide" (1)
3. Enter a name and description

To edit an existing guide, click it in the list (2). Its menu (3) lets you make a copy or delete it.

### Step 2: Build Knowledge Base

Add content the AI should know:
- Upload documents (PDF, Word, etc.)
- Write text manually

See: guide-knowledge-base

### Step 3: Configure Personality

Set how the AI should communicate:
- Tone (formal, friendly, professional)
- Language style
- Persona name
- Default response language

See: guide-personality

### Language Settings for AI Guides

AI Guides can respond in multiple languages:

**Default behavior:**
- A new guide gets the organization's default language. You can change it on the page of the guide.
- A guide always answers in its own language, also when someone asks a question in another language
- The greeting message is shown as configured in the Guide settings

**Journey-level override:**
- Each journey can specify a different language for AI Guide responses
- Enable "Override AI Guide language" in Journey Settings
- Select from base languages (English, Dutch, German, French, Spanish) or extended languages (Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish)
- The AI will generate greetings and respond in the selected language

**Opening Sentence Override:**
When using AI Guide language override, you can also set a static translated opening sentence:
- Appears in Journey Settings when AI Guide language override is enabled
- Loads instantly without AI generation delay
- Automatically filled when using Copy & Translate feature
- Can be manually edited for fine-tuning

See: journey-settings, language-settings, copy-translate

### Step 4: Set Identity

Define who the AI represents:
- Name (e.g., "Gryffi Assistant")
- Role (e.g., "HR Helper")
- Avatar image
- Introduction message

See: guide-identity

### Step 5: Add Extra instructions for the guide

Fine-tune behavior in the field Extra instructions for the guide:
- What topics to focus on
- What to avoid discussing
- How to handle certain questions
- Custom responses for specific queries

See: guide-ai-instructions

### Step 6: Test the Guide

Click **Test this guide** at the top of the guide's page. A panel opens on the right where you chat with the guide, the same way a participant would:
- The panel starts with the greeting participants see.
- The guide answers with the saved settings and knowledge. Changes you just made are saved first.
- Under each answer you see the sources it used.
- Click **Start over** to begin a new conversation.

Each answer counts as one AI question. When a guide answers something wrong, check its knowledge base and its extra instructions, then test again.

## Using AI Guides

### In AI guide steps

Embed guides in journeys:
1. Add an AI guide step to your journey
2. Select which AI Guide to use
3. Add optional context for this step
4. Participants chat with the guide during the journey

See: guide-step

### AI guide step

Use guides as independent step:
- Chat with your AI Guide in the journey

## Knowledge Base Sources

| Source Type | Description |
|-------------|-------------|
| **Documents** | PDF, DOC, DOCX, TXT, MD, CSV, PPTX, Images |
| **Text** | Manually entered content |

## Answer Quality

### Source Citations
When an answer uses the knowledge base, a small number appears after the sentence that comes from a source, for example [1]. The sources are listed below the answer. Participants can click a number or a source to read the passage the answer comes from. The test chat in the guide settings shows sources the same way.

When the guide is not sure, it says it does not know.

### Handling Unknown Topics
When the AI doesn't have information:
- Refers to human support

## Best Practices

### Knowledge Base
- Keep content up to date
- Cover common questions
- Review and refine regularly

### Personality
- Match your brand voice
- Don't pretend to be human
- Set appropriate expectations

### Maintenance
- Identify knowledge gaps
- Update based on questions from participants
- Test regularly

## Limitations

- AI may occasionally give incorrect answers
- Cannot access external systems in real-time
- Limited to trained knowledge
- No access to personal data of participants (by design)

## Related Features

- [[goto:/dashboard/guides]] - Manage guides
- [[goto:/dashboard/guides]] - Create new guide
- See: guide-knowledge-base, guide-step, language-settings, journey-settings, copy-translate, journey-wizard
