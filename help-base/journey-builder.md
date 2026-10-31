---
feature_id: journey-builder
related_features: [journey-wizard, space-step, guide-step, content-step, challenge-step, form-step, poll-step, reward-step, journey-settings, journey-flow, copy-translate]
---

# Journey Builder

The Journey Builder is Gryffi's visual editor for creating interactive journeys. It uses a node-based canvas where you can add steps, connect them with paths, and create branching experiences.

![The journey builder with the step toolbar (1), a step (2), a path label (3), Preview (4) and Save (5)](images/journey-builder/canvas.en.webp)

1. The step toolbar: click Space, Guide, Content, Challenge, Form, Poll, Reward or Sub to add that step to the canvas.
2. A step on the canvas. Click it to open its properties. The small flag marks the start step.
3. A path label: the text of the button end users click to go to the next step.
4. Preview: go through the journey as an end user would.
5. Save: store your changes.

## Overview

The Journey Builder provides a drag-and-drop interface for designing journeys. Each journey consists of:

- **Steps**: Individual content blocks (spaces, guides, challenges, etc.)
- **Paths**: Connections between steps that define the flow
- **Journey Settings**: Journey-wide configuration options
- **Step Settings**: Every step has its own settings. Click on a step to edit the settings of the step.

[[goto:/dashboard/journeys]]

## The Canvas

The main canvas area shows all steps in your journey as cards. You can:

- **Pan**: Click and drag on empty space to move around
- **Zoom**: Use scroll wheel or zoom controls
- **Select**: Click on a step to select it and view properties
- **Drag**: Move steps to organize your layout
- **Connect**: Draw paths between steps using connection ports

## Adding a Step

1. Click a step type in the toolbar (1) at the top of the builder. The new step appears on the canvas.
2. Drag the step to the place you want.
3. Click the step (2) to fill in its properties.
4. Connect it to the step before and after it: drag from a dot on the edge of one step to a dot on the other step (see Creating Connections).

## Step Types

Add steps using the toolbar buttons. Available step types:

| Step Type | Icon | Purpose |
|-----------|------|---------|
| Space | 🏠 | Location or scene with image/panorama |
| Guide | 🤖 | AI-powered conversational assistant |
| Content | 📄 | Text, video, or rich content |
| Challenge | ❓ | Quiz with multiple choice questions |
| Form | 📝 | Data collection form |
| Poll | 📊 | Single-question survey |
| Reward | 🎁 | Coupon or reward code |

## Properties Panel

![The properties panel of a selected step, with Preview from this step (7) and the Basic and Advanced tabs (8)](images/journey-builder/step-panel.en.webp)

6. The selected step on the canvas.
7. Preview from this step: start the preview at this step instead of at the beginning.
8. The Basic and Advanced tabs with the settings of the step.

When you select a step (6), the Properties Panel appears on the right side. Click **Preview from this step** (7) to start the preview at this step instead of at the beginning. The panel contains the Basic and Advanced tabs (8):

### Basic Tab
- Step title and description
- Type-specific settings (varies by step type)
- Preview of how the step will look

### Advanced Tab
- Step pacing (immediate, delayed, scheduled)
- Step assistant (mini AI helper)

## Toolbar Actions

The toolbar at the top provides:

- **Add Step Buttons** (1): Quick access to create each step type
- **Journey Settings**: Configure title, description, flow
- **Preview** (4): Test your journey before publishing
- **Undo/Redo**: Revert or restore changes
- **Save** (5): Don't forget to save your work

## Creating Connections

To connect steps:

1. The connection ports are the four dots on every side of the step box
2. Click and drag from an output port
3. Release on another step's input port
4. The path is created automatically in that direction
5. The path label (3) is the text of the button end users click to go to the next step


## Saving

Changes are saved automatically. You'll see a "Saving..." indicator when changes are being persisted, and "Saved" when complete.

## Starting From a Template

If you don't want to begin with a completely empty canvas, the Journey Wizard can generate a starting point for you. When you click **Create journey** on the Journeys page, you get a choice between:

- **Start with the Wizard** — a short questionnaire that produces a draft journey with steps, paths, texts and optionally an AI Guide
- **Start with a blank canvas** — opens the regular empty builder

The wizard is recommended for non-technical makers or when you want a quick first version to iterate on. After the wizard finishes you land in the regular builder, where every step can still be edited, re-ordered, deleted or extended. See: journey-wizard.

## Related Features

- [[goto:/dashboard/journeys]] - Journey list
- See: journey-wizard for a guided way to generate a starting journey
- Learn about each step type in their dedicated help sections
