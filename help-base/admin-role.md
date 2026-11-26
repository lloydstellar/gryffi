---
feature_id: admin-role
related_features: [maker-roles, journeymanager-role, editor-role, viewer-role, makers-management]
---

# Admin Role

The Admin role has full access to Gryffi. Admins also manage makers, participants and the settings of the organization.

## Overview

Admins can:

- Build, publish and delete all journeys and AI guides
- Invite makers, change their role and delete their accounts
- Add participants and groups, and link Microsoft 365 or Google Workspace
- Change the settings on the **Organization** page, such as the API key and themes
- Open Analytics and download reports
- Delete the results of deleted journeys and steps, and archived polls

## Permissions

### Journeys and AI guides

| Permission | Admin |
|------------|:-----:|
| Create and edit journeys | Yes |
| Publish journeys and take them offline | Yes |
| Move journeys to the trash, restore them, delete them for good | Yes |
| Create and edit AI guides | Yes |
| Move AI guides to the trash, restore them, delete them for good | Yes |

### Makers and participants

| Permission | Admin |
|------------|:-----:|
| Invite makers | Yes |
| Delete maker accounts | Yes |
| Change the role of makers | Yes |
| Add, edit and delete participants | Yes |
| Manage groups | Yes |
| Link Microsoft 365 or Google Workspace | Yes |
| Send invitations to participants | Yes |

Only admins see **Participants** in the sidebar.

### Organization page

| Permission | Admin |
|------------|:-----:|
| Organization settings | Yes |
| API key | Yes |
| Create, edit, activate and delete themes | Yes |

### Analytics and reports

| Permission | Admin |
|------------|:-----:|
| Open Analytics, including Forms | Yes |
| Preview and download PDF reports | Yes |
| Delete results of deleted journeys and steps | Yes |
| Delete archived polls | Yes |

## When to Give the Admin Role

Give the Admin role to:

- Organization owners
- IT administrators
- Department heads who need full control

## Best Practices

### Security
- Keep the number of admins small.
- Ask every admin to turn on two-factor authentication in **My account**.
- Check the list of admins regularly.

### Delegation
- Use the Journey Manager role for people who publish journeys and invite participants.
- Use the Editor role for people who build journeys.
- Only give the Admin role to people who need full access.

An organization always keeps at least one admin.

## Comparison with Other Roles

| Capability | Admin | Journey Manager | Editor | Viewer |
|------------|:-----:|:---------------:|:------:|:------:|
| Organization page | Yes | No | No | No |
| Manage makers | Yes | View the list | View the list | No |
| Manage participants and groups | Yes | No | No | No |
| Publish and send invitations | Yes | Yes | No | No |
| Create and edit content | Yes | Yes | Yes | No |
| Open Analytics | Yes | Yes | Yes | Yes |
| Delete results of deleted journeys and steps | Yes | No | No | No |

## Related Features

- [[goto:/dashboard/team]] - Makers management
- See: maker-roles, journeymanager-role, editor-role, viewer-role, two-factor-authentication
