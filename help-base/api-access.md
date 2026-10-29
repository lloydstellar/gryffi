---
feature_id: api-access
related_features: [api-keys]
---

# API Access

The API Access feature allows developers to integrate Gryffi with external systems, automate workflows, and build custom applications.

[[show:overview]]

## Overview

Gryffi's API enables:

- Send journeys
- Create and delete end users
- Create and delete groups

## Prerequisites

To use the API, you need:

1. **Admin role** in your organization
2. **API Key** generated from settings

[[goto:/dashboard/system-settings#api]]

## API Documentation

### Base URL
https://api.gryffi.com/v1

### Authentication
All requests require an API key in the header:
Authorization: Bearer YOUR_API_KEY

## Available Endpoints

### Journeys

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/journeys` | GET | List all journeys |
| `/journeys/{id}` | GET | Get journey details |
| `/journeys` | POST | Create new journey |
| `/journeys/{id}` | PUT | Update journey |
| `/journeys/{id}` | DELETE | Delete journey |

### Users

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/users` | GET | List end users |
| `/users/{id}` | GET | Get user details |
| `/users` | POST | Create end user |
| `/users/{id}` | PUT | Update user |
| `/users/sync` | POST | Bulk sync users |

### Analytics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/analytics/journeys` | GET | Journey statistics |
| `/analytics/users` | GET | User engagement data |
| `/analytics/steps` | GET | Step performance |

### Invitations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/invitations` | GET | List invitations |
| `/invitations` | POST | Send invitations |
| `/invitations/{id}` | DELETE | Cancel invitation |

## Request Examples

### List Journeys

Get all published journeys to find the journey_id for invitations.

curl -X GET "https://api.gryffi.com/api/v1/journeys" \
  -H "X-API-Key: grf_your_api_key_here"

### Create End User

Create a new end user in Gryffi. If the email already exists, the existing user is returned.

curl -X POST "https://api.gryffi.com/api/v1/end-users" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john.smith@company.com",
    "first_name": "John",
    "last_name": "Smith"
  }'

### Invite to Journey

Invite an end user to a specific journey. Creates the user if they don't exist yet.

curl -X POST "https://api.gryffi.com/api/v1/invitations" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john.smith@company.com",
    "first_name": "John",
    "last_name": "Smith",
    "journey_id": "your-journey-uuid-here",
    "validity_days": 14,
    "max_completions": 1,
    "send_reminder": false
  }'

### Delete End User

Remove an end user from Gryffi by their email address.

curl -X DELETE "https://api.gryffi.com/api/v1/end-users" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john.smith@company.com"
  }'

### List Groups

Get all groups in your organization with their member count.

curl -X GET "https://api.gryffi.com/api/v1/groups" \
  -H "X-API-Key: grf_your_api_key_here"

### List Group Members

Get all members of a specific group.

curl -X GET "https://api.gryffi.com/api/v1/groups/your-group-uuid-here/members" \
  -H "X-API-Key: grf_your_api_key_here"

### Create Group

Create a new group to organize end users.

curl -X POST "https://api.gryffi.com/api/v1/groups" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Marketing Team",
    "description": "Optional description"
  }'

### Add Group Members

Add one or more end users to a group by their email addresses.

curl -X POST "https://api.gryffi.com/api/v1/groups/your-group-uuid-here/members" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "emails": ["john.smith@company.com", "another@example.com"]
  }'

### Remove Group Members

Remove one or more end users from a group by their email addresses.

curl -X DELETE "https://api.gryffi.com/api/v1/groups/your-group-uuid-here/members" \
  -H "X-API-Key: grf_your_api_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "emails": ["john.smith@company.com"]
  }'

### Delete Group

Delete a group. The group must be empty (no members) before it can be deleted.

curl -X DELETE "https://api.gryffi.com/api/v1/groups/your-group-uuid-here" \
  -H "X-API-Key: grf_your_api_key_here"

## Best Practices

- Store API keys securely (environment variables)
- Implement retry logic with exponential backoff
- Handle rate limits gracefully
- Don't send too many requests in a row

## Related Features

- [[goto:/dashboard/system-settings#api]] - Manage API keys
- See: api-keys
