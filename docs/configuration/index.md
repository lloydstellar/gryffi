# Settings and .env

Gryffi keeps its settings in two places.

| Where | What | How to change |
|---|---|---|
| `/opt/gryffi/.env` | Passwords and keys of the server itself, the address, optional services | Edit the file, then `cd /opt/gryffi && docker compose up -d` |
| **Installation** page in the dashboard | AI provider, email, options, integrations | As an admin, in the browser. Every change is tested and logged |

API keys and passwords that you enter on the Installation page are stored encrypted in the database, with `OAUTH_TOKEN_KEY` from `.env` as the key.

## .env

The install script writes this file with random values. Keep a copy outside the server.

| Key | |
|---|---|
| `GRYFFI_VERSION` | The version that runs, for example `1.2.3`. `gryffi update` changes it |
| `APP_URL` | The address people type, such as `https://gryffi.example.com`. Links in emails use it |
| `GRYFFI_DOMAIN` | The domain Caddy gets a certificate for (the `https` profile) |
| `COMPOSE_PROFILES` | Optional services, comma separated: `https`, `parser`, `nsfw` |
| `GRYFFI_PORT` | Port on `127.0.0.1` for your own reverse proxy. Default `3000` |
| `GRYFFI_LISTEN` | The address Gryffi listens on without the `https` profile. Default `127.0.0.1`. `0.0.0.0` opens it to the network without HTTPS: only for a test |
| `DB_PASSWORD` | Database owner, used for the database updates at start |
| `APP_DB_PASSWORD` | Database login of the app itself, with fewer rights |
| `REDIS_PASSWORD` | Redis, for sessions and rate limits |
| `SESSION_SECRET` | Signs the login sessions |
| `OAUTH_TOKEN_KEY` | Encrypts stored keys and passwords. 64 hexadecimal characters |
| `GRYFFI_BACKUP_KEEP` | How many daily backups to keep. `0` switches them off |

Generate a value with `openssl rand -hex 32`. Do not change `OAUTH_TOKEN_KEY` on an installation that is in use: the stored keys and passwords can then no longer be read, and you have to enter them again.

## Optional services

| Profile | Service | Needs |
|---|---|---|
| `https` | Caddy, with certificates from Let's Encrypt | Ports 80 and 443, and `GRYFFI_DOMAIN` |
| `parser` | Reads PDF, Word and PowerPoint for the AI guides | About 2 GB of memory and 17 GB of disk (a 5 GB download). amd64 only |
| `nsfw` | Checks uploaded images for nudity | About 1 GB of memory |

Text, Markdown, CSV and Excel files are read without the parser.

To switch a service on or off, change `COMPOSE_PROFILES` and run `docker compose up -d --remove-orphans` in `/opt/gryffi`. Then switch the matching option on or off on the Installation page. While the NSFW option is on but its service does not run, Gryffi refuses image uploads, so nothing slips through unchecked.

## The Installation page

Admins find it in the menu under **Installation**:

- **Version**: the version that runs, and a notice when there is a newer one.
- **AI**: provider, models and the monthly limit on AI questions. See [AI providers](/ai/).
- **Email**: how Gryffi sends mail. See [Email](/email/).
- **Options**: the NSFW filter, the document parser, "Powered by Gryffi" in emails, and the check for new versions.
- **Integrations**: Pexels for stock photos, and your own Google or Microsoft app for directory sync. The page shows the redirect URIs to register.
- **Knowledge base index**: rebuilt after you change the embedding model.
- **Change log**: the last 100 changes, who made them and when. Secrets are masked.
