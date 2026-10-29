---
feature_id: journey-settings
related_features: [journey-builder, journey-wizard, journey-publishing, journey-language, journey-flow, language-settings, ai-guides-overview, copy-translate]
---

# Journey Settings

Journey Settings allow you to configure the properties, behavior, and appearance of individual journeys.

[[show:general]]

## Overview

Journey settings include:

- Basic information (title, description)
- Access and visibility
- Language settings (interface and AI Guide)
- Flow configuration
- Appearance options
- Completion settings

[[goto:/dashboard/journeys]]

## Accessing Settings

1. Open a journey in the builder
2. Click the "Settings" icon (gear) in toolbar in the top of the screen
3. Or click left on somewhere on the empty space of the canvas in the journey builder view

## General Settings

- Journey Title
- Description
- Journey Flow
- Interface language
- AI Guide language

### Renaming Wizard-Generated Journeys

Journeys created with the Journey Wizard get an AI-proposed title and a one-sentence description instead of a name you typed yourself. These are meant as suggestions. Open Journey Settings and update the **Title** and **Description** fields to match your organization's wording. This has no impact on the generated steps — only the metadata on the journey card and the default browser tab label.

See: journey-wizard

### Journey Flow

Set a "Start Step" and an "End Step". Without these start and end step, you can not publish the journey. Every journey needs a Start Step and at least on End Step. But you can also make multiple End Steps, so you can end your journey in multiple ways.

## Language Settings

Journey language settings allow you to customize the language experience for end-users on a per-journey basis.

### Journey Interface Language

By default, the interface of the journey the end user sees is in your organization default language. You can override the interface language for an individual journey:

1. In Journey Settings, find "Interface Language"
2. Enable "Use a different language"
3. Select from available languages:
   - **Base languages**: English, Dutch, German, French, Spanish
   - **Extended languages**: Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish
4. Save the journey

This affects all player interface elements:
- Navigation buttons ("Continue", "Back", etc.)
- Form labels and validation messages
- Quiz feedback ("Correct!", "Try again", etc.)
- Poll voting interface
- Reward claim screens
- Pacing messages

### AI Guide Language Override

You can set a separate language for AI Guide responses, independent of the journey interface language:

1. In Journey Settings, find "AI Guide language"
2. Enable "Override AI Guide language"
3. Select the desired language for AI responses
4. Save the journey

When enabled:
- The AI Guide greeting will be generated in the selected language
- All AI Guide responses will be in the selected language
- The interface elements remain in the journey interface language

**Use cases:**
- Journey interface in English, but AI Guide responds in Polish for Polish-speaking employees
- Test AI Guide responses in different languages during preview
- Serve multilingual teams where the interface language differs from the preferred conversation language

### Opening Sentence Override

When AI Guide language override is enabled, you can also set a static "Opening sentence override":

1. Enable "Override AI Guide language" first
2. Find the "Opening sentence override" textarea
3. Enter a translated opening sentence for the AI Guide
4. Save the journey

**Benefits:**
- Instant loading (no AI generation delay)
- More reliable than dynamic generation
- Automatically filled when using Copy & Translate

**Note:** This is optional. If left empty, the AI Guide will dynamically generate an opening in the selected language.

See: language-settings, ai-guides-overview, copy-translate

## Related Features

- [[goto:/dashboard/journeys]] - Journey list
- See: journey-builder, journey-publishing, journey-flow, language-settings
