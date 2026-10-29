---
feature_id: authentication
related_features: [login, two-factor-authentication, password-reset, magic-links]
---

# Authentication

Authentication secures access to Gryffi by verifying user identity through passwords and two-factor authentication.

## Overview

Authentication methods:

- Email/password login
- Two-factor authentication (2FA)
- Magic links

## Login Methods

### Email/Password

Standard login:
1. Enter registered email
2. Enter password
3. Click "Sign In"
4. Complete 2FA if enabled


## Two-Factor Authentication

### Setup

Enable 2FA in account settings:
1. Go to Settings → Security
2. Click "Enable 2FA"
3. Now every time you login you get email verification

See: two-factor-authentication

### Using 2FA

Login with 2FA:
1. Enter email and password
2. Enter one time passcode from email
3. Access granted

## Security Features

### Account Protection

| Feature | Description |
|---------|-------------|
| Failed Login Lockout | Temporary lock after failed attempts |
| Session Management | Control active sessions |

### Password Requirements

| Requirement | Standard |
|-------------|----------|
| Minimum Length | 8 characters |
| Uppercase | At least 1 |
| Numbers | At least 1 |
| Special Characters | At least 1 |

## Session Management

## For End Users

### End User Authentication

End users can authenticate via:
- Magic links

### Public Journey Access

Public journeys may not require authentication:
- Anonymous access
- Identification for form steps, reward steps and poll steps

## For Administrators

### User Management

| Action | Description |
|--------|-------------|
| Reset Password | Send reset email |
| Disable Account | Prevent login |
| Force Logout | End all sessions |

## Troubleshooting

### Can't Log In

1. Verify email is correct
2. Check password (case-sensitive)
3. Try password reset
4. Contact your admin if locked out

### 2FA Issues

1. Check your spam folder

## Best Practices

### For Users

- Use strong, unique passwords
- Enable two-factor authentication
- Don't share credentials
- Log out on shared devices

### For Administrators

- Use 2FA for admins
- Use strong, unique passwords
- Don't share credentials
- Log out on shared devices

## Related Features

- [[goto:/login]] - Login page
- [[goto:/dashboard/settings]] - Security settings
- See: login, two-factor-authentication, password-reset
