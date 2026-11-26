---
feature_id: invitations-overview
related_features: [invitation-options, magic-links, end-user-management, end-user-groups]
---

# Invitations Overview

The Invitations feature allows you to invite participants and participant groups to journeys with a magic link in an email with personalized messages.

![Sending invitations: the four wizard steps (1), the journey (2) and Next (3)](images/invitations-overview/send-form.en.webp)

1. The four steps of the wizard: Select Journey, Set Options, Select Participants and Review & Send.
2. Choose the journey. Only published journeys are listed.
3. Next: go to the options of the invitation.
![The list of sent invitations: the status filter (4), the status of an invitation (5) and Send again (6)](images/invitations-overview/sent-list.en.webp)

4. Filter the list by status: Pending, Active, Completed or Expired.
5. The status of each invitation.
6. Send again: emails the invitation once more. **Revoke** next to it makes the link stop working.

## Overview

Invitations help you:

- Tell participants about available journeys
- Track who has been invited
- See the status of each invitation
- Send an automatic reminder to participants who have not finished

[[goto:/dashboard/invitations]]

## Sending Invitations

### Invitation Wizard

The wizard has four steps (1):

1. Select journey: Select a private published journey (2). You cannot select drafts or public journeys. Click **Next** (3) to go to the options.
2. Set options: Give options about when a journey magic link expires. Also set how often the participant can do the journey and whether Gryffi sends a reminder.
3. Select participants: Select one or more participants or one or more groups.
4. Review & Send: Review what invitation emails you are sending and to who.

Only Admins and Journey Managers can send invitations. Other makers can view the list of sent invitations.

Each participant can have one open invitation per journey. If a participant already has a Pending or Active invitation for the journey, Gryffi skips them and sends no second invitation.

### Send it to yourself

Before you invite colleagues, you can send a journey to yourself. You find **Send it to yourself** on the last screen of the Journey Wizard and in the **Get started** card on the Dashboard.

One click does three things:

1. Gryffi runs the same check as the **Publish** button and publishes the journey if it is still a draft. Only people you invite can open it.
2. You are added as a participant, with your own email address.
3. You get the invitation email with a personal link, in the language of the journey. The link works for 14 days and you can use it more than once, for example after you change something.

If you already have an open invitation for that journey, Gryffi does not send a new one and tells you to look in your inbox. Only Admins and Journey Managers can use **Send it to yourself**, because it publishes the journey.

### Send invitation through the API

You can also use our Gryffi API to send invitations. Set up the API on the Organization page, tab API.

### Sent Invitations

The list of sent invitations shows the status of each invitation (5). Use the status filter (4) to show only Pending, Active, Completed or Expired invitations. A revoked invitation has the status Revoked.

For an invitation that is not completed, **Send again** (6) emails the invitation to the participant once more. It is the same link, and it stays valid until the original end date. You can send an invitation again at most once every 10 minutes.

**Revoke** makes the link stop working. The participant then sees a message that the invitation is no longer valid. Only Admins and Journey Managers can send again or revoke.

Completed and expired invitations are removed after 1 year, together with the progress made with them.

## Related Features

- [[goto:/dashboard/invitations]] - Manage invitations
- [[goto:/dashboard/invitations]] - Send new invitation

See: invitation-options, magic-links, end-user-management, end-user-groups
