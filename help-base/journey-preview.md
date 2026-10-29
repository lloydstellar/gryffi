---
feature_id: journey-preview
related_features: [journey-builder, journey-publishing, journey-settings, language-settings]
---

# Journey Preview

Journey Preview allows you to experience your journey exactly as end users will see it before publishing.

## Overview

Preview enables:

- Testing journey flow
- Verifying content display
- Checking step behavior
- Testing on different devices
- Validating user experience

## Starting Preview

### From Builder

1. Open journey in builder
2. Click "Preview" button in toolbar
3. Journey opens in preview

### From Journey overview

You can also start a preview from the Journey page. Click on the three dots and select "Preview". The preview of this journey will start instantly from the start

## Preview Features

### Navigation

- Navigate through steps
- Access all paths

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


## User Perspective

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
- Verify journey saved

### Content Missing

- Save journey first
- Refresh preview
- Check step configuration

## Related Features

- See: journey-builder, journey-publishing
