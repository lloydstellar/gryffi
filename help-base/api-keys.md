---
feature_id: api-keys
related_features: [api-access]
---

# API Keys

An API key lets another system, such as an HR system, use the Gryffi API on behalf of your organization. Only admins can generate, regenerate or revoke the key.

## Overview

- An organization has one API key. All applications that use the API share it.
- The key starts with `grf_`.
- The key gives access to every API endpoint for your whole organization. You cannot limit a key to some endpoints.

[[goto:/dashboard/system-settings#api]]

## Creating API Keys

### Generate New Key

1. Go to Organization and open the **API** tab.
2. Click **Generate API Key** and confirm.
3. Copy the key right away. Gryffi shows it only once and cannot show it again later.
4. After you stored the key, click **I have stored the key safely**.

### Key details

| Property | Description |
|----------|-------------|
| Created | When the key was generated |
| Last used | When an application last used the key, or "Never used" |

## Key Security

### Best Practices

- Store the key in an environment variable or a secret manager.
- Never put the key in code or in a code repository.
- Replace the key now and then with **Regenerate Key**.
- Revoke the key when no application uses it any more.

### Example Usage

.env file
```bash
# Environment variable
export GRYFFI_API_KEY="grf_your_api_key_here"
```

```javascript
// In code (reading from environment)
const apiKey = process.env.GRYFFI_API_KEY;
```

## Managing Keys

### Revoke Key

1. Click **Revoke Key**.
2. Confirm.
3. The key stops working at once.

## Key Rotation

### When to replace the key

- As a regular security habit
- When you think someone else knows the key
- When someone who knew the key leaves your organization

### Rotation Process

1. Click **Regenerate Key**.
2. Confirm.
3. Copy the new key and put it in every application that uses the API.

The old key stops working at once.

## Troubleshooting

### Answer 401 "Invalid API key"

- Check that you copied the whole key, starting with `grf_`.
- Check that the key is sent in the `X-API-Key` header.
- Check that nobody revoked or regenerated the key.

After 30 requests with a wrong key in 15 minutes, your IP address is blocked for the rest of those 15 minutes.

## Related Features

- [[goto:/dashboard/system-settings#api]] - API
- See: api-access
