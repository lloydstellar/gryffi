---
feature_id: authentication
related_features: [login, two-factor-authentication, password-management, magic-links]
---

# Authentication

Authentication checks who you are before you get access to Gryffi. Makers and participants sign in in different ways.

## Overview

- Makers sign in with email address and password.
- Makers can turn on two-factor authentication: an extra 6-digit code by email.
- Participants open a journey with a magic link from their invitation email. They do not need a password.

## Makers: email and password

1. Enter your email address.
2. Enter your password.
3. Click **Sign in**.
4. If Gryffi asks for a code, enter the 6-digit code from your email and click **Verify**.

See: login

## Two-Factor Authentication

### Setup

1. Go to My account.
2. Find **Two-factor authentication** in the Security section.
3. Turn on the switch.

From now on, every time you sign in, Gryffi emails you a 6-digit code.

See: two-factor-authentication

### Using 2FA

1. Enter your email address and password.
2. Enter the 6-digit code from your email.
3. Click **Verify**.

The code works for 10 minutes.

## Security Features

### Protection against wrong passwords

| Wrong passwords | What happens |
|-----------------|--------------|
| 3 in 15 minutes | Wait 30 seconds. Gryffi also asks for a 6-digit code by email after the right password. |
| 5 in 15 minutes | Wait 5 minutes |
| 10 | The account is locked for 30 minutes |

### Password Requirements

A password has at least 8 characters. A longer password, or a sentence of several words, is safer.

### How long you stay signed in

You stay signed in while you use Gryffi. After 7 days without using Gryffi, you need to sign in again. When you change your password, your other devices are signed out within a minute.

## For Participants

### Participant Authentication

Participants open a journey with the magic link in their invitation email.

See: magic-links

### Public Journey Access

Anyone with the link can open a public journey without signing in. Gryffi asks for a name and email address before a form step, reward step or poll step.

See: public-journeys

## For Administrators

### Managing Makers

On the Makers page, an admin can deactivate a maker. A deactivated maker cannot sign in, and is signed out within a minute. Makers who forgot their password use **Forgot password?** on the login page themselves.

See: makers-management

## Troubleshooting

### Can't Log In

1. Check your email address.
2. Check your password. Passwords are case-sensitive.
3. Click **Forgot password?** on the login page.
4. Locked after 10 wrong passwords? Wait 30 minutes.

### No code in your inbox

1. Check your spam folder.
2. Click **Resend code**.

## Best Practices

- Use a strong password that you do not use elsewhere.
- Turn on two-factor authentication, especially for admins.
- Do not share your account.
- Sign out on shared devices.

## Related Features

- [[goto:/dashboard/settings]] - My account
- See: login, two-factor-authentication, password-management
