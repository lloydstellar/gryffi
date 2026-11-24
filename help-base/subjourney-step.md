---
feature_id: subjourney-step
related_features: [journey-builder, journey-settings, public-journeys]
---

# Sub-Journey Step

The Sub-Journey Step allows you to embed an entire published journey within another journey. This is perfect for creating modular, reusable content and reducing complexity in large journeys.

![The settings of a Sub-Journey step: Select journey to embed (2) and the embedded journey (3)](images/subjourney-step/properties.en.webp)

1. The Sub-Journey step on the canvas.
2. Select journey to embed: choose a published journey.
3. The embedded journey with its number of steps. It must stay published.

## Adding a Sub-Journey Step

In the column of step types on the left side of the builder, click **Sub-Journey** to add a Sub-Journey Step (1) to your canvas.

## Overview

Sub-Journey Steps enable you to:

- **Modular Content**: Break large journeys into smaller, manageable pieces
- **Reusability**: Use the same journey content in multiple parent journeys
- **Simplified Design**: Keep your journey canvas clean by nesting complex sections
- **Language Flexibility**: Sub-journeys can have their own language settings

## Properties

### What they see

| Property | Description |
|----------|-------------|
| **Title** | The title of this step (for maker reference only) |
| **Select Sub-Journey** | Choose which published journey to embed |

### Sub-Journey Selection

Choose the journey in **Select journey to embed** (2). Only **published** journeys from your organization can be selected as sub-journeys. The dropdown shows:

- Journey title
- Number of steps
- Cover image (if available)

The selected journey (3) is shown with its number of steps. It must stay published.

## How It Works

1. Participant reaches the Sub-Journey Step
2. They seamlessly enter the selected sub-journey
3. The interface language switches if the sub-journey has different language settings
4. The participant completes all steps in the sub-journey
5. Upon completion, they automatically return to the parent journey
6. Navigation continues to the next step after the Sub-Journey Step

**Note**: Participants experience this as one continuous journey - they don't see any transition screens or notices about entering/exiting sub-journeys.

## Progress Tracking

The progress bar shows combined progress across both the parent journey and any active sub-journey. This gives participants an accurate sense of their overall progress.

## Restrictions

### For Public Journeys

Public journeys can **only** use sub-journeys that are:
- Published
- Also public

This prevents private information from accidentally being exposed through a public journey.

### For Private Journeys

Private journeys can use any published journey as a sub-journey, whether public or private. Since the parent journey is private, all content remains protected.

### Protected Sub-Journeys

When a journey is used as a sub-journey in another journey, it becomes protected:

| Action | Allowed? |
|--------|----------|
| **Take offline** | No - must remove from parent journey first |
| **Move to Trash** | No - must remove from parent journey first |
| **Make Private** | No - must remove from parent journey first |
| **Edit Content** | Yes - changes reflect immediately |

This protection ensures participants don't encounter broken journeys.

## Best Practices

### When to Use Sub-Journeys

- **Onboarding modules**: Company policies, IT setup, team introductions as separate journeys
- **Certification paths**: Prerequisites as sub-journeys before main certification
- **Multi-language content**: Same journey structure, different language versions
- **Seasonal updates**: Embed time-sensitive content that can be easily swapped

### Design Tips

- Keep sub-journeys focused on a single topic
- Consider the combined length - don't overwhelm participants
- Test the full flow including all sub-journeys
- Document which journeys use which sub-journeys

## Circular Reference Prevention

Gryffi automatically prevents circular references. For example:

- Journey A cannot use Journey B as a sub-journey if Journey B already uses Journey A
- This check works through any depth of nesting

## Related Features

- [[goto:/dashboard/journeys]] - Create and manage journeys
- See: journey-builder, journey-settings, public-journeys
