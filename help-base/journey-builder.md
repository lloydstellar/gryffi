---
feature_id: journey-builder
related_features: [journey-wizard, space-step, guide-step, content-step, challenge-step, form-step, poll-step, reward-step, journey-settings, step-pacing, copy-translate]
---

# Journey Builder

The Journey Builder is Gryffi's visual editor for creating interactive journeys. It uses a canvas where you can add steps, link them, and create branching experiences.

![The journey builder with the step types (1), a step (2), a button text (3), Preview (4) and the save status (5)](images/journey-builder/canvas.en.webp)

1. The step types, in a column on the left side of the canvas: click Space, AI guide, Content, Quiz, Form, Poll, Reward or Sub-Journey to add that step to the canvas.
2. A step on the canvas. Click it to open its properties. The small flag marks the start step.
3. A button text: the text of the button participants click to go to the next step.
4. Preview: go through the journey as a participant would.
5. The save status: the builder saves your changes by itself and shows "All changes saved".

## Overview

The Journey Builder provides a drag-and-drop interface for designing journeys. Each journey consists of:

- **Steps**: Individual content blocks (spaces, guides, quizzes, etc.)
- **Links**: Connections between steps that define the flow
- **Journey Settings**: Journey-wide settings, such as the title, the start and end steps, the language and automations
- **Step Settings**: Every step has its own settings. Click on a step to edit the settings of the step.

[[goto:/dashboard/journeys]]

## The Canvas

The main canvas area shows all steps in your journey as cards. You can:

- **Pan**: Click and drag on empty space to move around
- **Zoom**: Use the scroll wheel or the zoom controls at the bottom right. The first button there shows all steps at once.
- **Select**: Click on a step to select it and view properties
- **Drag**: Move steps to organize your layout
- **Link**: Draw links between steps using the dots on the edge of a step

Click on empty space on the canvas to open the Journey Settings.

You can also use the keyboard. Select a step and press Enter to open it. Use the arrow keys to move it, and hold Shift to move it further. Press Delete to remove it.

## Adding a Step

1. Click a step type in the column on the left side of the canvas (1).
2. The new step appears after the selected step. If no step is selected, it appears after the step furthest to the right.
3. Gryffi links the new step to that step for you. It does not do this when that step already links to a next step, or when it is an end step.
4. Click the step (2) to fill in its properties.

The first step you add becomes the start step. To make a branch, link a step to more than one next step (see Creating Links).

## Step Types

Add steps with the step types in the column on the left. Each step type shows its name and a short description. Available step types:

| Step Type | Purpose |
|-----------|---------|
| Space | Photo, 360° photo or floor plan |
| AI guide | Participants ask questions to an AI guide |
| Content | Text, video or image |
| Quiz | Questions with a right answer |
| Form | Collect answers or files |
| Poll | One question, no right answer |
| Reward | A reward, code or certificate |
| Sub-Journey | Another journey inside this one |

## Properties Panel

![The properties panel of a selected step, with Preview from this step (7) and the What they see and How it works tabs (8)](images/journey-builder/step-panel.en.webp)

6. The selected step on the canvas.
7. Preview from this step: start the preview at this step instead of at the beginning.
8. The What they see and How it works tabs with the settings of the step.

When you select a step (6), the Properties Panel appears on the right side. Click **Preview from this step** (7) to start the preview at this step instead of at the beginning. The panel contains the What they see and How it works tabs (8). At the bottom of the panel, **Delete step** removes the step. The results of a deleted step stay in Analytics. Undo brings the step back, with its results.

### What they see
- Step title
- The content of the step (varies by step type)
- For space, AI guide and content steps: the current pacing, with a link to change it on the How it works tab

### How it works
What this tab shows depends on the step type:
- Pacing: when participants can continue (space, AI guide and content steps)
- Form Requirement and the confirmation message (form steps)
- Quiz settings, such as the passing score, retakes and the pass and fail messages (quiz steps)
- Resetting the poll results (poll steps)
- Guide in this step: an AI guide that helps participants during this step (all step types except AI guide)

## Toolbar Actions

The toolbar at the top provides:

- **Help**: Open help for the builder. You can also press ?.
- **Journey Settings** (gear icon): Set the title, description, flow, language and automations
- **Undo/Redo**: Revert or restore changes. You can also press Ctrl+Z (Cmd+Z on a Mac) to undo, and Ctrl+Shift+Z or Ctrl+Y to redo.
- **Save status** (5): Shows when your changes are saved
- **Preview** (4): Test your journey before publishing, on a phone or a computer (see journey-preview)
- **Publish** or **Take offline**: Only for makers with the role Admin or Journey Manager
- **Public Link**: Only on a public journey. Copy the link you can share.

## Creating Links

To link steps:

1. The dots on every side of the step box are where links start and end
2. Click and drag from a dot on one step
3. Release on a dot of another step
4. The link is created automatically in that direction
5. The button text (3) is the text of the button participants click to go to the next step

You can also click **Add a choice** in the panel of a step. Pick the step to go to and type the button text. A step with more than one choice is a branch: the participant picks a path by clicking one of the buttons.

## Saving

The builder saves your changes by itself. There is no Save button. You'll see "Saving..." while changes are being stored, and "All changes saved" when they are done.

## Starting From a Template

If you don't want to begin with a completely empty canvas, the Journey Wizard can generate a starting point for you. When you click **Create Journey** on the Journeys page, you get a choice between:

- **Start with the Wizard**: a few questions that produce a draft journey with steps, links, texts and optionally an AI guide
- **Start with a blank canvas**: opens the regular empty builder

The wizard is recommended for non-technical makers or when you want a quick first version to iterate on. After the wizard finishes you can open the journey in the regular builder, where every step can still be edited, re-ordered, deleted or extended.

See: journey-wizard

## Related Features

- [[goto:/dashboard/journeys]] - Journey list
- See: journey-wizard, journey-settings, step-pacing, journey-preview, public-journeys, analytics-overview
- Learn about each step type in their dedicated help sections
