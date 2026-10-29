# Install

## What you need

| | |
|---|---|
| Server | Ubuntu 22.04 or newer, or Debian 12 or newer, on amd64 or arm64 |
| Memory | 2 GB. 4 GB to also read PDF, Word and PowerPoint files for the AI guides |
| Disk | 20 GB free. 30 GB with the document parser, which takes 17 GB by itself |
| Domain | A name such as `gryffi.example.com` with an A record that points to the server |
| Ports | 80 and 443 open, unless you use a reverse proxy of your own |

You also need an AI provider (or leave AI off) and a mail server that Gryffi can send through. The setup wizard asks for both. See [AI providers](/ai/) and [Email](/email/).

## With the install script

```bash
curl -fsSL https://get.gryffi.com | sudo bash
```

The script:

1. checks the system, memory, disk space and ports;
2. asks for the domain name and checks that it points to this server;
3. asks whether to switch on the document parser and the NSFW filter;
4. shows what it will do and waits for your go-ahead;
5. installs Docker from Docker's own repository, if it is missing;
6. writes `/opt/gryffi` with `compose.yml` and a `.env` with random passwords and keys;
7. installs the `gryffi` command and a daily backup;
8. starts Gryffi, with HTTPS by Caddy and a certificate from Let's Encrypt;
9. prints the link to the setup wizard.

The script is [install.sh](https://github.com/lloydstellar/gryffi/blob/main/install.sh) in the repository, if you want to read it first.

### Options

| Option | |
|---|---|
| `--domain gryffi.example.com` | The domain, so the script does not ask |
| `--no-https --url URL` | Use your own reverse proxy (see below) |
| `--port 3000` | The local port for that proxy |
| `--listen 0.0.0.0` | With `--no-https`: listen on all addresses instead of `127.0.0.1`. Only for a test (see below) |
| `--version 1.2.3` | Install a specific version instead of the latest |
| `--dir /opt/gryffi` | Another installation directory |
| `--without-parser` | No PDF, Word and PowerPoint reading. Saves a 5 GB download, 17 GB of disk and 2 GB of memory |
| `--without-nsfw` | No NSFW check on uploaded images |
| `--yes` | Ask nothing. Needs `--domain`, or `--no-https` with `--url` |

Pass options after `bash -s --`:

```bash
curl -fsSL https://get.gryffi.com | sudo bash -s -- --domain gryffi.example.com --without-nsfw
```

The script switches the document parser on when the server has 4 GB of memory and 30 GB of free disk space, and asks first. The parser image exists for amd64 only; on arm64 the parser stays off. Without it, Gryffi still reads text, Markdown, CSV and Excel files.

## The setup wizard

Open the link the script prints. It contains a one-time code and works for 72 hours. A new link: `gryffi setup-code`.

The wizard checks the server, creates your organization and the first admin account, and tests your AI provider and mail server. Nothing is saved until every required test passes. After that the wizard is gone for good; change settings later under **Installation** in the dashboard.

## Behind your own reverse proxy

Already running nginx, Traefik or another proxy on ports 80 and 443? Install without Caddy:

```bash
curl -fsSL https://get.gryffi.com | sudo bash -s -- --no-https --url https://gryffi.example.com --port 3000
```

Gryffi then listens on `127.0.0.1:3000`. Point your proxy at it, with HTTPS. For nginx:

```nginx
server {
    listen 443 ssl;
    server_name gryffi.example.com;
    # ssl_certificate and ssl_certificate_key as for your other sites

    client_max_body_size 60m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }
}
```

`proxy_buffering off` lets the setup wizard, the journey wizard and Copy & Translate show their progress while they work. `client_max_body_size` allows document uploads up to 50 MB.

## A test without a domain

To try Gryffi on a virtual machine or a server on your own network, without a domain or HTTPS:

```bash
curl -fsSL https://get.gryffi.com | sudo bash -s -- --no-https --listen 0.0.0.0 --url http://192.0.2.20:3000
```

Use the address of the machine in `--url`. Anyone who can reach that address on port 3000 can open Gryffi, over plain HTTP, and Docker opens the port past ufw. Do not use this on a server on the internet.

Without `--listen`, Gryffi only listens on `127.0.0.1`. You can then reach it from your own computer through an SSH tunnel, with `--url http://localhost:3000`:

```bash
ssh -N -L 3000:127.0.0.1:3000 user@192.0.2.20
```

Leave that running and open `http://localhost:3000`.

## With Docker Compose by hand

Every release has `compose.yml` and `env.example`:

```bash
mkdir -p /opt/gryffi && cd /opt/gryffi
curl -fsSLO https://github.com/lloydstellar/gryffi/releases/latest/download/compose.yml
curl -fsSL https://github.com/lloydstellar/gryffi/releases/latest/download/env.example -o .env
```

Fill in `.env` (see [Settings and .env](/configuration/)), then:

```bash
docker compose up -d
docker compose logs app | grep setup?code
```

Without the `gryffi` command, a new setup link is `docker compose exec app node src/setup/cli.js new-code`. The `gryffi` command works for this setup too: download it from the release to `/usr/local/bin/gryffi`, and set `GRYFFI_HOME` if the directory is not `/opt/gryffi`.

## Firewall

Allow SSH, and ports 80 and 443 for Caddy. Gryffi, the database and Redis only listen on `127.0.0.1` or inside Docker. With ufw:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Note that Docker opens published ports past ufw. That is why every port in `compose.yml`, except those of Caddy, is bound to `127.0.0.1`, unless you install with `--listen`.
