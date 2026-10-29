# Changelog

All notable changes to Gryffi Community Edition. Versions follow
[semantic versioning](https://semver.org).

## [0.9.4] - 2026-10-29

- `gryffi update` removes the images of the previous version once the new
  version runs, and replaces the `gryffi` command with the one of the new
  release (checked against `SHA256SUMS`). Installed before this version? Get
  the new command once, see Operations in the docs.

## [0.9.3] - 2026-10-29

- The install script offers the document parser without the 30 GB disk
  check when its image is already on the server, for example after a
  reinstall.
- Quizzes in the player, and adding quiz questions and poll options in the
  builder, work over plain HTTP too (a test install with `--listen`).
- Opening a magic link, or coming back to a public journey with "Remember
  me", gives the browser session a new ID. A maker who is logged in in the
  same browser stays logged in.
- No more pg warning about overlapping queries on one database connection.

## [0.9.2] - 2026-10-29

- The install script stopped without a word after "Waiting for Gryffi to
  start" when it ran with `curl | bash`. It now runs to the end and prints the
  setup link.
- The install script says how much it downloads, shows the download
  progress and checks the free disk space where Docker keeps its images.
  The document parser (17 GB on disk) is only offered with 30 GB free, and
  not on arm64, where its image does not exist.
- New option `--listen` (`GRYFFI_LISTEN` in `.env`) to try Gryffi on your
  own network without a domain.
- The release files include `env.example`. GitHub renamed `.env.example`
  to `default.env.example`.

## [0.9.1] - 2026-10-29

- The first release with images and an install script. The release
  workflow of 0.9.0 stopped before it built anything; the software is the
  same.

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
