<p align="center">
  <img src="app/public/images/logos/Logo---cropped-transparant.png" alt="Gryffi" width="220">
</p>

<p align="center">
  Onboarding and training that people actually finish.<br>
  Turn manuals, slide decks and intranet pages into short, interactive journeys.
</p>

<p align="center">
  <a href="https://docs.gryffi.com">Documentation</a> ·
  <a href="https://github.com/lloydstellar/gryffi/discussions">Discussions</a> ·
  <a href="https://gryffi.com">Gryffi Cloud</a>
</p>

---

Most onboarding still lives in PDFs and wiki pages that new colleagues skim once and forget. Gryffi lets you build that material into a journey: a path of small steps with photos of the building, a quiz, a form, a question for an AI guide that knows your documents, and a certificate at the end. Participants open it from a link in their email, without a password, on their phone or laptop. You see who started, who finished and where people get stuck.

This is **Gryffi Community Edition**: the full product, for one organization, on your own server. No limits on journeys, participants or makers, and your data stays with you.

## What you build with it

A journey is a set of steps on a canvas. Connect them in a straight line, or let the path depend on a choice or a quiz score.

| Step | What it does |
|---|---|
| Space | Show a place: a photo, a 360° panorama or a floor plan with hotspots |
| Guide | An AI chatbot that answers from documents you upload, with sources |
| Content | Text, a YouTube video or an image |
| Challenge | A multiple-choice quiz with a pass score and retries |
| Form | Collect information, including file uploads |
| Poll | Ask one question and see the results |
| Reward | Hand out a badge or a certificate |

Not sure where to start? Upload a document and the journey wizard drafts a journey from it. Need the same journey in German? Copy & Translate does the whole journey at once.

## For the people taking the journey

- A magic link in their email. No account, no password.
- The interface in 14 languages.
- One step per screen, with "step 3 of 8" so people know where they are.
- Read aloud, and a font for readers with dyslexia.

## For the people running it

- **Participants**: add them by hand, import a CSV or Excel file, or sync them from Microsoft 365 or Google Workspace. Put them in groups.
- **Analytics**: completion per journey, a funnel per step, progress per person, comparisons between groups, quiz scores, poll results and PDF reports.
- **Makers**: invite colleagues as admin, manager, member or read-only viewer.
- **Public journeys**: share a journey with a link, for visitors or applicants without an invitation.
- **API**: manage participants, groups and invitations from your own systems.

## AI on your terms

Gryffi works with any service that speaks the OpenAI API: Mistral, OpenAI, OpenRouter, or models on your own hardware with Ollama, vLLM or LM Studio. Use your own API key, set a monthly limit on AI questions, or leave AI off completely. Everything else works without it.

## Install

You need a Linux server (Ubuntu 22.04 or newer, or Debian 12 or newer) with 2 GB of memory, and a domain name that points to it. With 4 GB of memory and 30 GB of disk on amd64, Gryffi can also read PDF, Word and PowerPoint files for the AI guides.

```bash
curl -fsSL https://get.gryffi.com | sudo bash
```

The script checks the server, asks a few questions and shows what it will do before it changes anything. It installs Docker when needed, starts Gryffi with automatic HTTPS and prints a link to the setup wizard. The wizard creates your organization and admin account, and tests your AI provider and mail server before it saves anything.

Prefer to read the script first? It is [install.sh](install.sh) in this repository. Running Docker Compose or a reverse proxy of your own already? See the [installation guide](https://docs.gryffi.com/install/).

After that, the `gryffi` command takes care of the server:

```bash
gryffi status     # is everything running?
gryffi update     # back up, then move to the latest release
gryffi backup     # database and uploaded files, also daily by itself
gryffi doctor     # run the checks of the setup wizard again
```

## Community Edition or Gryffi Cloud

| | Community Edition | Gryffi Cloud |
|---|---|---|
| Where it runs | Your server | Hosted by Gryffi in the EU (Germany), AI processing in France |
| Limits | None: journeys, participants and makers are unlimited | Depend on your plan |
| AI | Your own provider and key | Included, within your plan |
| Email | Your own mail server | Included |
| Updates and backups | You run `gryffi update`; backups are automatic | Done for you |
| Support | [GitHub Discussions](https://github.com/lloydstellar/gryffi/discussions) | Gryffi support |
| Price | Free | See [gryffi.com](https://gryffi.com) |

## Contributing

Questions, ideas and bug reports are welcome in [Discussions](https://github.com/lloydstellar/gryffi/discussions) and [Issues](https://github.com/lloydstellar/gryffi/issues). Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Found a security problem? Please report it privately, as [SECURITY.md](SECURITY.md) explains.

## License

Gryffi Community Edition is open source under the [GNU Affero General Public License v3.0](LICENSE). If you change Gryffi and offer it to others over a network, you share your changes under the same license.

"Gryffi" and the Gryffi logo are trademarks. You can use them to refer to this project; see [TRADEMARK.md](TRADEMARK.md) for what needs permission.

Fonts, browser libraries and the demo photos keep their own licenses, listed in [NOTICE.md](NOTICE.md).
