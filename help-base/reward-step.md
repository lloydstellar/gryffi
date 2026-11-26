---
feature_id: reward-step
related_features: [reward-tracking, journey-builder, journey-wizard]
---

# Reward step

A Reward Step gives participants a code when they reach it. A code is for example a coupon, a discount code or a gift card number. The codes are meant to be used in the real world, such as a free lunch in the staff canteen. Rewards motivate participants to start a journey and finish it.

![The settings of a Reward step: the reward title (2), the description (3) and where to redeem it (4)](images/reward-step/properties.en.webp)

1. The Reward step on the canvas.
2. Reward Title: the name of the reward participants see.
3. Description: what the reward is and how to use it.
4. Where to redeem: where participants can use their code.

## Overview

Click the Reward step (1) on the canvas to open its settings. On the What they see tab of the Reward step:

- **Title**: the title of the step
- **Reward Title** (2): the name of the reward
- **Description** (3): what the reward is
- **Where to redeem** (4): where the participant can use their code
- **Terms & Conditions**: the rules of the reward
- **Valid until**: the last day the code can be used. Leave it empty for no expiration.
- **Code Settings**: choose **Generate random codes** or **Use custom codes**

### Generate random codes

Gryffi makes a unique code for every participant who reaches the step. By default, everyone who reaches the step gets a reward.

- **Limit number of recipients**: tick this to give a reward only to the first participants who reach the step. Enter the number in **Maximum recipients**.
- **Code prefix**: optional text at the start of every code, for example "LUNCH-".

### Use custom codes

Enter your own codes, separated by commas or one per line. Each participant gets the next unused code from the list.

- **Claimed codes**: the codes participants already received. You cannot change them.
- **Unclaimed codes**: codes that have not been handed out yet. You can still remove them. A removed code is no longer handed out.
- **Add new codes**: add more codes to the list.
- **Maximum recipients**: optional. Only the first participants who reach the step get a reward. It cannot be higher than the number of codes you entered.

When codes have been claimed, some settings are locked. The maximum cannot be lower than the number of codes already claimed.

### What participants get

Gryffi sends a copy of the code to the participant's email address.

In a private journey, each participant gets one reward per journey. A participant who opens the step again sees the same code.

In a public journey, the participant first confirms their email address. Each email address gets one code.

When all codes are used or the maximum is reached, the next participant sees that all rewards have been handed out.

### Deleting a Reward Step

You cannot delete a Reward Step after participants have claimed codes from it. Gryffi shows how many codes were claimed. Take the journey offline instead. Claimed codes stay visible in Analytics.

## Analytics Reward Reports

![Rewards in Analytics: the Rewards tab (5) and a reward (6)](images/reward-step/analytics.en.webp)

5. The Rewards tab in Analytics.
6. A reward with the number of claimed and remaining codes, View codes and Download PDF.

In Analytics, open the Rewards tab (5). For each reward (6) you see the claimed and remaining codes. Click **View codes** to see who claimed which code, or **Download PDF** for a list.

Example: you give codes for a free lunch in the staff canteen. Give the PDF, or a printed copy, to the canteen staff. Then they know who gets a free lunch.

See: reward-tracking

## Added by the Journey Wizard

On the page "What goes in your journey?" of the Journey Wizard, tick **Reward**. The wizard then asks "Would you like to end with a reward?":

- **A voucher or discount code**: a Reward Step with a short title and description.
- **A completion certificate**: a Reward Step with certificate-style wording.
- **A simple thank-you message**: a Reward Step with a warm closing note.
- **Add a reward step (I'll fill it in later)**: a Reward Step with a neutral title and description that you fill in yourself.
- **No reward**: no Reward Step.

Every Reward Step from the wizard uses **Generate random codes**, so every participant who reaches it gets a code. The wizard never invents codes or dates. Open the Reward Step after the wizard is done and fill in the real details: your own codes if you have them, where to redeem, the valid-until date, the maximum number of recipients and the terms.

See: journey-wizard

## Related Features

- [[goto:/dashboard/journeys]] - Reward step management
- [[goto:/dashboard/analytics#rewards]] - Reward analytics
- See: reward-tracking, journey-builder, journey-wizard
