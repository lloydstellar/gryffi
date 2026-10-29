# Security

## Reporting a vulnerability

Please do not report security problems in a public issue or discussion.

Report them privately through GitHub: on the
[Security tab](https://github.com/lloydstellar/gryffi/security) of this
repository, click **Report a vulnerability**. Only the maintainers see your
report.

Helpful to include:

- what an attacker can do, and what they need for it (an account, a role, a link)
- the steps to reproduce it, or a proof of concept
- the version of Gryffi (`gryffi version`) and how it is installed

We reply as soon as we can. When we confirm the problem, we fix it in a
patch release and publish a GitHub Security Advisory that credits you, unless
you prefer to stay anonymous. Please give us a reasonable time to release the
fix before you publish details.

## Supported versions

Security fixes go into the latest release. Update with `gryffi update`.

## Keeping your installation safe

- Keep Gryffi up to date. Admins see a notice in the dashboard when a new
  release is out (Installation, Options: "Check for new versions").
- Keep a copy of `/opt/gryffi/.env` outside the server. It holds the key that
  encrypts the API keys and passwords stored in the database. Backups do not
  contain it.
- Only Caddy needs ports 80 and 443. Gryffi itself listens on 127.0.0.1.
- Store backups (`/opt/gryffi/backups`) somewhere else as well.
