---
feature_id: google-workspace-sync
related_features: [end-user-management, end-user-groups, microsoft-365-sync]
---

# Google Workspace Sync

Google Workspace Sync automatically imports and synchronizes your end users from Google Workspace (formerly G Suite).

[[show:connect]]

## Overview

With Google Workspace Sync, you can:

- Automatically import end users from Google directory
- Keep end user information synchronized
- Sync Google Groups to Gryffi
- Eliminate manual end user management

## Prerequisites

Before connecting:

1. **Super Admin** role in Google Workspace
2. **Admin role** in Gryffi organization

## Connecting Google Workspace

### Step 1: Navigate to Sync Settings

[[goto:/dashboard/system-settings#users/google]]

### Step 2: First make your Google Workspace ready for the sync
Before connecting, your Google Workspace administrator needs to authorize this application.

1. Open Google Admin Console
Go to admin.google.com and sign in with your administrator account.

2. Navigate to API Controls
Go to Security → Access and data control → API controls → Domain-wide delegation.

3. Add API Client
Click 'Add new' and enter the following details:

Client ID: 
626812501063-6auk39empidnrmcouli99ob7of7cagji.apps.googleusercontent.com

OAuth Scopes: 
https://www.googleapis.com/auth/admin.directory.user.readonly, https://www.googleapis.com/auth/admin.directory.group.readonly
4. Authorize
Click 'Authorize' to save the settings. You can now connect your Google Workspace account.

Important
Only a Google Workspace Super Admin can configure domain-wide delegation. If you're not the admin, please share these instructions with them.

### Step 3: Click "Connect With Google"
You'll be redirected to Google sign-in.

### Step 4: Sign In
Log in with your Google Workspace super admin account.

### Step 5: Grant Permissions
Approve all the permissions for Gryffi:

### Step 6: Configure Sync Options
After connecting, configure your sync preferences. Like what groups or end users to sync.

## Sync Configuration

### User Sync Options

| Option | Description |
|--------|-------------|
| **Sync All Users** | Import entire organization |
| **Google Groups** | Sync members of specific groups |

### Group Sync Options

| Option | Description |
|--------|-------------|
| **Sync Groups** | Import Google Groups |
| **Group Members** | Include members of selected groups |

### Sync Schedule

Sync is scheduled every 15 minutes. You can also manually sync if you don't want to wait.

## Related Features

- [[goto:/dashboard/system-settings#users/google]] - Sync settings
- [[goto:/dashboard/system-settings#users/google]] - View synced users
- See: end-user-management, microsoft-365-sync
