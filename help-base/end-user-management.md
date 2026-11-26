---
feature_id: end-user-management
related_features: [end-user-groups, csv-import, manual-user-entry, microsoft-365-sync, google-workspace-sync, invitations-overview]
---

# Participant Management

Participant Management allows you to add, organize, and manage the people who participate in your journeys.

![Participants on the Participants page: ways to add participants (1), the form to add one (2), search (3) and a participant (4)](images/end-user-management/overview.en.webp)

1. Four ways to add participants: Manual Entry, CSV/Excel Import, Microsoft 365 and Google Workspace.
2. Add a new participant by first name, last name and email address.
3. Search by name or email address.
4. A participant with their groups and where they come from (Source).

## Overview

Participants are the people who follow your journeys. You can:

- Add participants manually, via spreadsheet import or sync with Microsoft 365 or Google Workspace
- Organize participants into groups

Only admins see Participants in the menu and can open this page.

[[goto:/dashboard/participants#users]]

## Participants vs Makers

| Participants | Makers |
|-----------|--------|
| Experience journeys | Create journeys |
| Complete steps and quizzes | Build and edit content |
| Receive rewards | Manage participants and settings |
| No access to builder | Access to the dashboard, depending on their role |
| No password: they open a journey with the magic link in their email | Log in to Gryffi with email and password |

## Adding Participants

### Manual Addition

1. Go to Participants in the menu
2. Click "Manual Entry" (1)
3. Enter the participant's details (2). All three fields are required:
   - First Name
   - Last Name
   - Email Address
4. Click "Add participant"

See: manual-user-entry

### Bulk Import (CSV)

Upload many participants at once with a spreadsheet file. The file has three columns: first name, last name and email address.

[[goto:/dashboard/participants#users/csv]]

See: csv-import

### Directory Sync

Import participants automatically from:
- Microsoft 365
- Google Workspace

See: microsoft-365-sync, google-workspace-sync

## Participant Profile Fields

### Standard Fields

| Field | Description |
|-------|-------------|
| **First Name** | The participant's first name (required) |
| **Last Name** | The participant's last name (required) |
| **Email Address** | Identifies the participant. Each email address can be used once in your organization (required) |

In the list, each participant (4) shows their groups and where they come from (Source): Manual, CSV Import, Microsoft, Google or API. Use search (3) to find a participant by name or email address.

[[goto:/dashboard/participants#users]]

## Editing and Deleting Participants

You can edit or delete participants with the source Manual or CSV Import. Use the pencil or trash icon in their row.

Participants from Microsoft 365 or Google Workspace cannot be edited or deleted here. Change them in your directory. The next sync updates Gryffi.

### What deleting removes

Deleting a participant also deletes their invitations, their progress in journeys and their form submissions. Their results are no longer in Analytics. This cannot be undone. The same happens when a directory sync removes a participant.

## Groups

Put participants in groups so you can invite them together.

See: end-user-groups

## Privacy & Compliance

### Data Handling
- Admins can download all organization data, including a spreadsheet of participants, under Organization, tab General, Data Export.

## Related Features

- [[goto:/dashboard/participants#users/manual]] - Participant list
- [[goto:/dashboard/participants#users/csv]] - CSV import
- [[goto:/dashboard/participants#users/microsoft]] - Directory sync Microsoft
- [[goto:/dashboard/participants#users/google]] - Directory sync Google

See: end-user-groups, csv-import, manual-user-entry
