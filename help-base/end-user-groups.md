---
feature_id: end-user-groups
related_features: [end-user-management, invitations-overview]
---

# Participant Groups

Participant Groups allow you to organize your participants into logical collections for easier management and targeted invitations

![Groups on the Participants page: Create Group (1), a group (2) and Manage members (3)](images/end-user-groups/overview.en.webp)

1. Create Group: give the group a name and a description.
2. A group with its description and source.
3. Manage members: add participants to the group or remove them.

## Overview

Groups help you:

- Organize participants by department, location, or role
- Send journey invitations to entire groups

[[goto:/dashboard/participants#users]]

## Creating Groups

### Manual Creation

1. Go to Participants → Groups
2. Click "Create Group" (1)
3. Enter group details:
   - **Group Name**: Descriptive group name
   - **Description**: Purpose of the group
4. Click "Save"

## Adding Participants to Groups

### Individual Assignment

1. Go to a group (2)
2. Click the "Manage members" icon (3)
3. Select participants to add
4. Click on "Add Members"
5. Click "Close"


### Via Directory Sync

When syncing from Microsoft 365 or Google Workspace:
- Directory groups can map to Gryffi groups
- Group memberships sync automatically

### Via Gryffi API

Groups can be managed by our API
- List groups
- Create group
- Add members
- Remove members
- Remove group (only if empty)

## Using Groups

### Journey Invitations

Send invitations to entire groups:

1. Go to Invitations
2. Follow the invitation wizard step by step
3. In step 3 of the wizard you can go to the tab "Groups"
4. Choose one or more group(s)
5. Send invites

[[goto:/dashboard/invitations]]

## Group Management

### Editing Groups

- Change name or description
- Add/remove members

### Deleting Groups

When deleting a group:
- Members are NOT deleted
- Participants lose group association


## Related Features

- [[goto:/dashboard/participants#users]] - Manage groups
- [[goto:/dashboard/invitations]] - Send group invitations
- See: end-user-management, invitations-overview
