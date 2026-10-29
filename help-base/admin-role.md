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
- Configure integrations like end user syncs and Gryffi API

## Permissions

### Content Management

| Permission | Admin |
|------------|:-----:|
| Create journeys | ✅ |
| Edit any journey | ✅ |
| Delete any journey | ✅ |
| Publish journeys | ✅ |
| Create AI guides | ✅ |
| Edit any guide | ✅ |
| Delete any guide | ✅ |

### User Management

| Permission | Admin |
|------------|:-----:|
| Invite team members | ✅ |
| Remove team members | ✅ |
| Change member roles | ✅ |
| Manage end users | ✅ |
| Manage groups | ✅ |
| Send invitations | ✅ |

### Settings & Configuration

| Permission | Admin |
|------------|:-----:|
| Organization settings | ✅ |
| API keys | ✅ |
| Integrations | ✅ |
| Custom themes | ✅ |
| Email templates | ✅ |

### Analytics & Reports

| Permission | Admin |
|------------|:-----:|
| View all analytics | ✅ |
| Export PDF raports | ✅ |
| View audit logs | ✅ |
| Access all reports | ✅ |

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
| Full settings access | ✅ | ❌ | ❌ | ❌ |
| Makers management | ✅ | Limited | ❌ | ❌ |
| Create content | ✅ | ✅ | ✅ | ❌ |
| View analytics | ✅ | ✅ | Own | Limited |

## Related Features

- [[goto:/dashboard/team]] - Makers management
- See: maker-roles, manager-role, editor-role, viewer-role
