---
feature_id: microsoft-365-sync
related_features: [end-user-management, end-user-groups, google-workspace-sync]
---

# Microsoft 365 Sync

Microsoft 365 Sync automatically imports and keeps your end users synchronized with your Microsoft 365 (Azure AD) directory.

[[show:connect]]
[[show:connected]]

## Overview

With Microsoft 365 Sync, you can:

- Automatically import users from Azure AD
- Keep user data synchronized
- Sync Microsoft 365 groups to Gryffi
- Reduce manual user management

## Prerequisites

Before connecting:

1. **Global Administrator** or **Application Administrator** role in Azure AD
2. **Admin role** in Gryffi organization

## Connecting Microsoft 365

### Setup your Microsoft environment first

Setup instructions:

1. Grant Admin Consent
When you click Connect, you will be redirected to Microsoft to grant admin consent for your organization. This allows Gryffi to read users and groups.

2.Sign in as Administrator
Sign in with a Microsoft 365 Global Administrator account or an account with permissions to grant admin consent.

3. Accept Permissions
Review and accept the requested permissions: User.Read.All (read all users), Group.Read.All (read all groups), and GroupMember.Read.All (read group memberships).

Important:
Only a Global Administrator or Privileged Role Administrator can grant admin consent. If you're not the admin, please share this page with them.

### Step 1: Navigate to Sync Settings

[[goto:/dashboard/system-settings#users/microsoft]]

### Step 2: Click "Connect Microsoft 365"
You'll be redirected to Microsoft login.

### Step 3: Sign In
Log in with your Microsoft 365 administrator account.

### Step 4: Configure Sync Options
After connecting, configure what to sync. You can select groups to sync their members or groups.

## Sync Configuration

### User Sync Options

| Option | Description |
|--------|-------------|
| **Sync All Users** | Import entire directory |
| **Selected Groups** | Only sync specific groups (you can not use nested groups) |

### Sync Schedule

The sync is run every 15 minutes

## Troubleshooting

### "Connection Failed" Error
- Verify admin permissions in Azure AD
- Check if conditional access policies block the connection
- Try reconnecting with a different admin account

### "Users Not Syncing"
- Verify group selections include the users
- Check domain filters aren't excluding users
- Force a manual sync

### "Permission Denied"
- Re-authorize the connection
- Check Azure AD app registration is active

## Security Considerations

### Data Access
- Gryffi only reads user data, never writes to Azure AD
- No password data is transferred

### Revoking Access
To disconnect:
1. Go to System Settings → Users → Microsoft 365
2. Click "Disconnect Microsoft 365"

## Related Features

- [[goto:/dashboard/system-settings#users/microsoft]] - Sync settings
- [[goto:/dashboard/system-settings#users/microsoft]] - View synced users
- See: end-user-management, google-workspace-sync
