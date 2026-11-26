# Changelog

All notable changes to Gryffi Community Edition. Versions follow
[semantic versioning](https://semver.org).

## [0.12.0] - 2026-11-26

Before you update: this release changes the database when Gryffi starts.
The result tables (progress, quiz attempts, poll votes, form submissions,
rewards, video statistics) no longer depend on the steps, so results can
stay after a step or journey is deleted. You do not need to do anything.
Results that were deleted before this version do not come back.

Analytics:

- Results stay after deletion. When a journey leaves the trash for good,
  or you delete a step in the builder, its results stay in Analytics. A
  switch "Show deleted journeys and steps" at the top of Analytics is off
  by default; turn it on to see them, marked "Deleted". On the Overview
  tab, only an admin can delete these results for good, uploaded files
  included. A journey without any results is still removed completely.
  Undo in the builder brings a deleted step back with its results.
- Every maker role can open Analytics now, including the Forms tab with
  the form submissions and their files. Before, editors and viewers could
  not. Deleting archived polls is admin only.
- Moving a journey to the trash no longer asks what to do with poll
  results: the polls are archived and stay in Analytics.
- The dashboard counts new form responses from real submissions. Before,
  poll votes were counted too.

Builder:

- Floor plans can be renamed and deleted. Choose a floor plan in a Space
  step to see Edit floor plan and Delete floor plan. Deleting asks first
  and says in how many steps the floor plan is shown; those steps stop
  showing it, and the image is removed.
- The journey wizard makes form steps the builder can edit: at most five
  fields, and no email field type.
- The subject of the form email fills in `{{journey_title}}` and
  `{{step_title}}` everywhere, also in the preview email and in public
  journeys. The server builds the subject from the step.

Participants and sync:

- Directory sync with Google Workspace and Microsoft 365 removes nobody
  when more than 3 people and more than 10% of the synced participants
  would be removed at once. Before, the limits differed per sync and a
  single leaver could block a small directory.
- Deleting a participant also removes the files they uploaded in forms
  from the disk. A job runs every hour and removes form files that no
  submission refers to any more, and files of builder preview emails
  once their download link has expired (30 days).
- Invitation reminders are no longer sent for journeys in the trash.

Security:

- Only admins can create, edit, activate or delete themes. Before, the
  API allowed every maker role.
- After 3 wrong passwords, Gryffi asks for a 6 digit code sent by email.
  This did not work in the Community Edition before.

Player:

- The message about attachments that are too large gives the right limit
  (24 MB) and says how to fix it, in all 14 languages.
- The floor plan labels and the button that shows where you are on the
  floor plan use the language of the journey.

Help:

- Every help page was checked against the app and rewritten where it was
  wrong or out of date. New page about tracking rewards. The help ids now
  match the file names.

## [0.11.0] - 2026-11-24

Before you update: magic links are now stored as a hash and an encrypted
copy, no longer as plain text. Gryffi converts the existing invitations
when it starts and removes the plain token an hour later. Links that were
already sent keep working, also when the update fails and `gryffi update`
goes back to 0.10.0. Keep `OAUTH_TOKEN_KEY` in `.env`: the encrypted
copies need it.

The `gryffi` command becomes 1.2.0 with this release. To go back to an
older version later, use `sudo gryffi update 0.10.0`: it first writes the
tokens back, so the links in sent emails keep working there.

Maker interface:

- Help opens as a side panel next to the page, also with `?`. It shows
  the help for the screen you are on and for the selected step type, with
  example questions. "What is this?" buttons open on a click and link to
  the full article. With an AI provider, help articles are translated
  into the interface language. Viewers can use the help too.
- The builder lists the step types with their names on the left. Every
  change saves itself, so the Save button is gone, and leaving during a
  save asks first. Hints in the step panel
  say what a field does. An empty journey points to the step types and
  the properties panel. A Show all steps button and labelled zoom buttons
  were added.
- Before a journey is published, Gryffi checks it: a missing start or end
  step stops publishing. Steps nobody can reach, dead ends, rewards
  without codes, missing media or guides, quiz questions without a correct
  answer and polls with fewer than two options are shown as warnings, each
  with a link to the step.
- Participants have their own menu item, with import, directory sync and
  groups. The interface says "participants" everywhere instead of "end
  users", in all five languages.
- The dashboard shows what needs doing, recent journeys and progress.
- Invitations: expired invitations are marked as expired, and you can
  send an invitation again from the list.
- The interface meets WCAG AA contrast, every control has a name, and
  the maker pages work with a keyboard and a screen reader.
- Plain words, and one word per thing in English, Dutch, German, French
  and Spanish. German addresses makers and participants with "Sie".
- Guides answer in their own language, also English guides, and can be
  tested from their settings page. Sources in a guide answer are small
  numbers, with the list of sources below the answer.
- The theme editor shows a live preview in your interface language.

Player:

- A participant with an expired link can ask for a new one. The maker who
  sent the invitation, or else the admins, gets an email. One request per
  invitation per 24 hours.
- Rewards work in public journeys: random codes, the maximum number of
  recipients and the position shown to the participant.
- Public journeys with more than one poll save every vote. Before, only
  the first vote reached the server.
- Read aloud uses Mistral's Voxtral 3 (`voxtral-mini-tts-3-0`) by default,
  with a native voice for 11 of the 14 journey languages. Danish, Finnish
  and Swedish use the browser voice. The browser voice only reads with a
  voice in the language of the journey. If you set a speech model
  yourself on the Installation page, that model stays.
- YouTube videos load only after Play video. Watch time and the share of
  a video that was seen are recorded, so the video figures in Analytics
  are no longer 0. Timed pacing on a video step starts at the first play;
  before, Next could stay hidden.
- Texts, form errors, magic link pages and verification emails use the
  language of the journey. The 360 viewer, polls and file uploads work
  with the keyboard, and screen readers hear when Next becomes available.
- The participant code and the maker login code have six digits.

Security and privacy:

- Every page from the app sends `X-Robots-Tag: noindex, nofollow`, so
  search engines do not index magic links or public journeys.
- Signing out works only with POST. The old `GET /logout` is gone.
- Names and titles in emails are escaped. The guide page serves Cropper.js
  itself instead of loading it from unpkg.com.
- The type of a form attachment is read from its content.
- The help counts how often it is opened per screen, and keeps the
  questions it could not answer, in your own database, without user
  names. Unanswered questions are removed after 90 days and counts after
  365 days. `node src/scripts/help-report.js` in the app container prints
  a summary as plain text. Question texts are only included with `--with-questions`.

Public API:

- API keys are found with one indexed lookup instead of a bcrypt compare
  per organization. Keys made before this get their lookup value the
  first time they are used.
- Wrong input gives 400 with what is wrong, not 500. Only 401 answers
  count towards the limit for wrong keys, so an integration that gets
  many 404 or 409 answers is no longer blocked.

Other:

- Old image links under `/media/organizations/` are rewritten in the
  database at start. That path now answers 404.
- The journey wizard no longer puts a placeholder YouTube video in its
  steps, and a migration removes that video from existing steps.
- Removed code, routes, CSS and translation keys that nothing used.
- Dependencies: i18next 26.7.2 (security advisory GHSA-6jcc-5g8w-32mx).

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
