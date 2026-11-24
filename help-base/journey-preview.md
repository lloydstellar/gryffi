---
feature_id: journey-preview
related_features: [journey-builder, journey-publishing, journey-settings, language-settings]
---

# Journey Preview

Journey Preview allows you to experience your journey exactly as participants will see it before publishing.

![The preview of a journey: the progress bar (1), the path buttons (2) and close (3)](images/journey-preview/preview.en.webp)

1. The progress bar shows how far you are in the journey.
2. The buttons take you to the next step, as they would for a participant.
3. Close the preview and go back to the builder.

## Overview

Preview enables:

- Testing journey flow
- Verifying content display
- Checking step behavior
- Testing on different devices
- Checking what participants experience

## Starting Preview

### From Builder

1. Open journey in builder
2. Click "Preview" button in toolbar
3. Journey opens in preview

### From Journey overview

You can also start a preview from the Journey page. Click on the three dots and select "Preview". The preview of this journey will start instantly from the start

## Preview Features

### Navigation

- Navigate through steps with the buttons (2)
- Access all paths
- See how far you are in the progress bar (1)
- Click close (3) to leave the preview and go back to the builder

### Interactions

Test all interactive elements:
- Form inputs
- Quiz questions
- Poll voting
- Button clicks
- Navigation choices

### Language Testing

Preview mode respects your journey language settings:
- If you have set a journey language override, the preview will display in that language
- If you have set an AI Guide language override, the AI Guide will respond in that language
- This allows you to verify translations before publishing

To test different languages:
1. Set the desired language override in Journey Settings
2. Start Preview mode
3. Verify interface elements display correctly
4. Test AI Guide responses in the selected language

See: journey-settings, language-settings

## Preview vs Production

### Differences

| Aspect | Preview | Production |
|--------|---------|------------|
| Data saved | No | Yes |
| Analytics | No | Yes |
| Rewards given | No | Yes |
| Progress persisted | No | Yes |
| Form notification email sent | Yes | Yes |

When you submit a Form Step in preview, the notification email is sent to the configured recipient so you can verify it. Preview submissions are not stored in the Analytics Forms tab. See: form-step, form-submissions

## Participant Perspective

Consider:
- Is flow clear?
- Is content readable?
- Are instructions helpful?
- Is timing appropriate?

## Troubleshooting

### Preview Not Loading

- Check browser console
- Clear browser cache
- Try different browser
- Check that the builder shows "All changes saved"

### Content Missing

- Wait until the builder shows "All changes saved"
- Refresh preview
- Check step configuration

## Related Features

- See: journey-builder, journey-publishing
