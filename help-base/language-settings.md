---
feature_id: language-settings
related_features: [organization-settings, user-settings, journey-settings, copy-translate, journey-wizard]
---

# Language Settings

Language Settings control the interface, email and PDF languages available throughout Gryffi.

![Select language in My account (1)](images/language-settings/interface.en.webp)

1. Select language: the language of your own interface. It does not change the language of others or of journeys.

## Overview

There are several language settings that control different parts of the platform:
1. The organization default language
2. The makers personal interface language
3. The language of a single journey (for participants)
4. The language of the AI guide in a single journey

[[goto:/dashboard/settings]]

## Supported Languages

Gryffi supports two categories of languages:

### Base Languages (Full Support)

These languages are available for the entire platform including the maker interface, emails, and PDFs:

| Language | Code | Maker Interface | Journey Player | Emails & PDFs |
|----------|:----:|:---------------:|:--------------:|:-------------:|
| English | en | Yes | Yes | Yes |
| Dutch (Nederlands) | nl | Yes | Yes | Yes |
| German (Deutsch) | de | Yes | Yes | Yes |
| French (Français) | fr | Yes | Yes | Yes |
| Spanish (Español) | es | Yes | Yes | Yes |

### Extended Languages (Journey Player Only)

These additional languages are available for participant journey experiences. You can pick them as the language of a journey or as the language of the guide:

| Language | Code | Journey Player |
|----------|:----:|:--------------:|
| Italian (Italiano) | it | Yes |
| Portuguese (Português) | pt | Yes |
| Danish (Dansk) | da | Yes |
| Norwegian (Norsk) | no | Yes |
| Finnish (Suomi) | fi | Yes |
| Swedish (Svenska) | sv | Yes |
| Polish (Polski) | pl | Yes |
| Romanian (Română) | ro | Yes |
| Turkish (Türkçe) | tr | Yes |

Extended languages affect:
- Journey player interface (buttons, messages, navigation)
- The AI guide's answers (when a different language for the guide is set)
- Quiz, poll, form, and reward step interfaces

## Language settings

### Organization Language

Only a maker with the role Admin can change the default organization language.

Set the organization default:
1. Go to Organization → General
2. Open the list "Default organization language"
3. Pick a language (English, Dutch, German, French or Spanish), or pick "Use each maker's browser language"
4. Click Save

The language you pick is used for the interface of journeys (not the content of journeys), the automated emails and the downloadable PDFs, for all makers and participants. Makers see Gryffi in this language until they choose their own language in My account.

With "Use each maker's browser language", every maker sees Gryffi in the language of their browser. Makers can still change their own language in My account.

### Makers Personal Language

Set your personal interface language:
1. Go to My account → Language
2. Select your language in **Select language** (1)
3. Save

This only changes the interface for the maker who sets it. It does not change the content, other makers or participants.

## Journey Language

You can set a different language for a single journey. This is useful when you need to deliver content to participants in a different language than your organization default.

### Language for participants

Choose the interface language for a specific journey:
1. Open the journey in the builder
2. Click on the canvas background to open Journey Settings
3. Turn on "Use a different language"
4. Select the language under "Journey language" (base or extended)
5. The builder saves your change by itself

This changes:
- Navigation buttons and messages
- Quiz, poll, form interfaces
- Reward step text
- All player interface elements

### Guide language

You can set a separate language for the answers of the AI guide, independent of the journey language:
1. Open the journey in the builder
2. Click on the canvas background to open Journey Settings
3. Turn on "Use a different language for the guide"
4. Select the language under "Guide language"
5. The builder saves your change by itself

This is useful when:
- You want the interface in one language but the guide's answers in another
- Your AI guide's knowledge base is in a specific language
- You're serving multilingual audiences

See: journey-settings, ai-guides-overview

## Copy & Translate Journeys

If you need to create the same journey in multiple languages, use **Copy & Translate** instead of translating by hand:

1. Go to the Journeys list
2. Click the **⋮** (three dots) on the journey you want to translate
3. Select **Copy to another language**
4. Choose the target language
5. Wait for the AI translation to finish

This creates a new journey with:
- All content translated
- "Use a different language" set to the target language
- "Use a different language for the guide" set to the target language
- The AI guide's opening sentence translated

See: copy-translate

## Related Features

- [[goto:/dashboard/settings]] - Personal language settings
- [[goto:/dashboard/system-settings#general]] - Organization default language settings
- [[goto:/dashboard/journeys]] - Journey list with language settings
- See: organization-settings, user-settings, journey-settings, ai-guides-overview
