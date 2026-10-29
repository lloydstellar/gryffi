---
feature_id: journey-wizard
related_features: [journey-builder, journey-settings, ai-guides-overview, guide-knowledge-base, guide-step, content-step, challenge-step, form-step, poll-step, reward-step, copy-translate, language-settings]
---

# Journey Wizard

The Journey Wizard is a guided, step-by-step flow that creates a first version of a journey for you, based on a short questionnaire. It is designed for non-technical makers who want a working starting point without having to build every step from scratch. After the wizard finishes, you land in the regular Journey Builder where you can review, refine, add images and publish.

The wizard is not a replacement for the builder — it produces a template that you still have to polish before you share it with end users.

[[show:overview]]

## Overview

The Journey Wizard:

- Asks you a few simple questions, one per page
- Generates a complete journey draft (steps, paths, texts) using AI
- Optionally creates or attaches an AI Guide
- Optionally seeds that AI Guide's knowledge base with your uploaded document
- Lets you resume where you left off if you close the modal by accident
- Always saves the result as a **draft**, so nothing is visible to end users until you publish

[[goto:/dashboard/journeys]]

## How to Start the Wizard

1. Go to the Journeys list
2. Click **Create journey**
3. A choice modal appears with two cards:
   - **Start with the Wizard** (recommended) — opens the wizard
   - **Start with a blank canvas** — goes straight to an empty journey
4. Pick **Start with the Wizard**

The wizard opens as a modal on top of the journeys page.

> Viewers cannot create journeys, so the **Create journey** button is hidden for viewer role. If your organization is at its journey limit, the button is also disabled and explains why.

## Resuming a Wizard Session

If you close the wizard halfway (accidentally or on purpose), your answers are saved in the browser for 6 hours. The next time you open the wizard, it asks whether you want to:

- **Continue** where you left off
- **Start fresh** and discard the previous answers

If your session has expired, the wizard just opens at the first question.

## The Wizard Pages

The wizard always asks the same questions in the same order, one per page. You can go back to change an earlier answer at any time, and every question is reachable from the final summary via a **Change** link.

### 1. Source — "Where does your journey start from?"

Choose one of two starting points:

- **I have a document** — Upload a file and Gryffi reads it to build the journey around its content. Supported formats: PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), Excel (.xls/.xlsx), plain text (.txt), Markdown (.md), CSV, and images (.png, .jpg, .webp, .gif). Limits: **50 MB** per file, **60 pages**. If your document is longer than 60 pages, only the first 60 pages are used and the wizard warns you.
- **I'll describe it myself** — No document needed. You type a short description on the next page.

If the document parser is temporarily unavailable (which can happen on smaller dev environments), the upload returns a clear "parser unavailable" message. Try again in a minute or switch to the "describe" path.

### 2. Topic — "What is your journey about?" *(only shown when "describe" was chosen)*

A free-text box where you describe, in a few sentences, what the journey should cover. The wizard requires at least 30 characters so the AI has something to work with.

### 3. Purpose — "What is this journey for?"

A single-choice list of six purposes. This steers tone, depth and the types of steps the AI picks:

| Purpose | When to pick it |
|---------|-----------------|
| Onboarding | Welcoming new employees, first-week journeys |
| Compliance | Safety, policy or compliance training. Always includes a knowledge check. |
| Product | Product or procedure training with step-by-step explanations |
| Tour | Location or facility introduction — prefers Space steps |
| Knowledge | Internal knowledge sharing or reference material |
| Welcoming guests or visitors | Hospitality journeys for hotel guests, campsite visitors, holiday-park residents, conference attendees, attraction visitors and other people you host on location. Switches to a friendly second-person tone, focuses on practical on-site info (arrival, facilities, Wi-Fi, rules, opening hours), keeps challenges light and may end with a feedback poll. |

### 4. Audience — "Who is this journey for?" *(optional)*

A free-text hint about the target audience, for example "new warehouse staff" or "SaaS customers". It influences the tone of voice and the difficulty of challenge questions. You can leave this empty.

### 5. AI Guide — "Do you want an AI Guide in this journey?"

Four options. Some may be disabled based on earlier answers.

