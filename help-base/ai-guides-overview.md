---
feature_id: ai-guides-overview
related_features: [guide-step, guide-knowledge-base, guide-personality, guide-identity, guide-ai-instructions, language-settings, journey-settings, copy-translate, journey-wizard]
---

# AI Guides Overview

AI Guides are intelligent conversational assistants powered by AI that can answer questions, provide help, and guide users through your content.

[[show:list]]

## Overview

AI Guides enable:

- Conversational Q&A with your content
- Smart assistance within journeys
- Knowledge-based answers with source citations
- Customizable personality and behavior
- Integration into Guide Steps

[[goto:/dashboard/guides]]

## What is an AI Guide?

An AI Guide is a chatbot trained on your specific content:

- Upload documents, FAQs, and information
- The AI learns from your content
- Users can ask questions naturally
- Answers are based on your knowledge base
- Sources are cited for transparency

## Creating an AI Guide

There are two ways to create an AI Guide:

1. **Manually** from the Guides page (the classic flow, described below). You fully control name, role, personality, knowledge base and AI instructions from the start.
2. **Via the Journey Wizard** when creating a new journey. The wizard can create a new Guide for you (with a name you choose) and optionally seed its knowledge base with the document you uploaded in step 1. It can also attach an existing Guide to the generated journey without creating a new one. This is the fastest way to get a journey + Guide combination running. See: journey-wizard.

### Step 1: Create New Guide

1. Go to Guides
2. Click "Create Guide"
3. Enter a name and description

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
- AI Guides respond in the organization's default language
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

### Step 5: Add AI Instructions

Fine-tune behavior with in the field AI Instructions:
- What topics to focus on
- What to avoid discussing
- How to handle certain questions
- Custom responses for specific queries

See: guide-ai-instructions

## Using AI Guides

### In Guide Steps

Embed guides in journeys:
1. Add a Guide Step to your journey
2. Select which AI Guide to use
3. Add optional context for this step
4. Users chat with the guide during the journey

See: guide-step

### Guide Step

Use guides as independent step:
- Chat with your AI Guide in the journey

## Knowledge Base Sources

| Source Type | Description |
|-------------|-------------|
| **Documents** | PDF, DOC, DOCX, TXT, MD, CSV, PPTX, Images |
| **Text** | Manually entered content |

## Answer Quality

### Source Citations
Every answer includes:
- Referenced sources
- "I don't know" when uncertain

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
- Update based on user questions
- Test regularly

## Limitations

- AI may occasionally give incorrect answers
- Cannot access external systems in real-time
- Limited to trained knowledge
- No personal user data access (by design)

## Related Features

- [[goto:/dashboard/guides]] - Manage guides
- [[goto:/dashboard/guides]] - Create new guide
- See: guide-knowledge-base, guide-step, language-settings, journey-settings, copy-translate, journey-wizard
