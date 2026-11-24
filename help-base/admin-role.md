---
feature_id: admin-role
related_features: [maker-roles, manager-role, editor-role, viewer-role, team-management]
---

# Admin Role

The Admin role has full access to all features in Gryffi, including organization settings, and team management.

## Overview

Admins can:

- Access all journeys and guides
- Manage all makers
- Configure organization settings
- Access all analytics and reports
- Configure integrations like participant syncs and Gryffi API

## Permissions

### Content Management

| Permission | Admin |
|------------|:-----:|
| Create journeys | Yes |
| Edit any journey | Yes |
| Delete any journey | Yes |
| Publish journeys | Yes |
| Create AI guides | Yes |
| Edit any guide | Yes |
| Delete any guide | Yes |

### Managing Makers and Participants

| Permission | Admin |
|------------|:-----:|
| Invite team members | Yes |
| Remove team members | Yes |
| Change member roles | Yes |
| Manage participants | Yes |
| Manage groups | Yes |
| Send invitations | Yes |

### Settings & Configuration

| Permission | Admin |
|------------|:-----:|
| Organization settings | Yes |
| API keys | Yes |
| Integrations | Yes |
| Custom themes | Yes |
| Email templates | Yes |

### Analytics & Reports

| Permission | Admin |
|------------|:-----:|
| View all analytics | Yes |
| Export PDF raports | Yes |
| View audit logs | Yes |
| Access all reports | Yes |

## When to Assign Admin Role

Assign Admin role to:

- Organization owners
- IT administrators
- Department heads who need full control

## Best Practices

### Security
- Limit number of admins
- Require 2FA for all admins
- Review admin list regularly
- Audit admin actions periodically

### Delegation
- Use Manager role for content oversight
- Use Editor role for content creation
- Only use Admin for those needing full access

## Comparison with Other Roles

| Capability | Admin | Manager | Editor | Viewer |
|------------|:-----:|:-------:|:------:|:------:|
| Full settings access | Yes | No | No | No |
| Makers management | Yes | Limited | No | No |
| Create content | Yes | Yes | Yes | No |
| View analytics | Yes | Yes | Own | Limited |

## Related Features

- [[goto:/dashboard/team]] - Makers management
- See: maker-roles, manager-role, editor-role, viewer-role
