# Contributing to Gryffi

Thank you for helping. There are several ways to contribute, and most of them
take no code at all.

## Questions and ideas

Ask questions, share how you use Gryffi and propose ideas in
[Discussions](https://github.com/lloydstellar/gryffi/discussions). Other users
can answer there too, and a good idea can grow into a plan before anyone writes
code.

## Bugs

Open an [issue](https://github.com/lloydstellar/gryffi/issues) with:

- what you did, what you expected and what happened instead
- the version (`gryffi version`) and how you installed Gryffi
- the output of `gryffi doctor`, and log lines from `gryffi logs app` around
  the time of the problem

Check that the logs contain no names, email addresses or keys of your
organization before you post them.

Security problems do not belong in an issue. See [SECURITY.md](SECURITY.md).

## Translations

The interface for makers is in `app/locales/` (5 languages), the player for
participants in `app/player-locales/` (14 languages). Corrections are welcome.
Every key must exist in every file of its folder.

## Code

For anything larger than a small fix, start with a discussion or an issue, so
we can agree on the approach before you spend time on it.

1. Fork the repository and create a branch.
2. Run Gryffi locally: `docker build -t gryffi-dev .`, then start it with
   `compose.yml` and `GRYFFI_IMAGE=gryffi-dev GRYFFI_VERSION=latest`. See
   [the installation guide](https://docs.gryffi.com/install/).
3. Keep to the style of the code around your change: ES modules, two spaces,
   single quotes, semicolons, a short comment at the top of each file.
4. Before you push, in `app/`: `npm ci`, `npm run lint` and `npm test`.
   The smoke test runs in CI; run it yourself with `tests/smoke/run.sh`.
5. Escape everything you show in the browser. Makers, participants and
   visitors of public journeys see each other's content.
6. New text for users goes into all language files of its folder.
7. Open a pull request that says what it changes and why.

### Contributor License Agreement

The first time you open a pull request, a bot asks you to sign the
[Contributor License Agreement](CLA.md) by posting a comment. You keep the
copyright in your work. The agreement lets Gryffi use your contribution both in
this open source edition and in Gryffi Cloud.

### How a pull request lands

The public repository is published from Gryffi's own repository at each
release. When your pull request is accepted, it is applied there and comes
back here with the next release, with you credited in the release notes. Your
pull request is then closed with a link to that release.

## Code of conduct

Everyone who takes part follows the [code of conduct](CODE_OF_CONDUCT.md).
