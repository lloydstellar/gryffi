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

1. Go to System Settings → API
2. Click "Generate API Key"
3. **Copy the key immediately** (shown once)
4. After you stored the key, click: I have stored the key safely

### Key Properties

| Property | Description |
|----------|-------------|
| Created | When key was generated |
| Last Used | Recent activity |
| Status | Active/Inactive |

## Key Security

### Best Practices

- Store keys in environment variables
- Never commit keys to code repositories
- Use different keys for different applications
- Rotate keys periodically
- Delete unused keys

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

### View All Keys

See all organization API keys:
- Last used
- Status

### Revoke Key

Disable a key:
1. Click "Revoke Key"
3. Confirm action
4. Key stops working immediately

## Key Rotation

### Why Rotate

- Security best practice
- Suspected compromise
- Employee offboarding
- Policy compliance

### Rotation Process

1. Click Regenerate Key

## Troubleshooting

### "Invalid API Key"

- Verify key is correct
- Check key is active
- Verify key hasn't been revoked

## Related Features

- [[goto:/dashboard/system-settings#api]] - API settings
- See: api-access