| Option | What it does | Notes |
|--------|--------------|-------|
| Use an existing AI Guide | Pick an AI Guide that already exists in your organization. | Shown only if you have at least one active AI Guide. |
| Create a new Guide with my document as knowledge base | Creates a brand-new AI Guide and loads your uploaded document into its knowledge base. | Only available when you uploaded a document in step 1. Disabled when the organization is at the AI Guide limit. |
| Create a new Guide (I'll add the knowledge later) | Creates an empty AI Guide that you can fill with documents later. | Disabled when the organization is at the AI Guide limit. |
| No AI Guide | Skips adding a Guide step. | Always available. |

When you create a new Guide you are asked for a **name** (e.g. "Willempie", "Sara", "Coach Max"). The field starts empty so you can pick a name that fits your organization's tone. The AI Guide's greeting will always use exactly the name you provided.

### 6. Length — "How long should the journey be?"

Three options map directly to the number of generated steps:

- **Short** — 3 steps (intro, core content, closing)
- **Medium** — 5 steps (default for most use cases)
- **Long** — 7 steps, usually with at least one challenge check

The AI still picks the best types (content, challenge, form, poll, guide) based on the purpose — the length just caps the total.

### 7. Branching — "Should the journey have a choice moment?"

- **No** (default) — Linear flow: every step leads to the next.
- **Yes** — The AI places one branching moment in the middle. A content step asks a short question, and the user picks the answer by clicking on one of two outgoing paths. The path labels literally spell out the answers, so the end user sees what they are choosing.

Branching is limited to **one** fork in the wizard output to keep the starting point simple. You can always add more branches manually in the builder afterwards.

### 8. Reward — "How do you want to end?"

Five closing options:

| Option | What happens |
|--------|--------------|
| Voucher / discount code | Adds a closing reward step framed as a voucher. You still need to configure actual codes in the builder. |
| Completion certificate | Adds a closing reward step framed as a certificate. |
| Warm thank-you | Adds a closing reward step with a thank-you tone. |
| I'll set this up later | Adds an empty reward step for you to fill in later. |
| No reward | Ends with a regular closing content step. |

For the first three options you can optionally type extra context (e.g. "10% off our store"). The AI uses it to phrase the reward step — it never invents real codes, dates or URLs.

### 9. Language — "In which language should the journey be written?"

Defaults to the interface language of the maker. You can pick any of the 14 languages Gryffi supports:

English, Dutch, German, French, Spanish, Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish.

All generated step content, titles, the guide greeting, path labels and the journey title are written in this language. You can translate the result later with Copy & Translate.

### 10. Summary

Before the journey is generated, a summary page lists every answer. Each row except the journey name has a **Change** link that jumps back to that question. The summary also shows:

- The **journey name** — Gryffi picks this itself; you do not enter a title. The wizard tells you clearly that you can rename the journey later in the builder.
- A soft **disclaimer** that the result is a starting point, not a finished journey.

Click **Build my journey** to launch generation.

## The Journey Name

The wizard deliberately does **not** ask you to name the journey. A short, fitting title and a one-sentence description are generated by the AI, in the language you picked. This keeps the wizard one step shorter and avoids naming something before you have seen the content. You can rename the journey at any time in the Journey Settings.

## Progress and Completion

While generating, a progress modal shows a status line that updates in real time through these stages:

1. **Reading** — Reading your document (skipped if you chose "describe")
2. **Thinking** — Designing the steps
3. **Creating** — Building the journey record
4. **Steps** — Saving the individual steps
5. **Paths** — Connecting the steps
6. **Guide** — Creating or linking the AI Guide (if chosen)
7. **Knowledge** — Indexing your uploaded document into the guide's knowledge base (if chosen)
8. **Finishing** — Final cleanup

Do not close the modal while the progress bar is running. Generation typically takes 20–60 seconds, longer for large documents.

### Success

When the journey is ready, you see a green check and a short recap of what to do next:

1. Check the texts per step
2. Add your own images
3. Add extra steps where needed
4. Publish only when you are happy with it

Clicking **Open in the builder** takes you to the new journey in the Journey Builder as a draft.

### Errors

If anything fails, the wizard shows an error page with two actions:

- **Try again** — Returns you to the summary so you can tweak an answer and retry.
- **Create a blank journey instead** — Abandons the wizard and opens a fresh empty journey with the defaults, so your time is not wasted.

Common failure causes: network hiccups, AI service rate limits, unreadable document (scanned PDF with no text layer), or the AI returning invalid JSON. In all cases retrying usually works.

## What the Wizard Generates

The wizard produces a draft journey containing:

- **Exactly** the number of steps chosen in step 6 (3, 5 or 7)
- A **content intro** as the first step
- An optional **AI Guide step** if you asked for one
- One or more **content** and **challenge** steps based on the purpose
- Occasionally a **form** or **poll** step where it makes sense
- An optional **reward** step as the closing step
- **Paths** that connect all steps, including a branching fork if you asked for it
- A **title** and a one-sentence **description**

Defaults for specific step types the wizard creates:

- **Content steps** are created with media type `text` so the builder shows the generated HTML body immediately in preview.
- **Poll steps** get options as proper objects (id + text) so they render correctly.
- **Form steps** are pre-filled with your own email address as the recipient, so the form is immediately submittable in preview. You can change the recipient in the step settings.
- **Guide steps** copy the real Guide's name, role and greeting into the step so nothing can go out of sync.
- **Reward steps** get empty fields for codes, terms and validity — these are yours to fill in.

## What the Wizard Does NOT Do

The wizard intentionally leaves a lot of things up to the maker:

- It does **not** upload or insert custom images. Add your own images to content, space and reward steps in the builder.
- It does **not** invent real discount codes, certificate URLs, voucher values or dates.
- It does **not** publish the journey. The result is always a draft.
- It does **not** send invitations to end users.
- It does **not** create Space steps with a floor plan or 360° panorama. Add those manually.
- It does **not** create multiple branches. Only one fork is allowed, in the middle.
- It does **not** replace the existing AI Guide's knowledge base when you pick "Use an existing AI Guide". The document, if uploaded, is only used to generate the journey content in that case, not to seed the existing guide.

## Role Limits

The wizard respects the same limits as the rest of the app:

- **Maker role**: viewers do not see the **Create journey** button at all.

## Document Parsing Notes

The document you upload is sent to Gryffi's parser service to extract plain text:

- PDF, Word and PowerPoint are processed with the **fast** parsing strategy, which avoids heavy OCR and keeps memory use low.
- Scanned PDFs with no embedded text layer may return very little text. If you see a "we could not read any text from this file" error, try re-exporting the document or switch to the "describe" path.
- The file is deleted after the journey is generated, unless you chose "Create a new Guide with my document as knowledge base". In that case the file is kept as a knowledge source on the new AI Guide and can be managed from the Guide's knowledge base page.

## After the Wizard: Editing the Result

Once you are in the builder:

1. **Review every step** — The AI is good, but not perfect. Read the generated text and adjust facts, tone and length.
2. **Rename the journey** if the AI's suggestion does not fit. Click empty canvas → Journey Settings → Title.
3. **Add images and media** — Content steps only have text until you add images or videos.
4. **Configure reward details** — Add real voucher codes, certificate text or redemption instructions in the reward step.
5. **Check form recipients** — The wizard defaults form submissions to your own email address. Change this in the form step settings if another person should receive the responses.
6. **Publish** the journey when everything looks right.

## Tips

- **Short documents work best**: A focused 5–20 page document produces a tighter journey than a 60-page monster handbook.
- **Be specific in the audience field**: "newly hired warehouse operators" leads to different wording than "our customers".
- **Use the describe path for abstract topics**: If your content is not really in a document yet, typing a description often produces a cleaner outcome than uploading an unrelated file.
- **Keep the Guide name short and human**: It appears in the chat bubble; long names make it look awkward.
- **Use Copy & Translate after**: Build one journey with the wizard in your main language, then translate the polished version into other languages with Copy & Translate.

## Troubleshooting

### The Next button stays greyed out

Each page has at least one required answer. On the source page you need to either upload a document successfully or pick the "describe" card. On the guide page you need a name for a new Guide or a selected existing Guide.

### My document was uploaded but the Next button stays disabled

Wait for the "Document ready" confirmation with the file name and page count before clicking Next. If the upload appears to complete but the button stays disabled, click the **Change file** link and try again.

### We could not read this file

The parser service could not extract any text. Most common causes:

- The PDF is an image scan without an OCR text layer
- The file is password-protected
- The parser service is down on a small environment — try again in a minute

### Generation fails halfway

The AI sometimes returns malformed output or times out. Click **Try again** on the error screen. If it keeps failing, use **Create a blank journey instead** and add a few steps manually — usually one pass of the wizard works again later.

### I opened the builder and the server froze

This is an infrastructure issue, not a wizard bug. The generation uses a fair amount of memory — make sure the host has swap or at least 4 GB of RAM available.

### The AI Guide's greeting mentions a different name than the one I gave

The wizard actively reconciles the name in the greeting with the name you provided. If you still see a mismatch, reload the journey — the builder may be showing a cached version.

### Forms generated by the wizard give a 400 on submit

Only relevant for older wizard journeys. New wizard journeys ship with your own email as the form recipient. For legacy ones, open the form step in the builder and set **Send submissions to** to a valid email.

### I want more branches than one

The wizard only creates one fork by design. Open the journey in the builder and draw additional paths manually — the builder supports any graph shape.

## Related Features

- [[goto:/dashboard/journeys]] - Journey list
- See: journey-builder, journey-settings, ai-guides-overview, guide-knowledge-base, guide-step, content-step, challenge-step, form-step, poll-step, reward-step, copy-translate, language-settings
