# Changelog

All notable changes to Gryffi Community Edition. Versions follow
[semantic versioning](https://semver.org).

## [0.10.0] - 2026-10-31

- Help: an answer shows the screenshots of its help page. On a wide screen
  they sit next to the text, and the numbers in the answer point at the
  numbered markers in the screenshot. On a phone, a zoomed-in part of the
  screenshot appears under the step. The help pages have new screenshots
  in English and Dutch.
- The help assistant finds the right page more often: in the five
  interface languages, and with the words makers use, such as
  "participants", "course" or "chatbot". This also works without an AI
  provider. With an AI provider it reads the parts of a long help page
  that fit the question, not only the beginning of the page, and it names
  buttons as the interface does.
- The user guide on this site shows the screenshots next to the text, with
  the same numbered markers.
- Automations: emails "after inactivity" are now sent, once an hour.
  Every automation email goes out once per invitation and run, also when
  a participant reloads the page.
- Player: the last step of a sub-journey is shown. Before, a quiz there
  was skipped and the main journey could count as completed without it.
  The Continue button appears after the quiz.
- Player on phones: the page scrolls, the guide chat and the title get
  more room, and the step indicator wraps instead of being cut off.
- Builder: a Space step keeps its floor plan when you change something
  else in it. Before, any change removed the floor plan and its marker.
- Builder: the toolbar fits from 1024 pixels wide; the step types become
  icons on narrower screens. "Used in N journeys" counts guide steps, and
  an unusual browser language no longer shows "Save failed" after a save
  that worked.
- Analytics: the start of a journey by an invited participant is counted,
  and durations are shown in whole seconds.
- Texts: singular forms ("1 source", "1 chunk", "1 respondent"), and the
  Dutch, German, French and Spanish interface use expeditie, Expedition,
  parcours and expedición everywhere.
- Dependencies: ejs 7 and archiver 8. This closes the security advisories
  for ejs, jake, filelist and archiver. The update runs a small database
  migration when Gryffi starts.

## [0.9.6] - 2026-10-30

- The documentation site builds with Vite 6.4.5 instead of Vite 5. This
  closes nine security advisories for the development server of Vite and
  esbuild. Gryffi itself works the same as in 0.9.5.

## [0.9.5] - 2026-10-30

- A form step without a "Send form to" address no longer stops
  participants with "Failed to submit form". The answers are saved in
  Analytics, Forms, and no email is sent. The builder now says the address
  is optional.
- The README shows Gryffi: the player on a phone, the journey builder, the
  dashboard, the funnel in Analytics and the setup wizard.

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
