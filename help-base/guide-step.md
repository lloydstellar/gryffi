---
feature_id: guide-step
related_features: [journey-builder, ai-guides-overview, guide-knowledge-base, step-assistant, step-pacing, language-settings, journey-settings, journey-wizard]
---

# AI Guide Step

The AI guide step puts an AI guide in your journey. Participants ask questions in a chat. The guide answers from the documents you added to the guide.

![The settings of an AI guide step: Select AI Guide (2) and the selected guide (3)](images/guide-step/properties.en.webp)

1. The AI guide step on the canvas.
2. Select an AI guide: choose one of the guides of your organization.
3. The selected guide, with its personality, knowledge sources and greeting.

## Overview

When a participant reaches an AI guide step, they can:

- Chat with the guide
- Ask questions about the topic
- Get answers with the sources they come from

## Properties

### What they see

| Property | Description |
|----------|-------------|
| **Select an AI guide** | Choose which AI guide answers in this step |
| **Manage AI guides** | Opens the AI guides page, where you create guides and add their documents |

### Choosing a guide

You must first create an AI guide before you can use it in an AI guide step. Click the AI guide step on the canvas (1) to open its settings. The dropdown **Select an AI guide** (2) shows all guides of your organization. Below it you see the selected guide with its personality, number of sources and greeting (3). You create guides on the AI guides page.

[[goto:/dashboard/guides]]

### How it works

On the **How it works** tab you set:

- **Pacing**: when participants can continue. Choose Immediately (participants can skip the conversation), After 2 messages, After 4 messages or After 6 messages.
- **What the guide should know in this step (optional)**: extra information for the guide. The guide only uses it in this step.

See: step-pacing

### Shortcut via the Journey Wizard

When you create a new journey with the Journey Wizard, you can add an AI guide step to the generated journey. The wizard creates a new AI guide (with a name you pick, and if you want with your uploaded document as its knowledge) or uses an existing guide. You can change the selected guide afterwards, like in any AI guide step.

See: journey-wizard

### A guide in other steps

You can also add a guide to a step that is not an AI guide step. Open that step and choose a guide under **Guide in this step** on the How it works tab.

See: step-assistant

## How It Works

1. The participant reaches the AI guide step.
2. The guide appears in a chat.
3. The participant types a question.
4. The guide answers from the documents you added to it.
5. The answer shows its sources when it has them.
6. The participant can keep chatting or go to the next step.

## Language

By default, the guide answers in the language of the journey. That is the organization default language, unless the journey uses a different language. You can give the guide its own language:

1. Open Journey Settings (click on the canvas background, or on the settings button in the top bar).
2. Turn on **Use a different language for the guide**.
3. Choose the language under **Guide language**.
4. Optional: fill in **Fixed opening sentence**. The guide then starts with this sentence instead of writing its own.

The guide then answers in the selected language. Without a fixed opening sentence, its greeting is written in that language automatically. You can choose the 5 base languages (English, Dutch, German, French, Spanish) and the extended languages (Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish).

See: journey-settings, language-settings

## Tips

Before you use an AI guide step, make sure your guide has:

- Documents with the information participants need
- A personality and a name that fit the journey
- Fitting extra instructions for the guide

## Use Case examples

- **Training**: answer questions from new colleagues during onboarding
- **Support**: give help inside a journey
- **Education**: explain a hard topic step by step
- **Tours**: let participants ask questions about exhibits or locations

## Related Features

- [[goto:/dashboard/guides]] - Create and manage AI guides
- See: ai-guides-overview, guide-knowledge-base, step-assistant
