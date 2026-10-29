# Changelog

All notable changes to Gryffi Community Edition. Versions follow
[semantic versioning](https://semver.org).

## [0.9.0] - 2026-10-29

First public preview of Gryffi Community Edition, for testing before 1.0.

- The full Gryffi product for one organization: the journey builder with
  all seven step types, AI guides, the player in 14 languages, analytics,
  directory sync, public journeys and the API. No plans or limits.
- Install with one command (`install.sh`): checks the server, installs
  Docker when needed, and starts Gryffi with automatic HTTPS by Caddy.
- A setup wizard that tests the AI provider and the mail server before it
  saves anything, with a help page for every error.
- Any OpenAI-compatible AI provider (Mistral, OpenAI, OpenRouter, Ollama,
  vLLM), with a monthly limit on AI questions, or no AI at all.
- Email through your own SMTP server.
- An Installation page for admins: settings, live tests, a change log, and
  a notice when a new version is out.
- The `gryffi` command: status, logs, update with automatic rollback,
  backup, restore, setup-code and doctor. Daily backups.
