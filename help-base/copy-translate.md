---
feature_id: copy-translate
related_features: [journey-builder, language-settings, journey-settings, ai-guides-overview, journey-wizard]
---

# Copy & Translate Journey

Copy & Translate allows you to create a translated copy of an existing journey in a different language. This is useful when you need to deliver the same content to audiences in multiple languages.

[[show:overview]]

## Overview

When you copy and translate a journey:

- A new draft journey is created with all content translated
- The original journey remains unchanged
- Language overrides are automatically configured
- AI Guide settings are preserved and translated

[[goto:/dashboard/journeys]]

## How to Copy & Translate

1. Go to the Journeys list
2. Find the journey you want to translate
3. Click the **⋮** (kebab menu) on the journey card
4. Select **Copy to another language**
5. In the modal:
   - Select the **target language** from the dropdown
   - Optionally change the **new journey name**
6. Click **Start Translation**
7. Wait for the translation to complete (progress bar will show status)

## What Gets Translated

The following content is automatically translated using AI:

| Content Type | Translated |
|--------------|:----------:|
| Journey title | ✅ |
| Journey description | ✅ |
| Step titles | ✅ |
| Space descriptions | ✅ |
| Content body text | ✅ |
| Quiz questions & answers | ✅ |
| Quiz pass/fail messages | ✅ |
| Form field labels | ✅ |
| Form confirmation message | ✅ |
| Poll questions | ✅ |
| Poll options | ✅ |
| Reward titles & descriptions | ✅ |
| Path labels | ✅ |
| Resource descriptions | ✅ |
| AI Guide opening sentence | ✅ |

## What's NOT Translated

Some content is copied but not translated:

- Images and media files
- File attachments
- Reward codes
- External URLs
- Step positions and layout
- Advanced automation settings

## Automatic Settings

When a translated copy is created, the following settings are automatically configured:

### Language Override
- **Journey Interface Language**: Set to the target language
- **AI Guide Language Override**: Set to the target language

### AI Guide Opening Override
If the original journey has a central AI Guide, the guide's greeting is translated and stored as a static "Opening sentence override". This means:
- The opening sentence loads instantly (no AI generation delay)
- More reliable than dynamic generation
- Can be manually edited if needed

## Supported Languages

You can translate to any of the supported languages:

### Base Languages
English, Dutch, German, French, Spanish

### Extended Languages
Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish

## After Translation

Once the translation is complete:

1. The new journey opens in the builder
2. Review the translated content
3. Make manual adjustments if needed
4. The journey is saved as a **draft**
5. Publish when ready

### Editing the Opening Override

If you need to adjust the AI Guide's translated opening sentence:

1. Open the translated journey in the builder
2. Click on empty canvas space to open Journey Settings
3. Find "AI Guide language" section
4. Edit the "Opening sentence override" textarea
5. Save the journey

## Tips

- **Review translations**: AI translations are generally accurate, but always review important content
- **Quiz answers**: Double-check that quiz answer options are correctly translated
- **Placeholders**: Variables like `{{name}}` are preserved during translation
- **HTML formatting**: Bold, italic, and other formatting is preserved
- **Combine with the Journey Wizard**: a common workflow is to build a first-language version with the Journey Wizard (which generates steps, texts and optionally an AI Guide) and then use Copy & Translate to produce localized copies for other language groups. See: journey-wizard.

## Translation Progress

During translation, you'll see a progress bar with these stages:

1. **Loading** - Fetching journey data
2. **Translating** - AI is translating content (this takes the longest)
3. **Creating** - Saving the new journey
4. **Creating Steps** - Copying and saving translated steps
5. **Creating Paths** - Copying path connections
6. **Done** - Translation complete

## Troubleshooting

### Translation is slow
AI translation can take 30 seconds to several minutes depending on the amount of content. Be patient and don't close the window.

### Some content not translated
Check if the content type is in the "What Gets Translated" list. Some advanced settings may not be translated.

### Translation failed
If translation fails, try again. If the problem persists, contact support.

## Related Features

- [[goto:/dashboard/journeys]] - Journey list
- See: language-settings, journey-settings, ai-guides-overview, journey-wizard
