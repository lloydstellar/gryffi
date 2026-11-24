---
feature_id: api-keys
related_features: [api-access]
---

# API Keys

API Keys are secure tokens that authenticate your applications and integrations when accessing the Gryffi API.

## Overview

API keys enable:

- Programmatic access to Gryffi
- Secure authentication
- Access control

[[goto:/dashboard/system-settings#api]]

## Creating API Keys

### Generate New Key

1. Go to Organization → API
2. Click "Generate API Key"
3. **Copy the key immediately** (shown once)
4. After you stored the key, click: I have stored the key safely

### Key Properties

| Property | Description |
|----------|-------------|
| Created | When the key was generated |
| Last Used | When an application last used the key |

An organization has one API key. All applications that use the API share it.

## Key Security

### Best Practices

- Store keys in environment variables
- Never commit keys to code repositories
- Rotate the key periodically
- Revoke the key when no application uses it any more

### Key Storage

Safe storage methods:
- Environment variables
- Secret management services (AWS Secrets, Vault)
- Encrypted configuration files
- Never in plain text code

### Example Usage

.env file
```bash
# Environment variable
export GRYFFI_API_KEY="your-key-here"
```

```javascript
// In code (reading from environment)
const apiKey = process.env.GRYFFI_API_KEY;
```

## Managing Keys

### Key details

Organization → API shows when the key was created and when it was last used.

### Revoke Key

Disable the key:
1. Click "Revoke Key"
2. Confirm
3. The key stops working immediately

## Key Rotation

### Why Rotate

- Security best practice
- Suspected compromise
- Employee offboarding
- Policy compliance

### Rotation Process

Click "Regenerate Key". The old key stops working at once, so put the new key in every application that uses the API.

## Troubleshooting

### "Invalid API Key"

- Verify key is correct
- Check key is active
- Verify key hasn't been revoked

## Related Features

- [[goto:/dashboard/system-settings#api]] - API settings
- See: api-access
