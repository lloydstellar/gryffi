---
feature_id: guide-step
related_features: [journey-builder, ai-guides-overview, guide-knowledge-base, guide-personality, guide-identity, language-settings, journey-settings, journey-wizard]
---

# Guide Step

The Guide Step embeds an AI-powered conversational assistant into your journey. Users can ask questions and receive intelligent responses based on your knowledge base.

[[show:properties]]

## Overview

Guide Steps bring your AI Guides into the journey experience. When a user reaches a Guide Step, they can:

- Chat with the AI assistant
- Ask questions about the topic
- Receive contextual help and information
- Get cited sources for answers

## Properties

### Basic Settings

| Property | Description |
|----------|-------------|
| **Select Guide** | Choose which AI Guide to use at this step |

### Guide Selection

You must first create an AI Guide before using it in a Guide Step. The dropdown shows all available guides in your organization. The guides can be created in the main dashboard under Guides.

[[goto:/dashboard/guides]]

**Shortcut via the Journey Wizard:** when creating a new journey with the Journey Wizard, you can choose to add a Guide Step as part of the generated journey. The wizard will either create a new AI Guide (with a name you pick, and optionally a knowledge base seeded from your uploaded document) or reuse an existing Guide. The resulting Guide Step behaves exactly like one you'd add manually — you can still change the selected Guide afterwards. See: journey-wizard.


### Step Assistant

Enable a mini AI helper that appears alongside the guide for additional support. You can activate the Step Assistant in other steps in the advanced settings of that step.

## How It Works

1. User reaches the Guide Step in their journey
2. The AI Guide appears in a chat interface
3. User can type questions
4. AI responds using knowledge from its knowledge base that you provided
5. Sources are cited when applicable
6. User can continue the conversation or proceed to the next step

## Language Settings

The AI Guide in a Guide Step responds in the language configured for your organization by default. You can override this behavior:

1. Open Journey Settings (click on the canvas background)
2. Enable "Override AI Guide language"
3. Select the desired language

The AI Guide will then respond in the selected language, and its greeting will be automatically generated in that language. This works with both base languages (English, Dutch, German, French, Spanish) and extended languages (Italian, Portuguese, Danish, Norwegian, Finnish, Swedish, Polish, Romanian, Turkish).

See: journey-settings, language-settings

## Best Practices

### Preparing Your Guide

Before using a Guide Step, ensure your AI Guide has:

- A well-populated knowledge base
- Clear personality and identity settings
- Appropriate AI instructions for the context

## Use Case examples

- **Training**: Answer employee questions during onboarding
- **Support**: Provide instant help within a customer journey
- **Education**: Explain complex topics in an interactive way
- **Tours**: Let users ask questions about exhibits or locations

## Related Features

- [[goto:/dashboard/guides]] - Create and manage AI Guides
- See: ai-guides-overview, guide-knowledge-base
