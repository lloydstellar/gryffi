#!/usr/bin/env bash
# Install Gryffi Community Edition on Ubuntu or Debian
#
#   curl -fsSL https://get.gryffi.com | sudo bash
#
# or download this script, read it, and run:  sudo bash install.sh
#
# The script checks the server, shows what it will do and asks before it
# changes anything. It installs Docker (from Docker's own repository) when it
# is missing, writes /opt/gryffi with compose.yml and a .env with random
# passwords, starts Gryffi and prints the link to the setup wizard.
#
# Options (all optional; without --yes the script asks):
#   --domain gryffi.example.com   domain for automatic HTTPS (Caddy, Let's Encrypt)
#   --no-https --url URL          use your own reverse proxy; Gryffi listens on 127.0.0.1:PORT
#   --port 3000                   that local port (default 3000)
#   --listen 0.0.0.0              with --no-https: listen on this address instead of
#                                 127.0.0.1, for a test on your own network (no HTTPS)
#   --version 1.2.3               version to install (default: the latest release)
#   --dir /opt/gryffi             installation directory
#   --without-parser              do not read PDF, Word and PowerPoint (saves a 5 GB
#                                 download, 17 GB of disk and 2 GB of memory)
#   --without-nsfw                no NSFW check on uploaded images
#   --yes                         do not ask; needs --domain, or --no-https with --url
#
# Everything runs from main(), at the bottom. With curl | bash, bash reads the
# script from stdin while it runs; inside a function it has read all of it
# before the first command, so a command that reads stdin cannot swallow the
# rest, and a download that breaks off halfway runs nothing.
set -euo pipefail

GRYFFI_REPO="${GRYFFI_REPO:-lloydstellar/gryffi}"
RELEASES_URL="${GRYFFI_RELEASES_URL:-https://github.com/$GRYFFI_REPO/releases}"

DOMAIN=""
APP_URL=""
HTTPS=1
PORT=3000
LISTEN=127.0.0.1
VERSION=""
DIR=/opt/gryffi
PARSER=""
PARSER_REASON=""
NSFW=1
ASSUME_YES=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '%s\n' "$*"; }
warn() { printf 'Warning: %s\n' "$*" >&2; }
die() { printf '\nThe installation stopped: %s\n' "$*" >&2; exit 1; }

# Questions read from the terminal, also when the script itself comes from a pipe
ask() {
  local prompt="$1" default="${2:-}" answer=""
  if [ "$ASSUME_YES" = 1 ]; then echo "$default"; return; fi
  printf '%s ' "$prompt" > /dev/tty
  read -r answer < /dev/tty || true
  echo "${answer:-$default}"
}

# Yes/no question; the second argument is the answer for Enter (default no)
confirm() {
  local default="${2:-n}" answer
  if [ "$default" = y ]; then answer="$(ask "$1 [Y/n]" y)"; else answer="$(ask "$1 [y/N]" n)"; fi
  [ "$ASSUME_YES" = 1 ] || [[ "$answer" =~ ^[YyJj] ]]
}

port_busy() { ss -Hltn "sport = :$1" 2>/dev/null | grep -q .; }

usage() {
  if [ -f "$0" ]; then sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; else echo "Options: see https://github.com/$GRYFFI_REPO/blob/main/install.sh"; fi
  exit "${1:-0}"
}

main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) DOMAIN="${2:-}"; shift 2 ;;
      --url) APP_URL="${2:-}"; shift 2 ;;
      --no-https) HTTPS=0; shift ;;
      --port) PORT="${2:-}"; shift 2 ;;
      --listen) LISTEN="${2:-}"; shift 2 ;;
      --version) VERSION="${2#v}"; shift 2 ;;
      --dir) DIR="${2:-}"; shift 2 ;;
      --without-parser) PARSER=0; shift ;;
      --without-nsfw) NSFW=0; shift ;;
      --yes) ASSUME_YES=1; shift ;;
      -h | --help) usage 0 ;;
      *) warn "unknown option $1"; usage 1 ;;
    esac
  done

  if [ "$ASSUME_YES" = 0 ] && ! { : < /dev/tty; } 2>/dev/null; then
    die "no terminal to ask questions. Run the script in a terminal, or pass --yes with --domain."
  fi

  # ------------------------------------------------------------------ checks

  bold "Gryffi Community Edition installer"
  echo

  [ "$(id -u)" = 0 ] || die "run the script as root, for example: curl -fsSL https://get.gryffi.com | sudo bash"
  command -v curl >/dev/null || die "curl is missing. Install it first: apt-get install -y curl"

  # Read the values instead of sourcing the file: it defines VERSION and other
  # common names that would overwrite ours
  [ -r /etc/os-release ] || die "cannot read /etc/os-release"
  os_value() { sed -n "s/^$1=//p" /etc/os-release | head -1 | tr -d '"'; }
  OS_ID="$(os_value ID)"
  OS_VERSION_ID="$(os_value VERSION_ID)"
  OS_CODENAME="$(os_value VERSION_CODENAME)"
  OS_NAME="$(os_value PRETTY_NAME)"
  os_ok=0
  case "$OS_ID" in
    ubuntu) [ "${OS_VERSION_ID%%.*}" -ge 22 ] 2>/dev/null && os_ok=1 ;;
    debian) [ "${OS_VERSION_ID%%.*}" -ge 12 ] 2>/dev/null && os_ok=1 ;;
  esac
  if [ "$os_ok" = 1 ]; then
    info "System:       $OS_NAME"
  else
    warn "Gryffi is tested on Ubuntu 22.04 or newer and Debian 12 or newer. This is ${OS_NAME:-unknown}."
    confirm "Continue anyway?" || die "not a supported system"
  fi

  case "$(uname -m)" in
    x86_64 | aarch64 | arm64) ;;
    *) die "Gryffi runs on amd64 and arm64 processors, not on $(uname -m)" ;;
  esac

  mem_mb=$(( $(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) / 1024 ))
  info "Memory:       $mem_mb MB"
  [ "$mem_mb" -ge 1800 ] || die "Gryffi needs at least 2 GB of memory"

  # The images go to Docker's directory, the uploads and backups to $DIR; often
  # the same disk. Count the smallest free space of the two.
  mkdir -p "$(dirname "$DIR")"
  docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)"
  while [ ! -d "$docker_root" ]; do docker_root="$(dirname "$docker_root")"; done
  free_gb=$(( $(df -Pk "$(dirname "$DIR")" "$docker_root" | awk 'NR > 1 { print $4 }' | sort -n | head -1) / 1024 / 1024 ))
  info "Free disk:    $free_gb GB"
  [ "$free_gb" -ge 8 ] || die "at least 8 GB of free disk space is needed, 20 GB is better"
  [ "$free_gb" -ge 20 ] || warn "less than 20 GB free. That is enough to start, but uploads and backups grow."

  # The document parser is a large image: a 5 GB download that takes 17 GB on
  # disk once unpacked. It exists for amd64 only.
  if [ "$(uname -m)" != x86_64 ]; then
    PARSER_REASON="it exists for amd64 processors only"
  elif [ "$mem_mb" -lt 3800 ]; then
    PARSER_REASON="it needs 4 GB of memory and this server has $mem_mb MB"
  elif [ "$free_gb" -lt 30 ]; then
    PARSER_REASON="it needs 30 GB of free disk space and this server has $free_gb GB"
  fi
  if [ -n "$PARSER_REASON" ]; then
    [ "$PARSER" = 0 ] || info "The document parser stays off: $PARSER_REASON. Text, CSV and Excel files still work."
    PARSER=0
  elif [ -z "$PARSER" ]; then
    PARSER=1
  fi

  if [ -f "$DIR/compose.yml" ]; then
    die "Gryffi is already installed in $DIR. Update it with: gryffi update"
  fi

  # --------------------------------------------------------------- questions

  echo
  if [ "$HTTPS" = 1 ]; then
    [ "$LISTEN" = 127.0.0.1 ] || die "--listen only works with --no-https; with HTTPS, Caddy listens on ports 80 and 443"
    if [ -z "$DOMAIN" ]; then
      [ "$ASSUME_YES" = 1 ] && die "--yes needs --domain, or --no-https with --url"
      info "Gryffi needs a domain name that points to this server, for example gryffi.example.com."
      info "Caddy then gets an HTTPS certificate for it from Let's Encrypt."
      DOMAIN="$(ask "Domain name:")"
    fi
    DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
      || die "\"$DOMAIN\" is not a domain name"
    APP_URL="https://$DOMAIN"

    for port in 80 443; do
      if port_busy "$port"; then
        die "port $port is in use by another program. Caddy needs ports 80 and 443. Use --no-https with your own reverse proxy, or stop that program."
      fi
    done
    # Gryffi also listens on a local port behind Caddy; take the next free one
    if port_busy "$PORT"; then
      for candidate in $(seq 3001 3099); do
        if ! port_busy "$candidate"; then PORT="$candidate"; break; fi
      done
      port_busy "$PORT" && die "no free local port between 3000 and 3099 for Gryffi"
      info "Local port:   $PORT (3000 is in use)"
    fi

    # Does the domain point here? Behind NAT the public address is not on this
    # machine, so a mismatch is a warning, not an error.
    resolved="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
    local_ips="$(hostname -I 2>/dev/null || true)"
    if [ -z "$resolved" ]; then
      warn "$DOMAIN does not resolve yet. Add an A record that points to this server; HTTPS works once it does."
      confirm "Continue?" || die "the domain does not resolve"
    else
      match=0
      for ip in $resolved; do
        case " $local_ips " in *" $ip "*) match=1 ;; esac
      done
      if [ "$match" = 0 ]; then
        warn "$DOMAIN points to $resolved, which is not an address of this server ($local_ips)."
        warn "That is fine behind NAT or a firewall that forwards ports 80 and 443. Otherwise HTTPS will not work."
        confirm "Continue?" || die "the domain points elsewhere"
      else
        info "Domain:       $DOMAIN points to this server"
      fi
    fi
  else
    if [ -z "$APP_URL" ]; then
      [ "$ASSUME_YES" = 1 ] && die "--no-https needs --url, the address people use, for example https://gryffi.example.com"
      APP_URL="$(ask "Web address of Gryffi behind your reverse proxy (for example https://gryffi.example.com):")"
    fi
    [[ "$APP_URL" =~ ^https?://[^/]+$ ]] || die "\"$APP_URL\" is not a web address like https://gryffi.example.com"
    [[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"
    [[ "$LISTEN" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "--listen must be an IPv4 address of this server, or 0.0.0.0 for all"
    if port_busy "$PORT"; then
      die "port $PORT is in use. Choose another one with --port."
    fi
  fi

  if [ "$ASSUME_YES" = 0 ]; then
    if [ "$PARSER" = 1 ]; then
      info "The document parser reads PDF, Word and PowerPoint files for the AI guides."
      info "It is a download of about 5 GB, takes 17 GB of disk space and uses about 2 GB of memory."
      confirm "Install the document parser?" y || PARSER=0
    fi
    if [ "$NSFW" = 1 ]; then
      confirm "Check uploaded images for nudity (NSFW filter)?" y || NSFW=0
    fi
  fi

  if [ -z "$VERSION" ]; then
    url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$RELEASES_URL/latest")" || die "cannot reach $RELEASES_URL"
    VERSION="${url##*/v}"
  fi
  [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "could not find out the latest version (got \"$VERSION\")"

  profiles=()
  [ "$HTTPS" = 1 ] && profiles+=(https)
  [ "$PARSER" = 1 ] && profiles+=(parser)
  [ "$NSFW" = 1 ] && profiles+=(nsfw)

  # ------------------------------------------------------------------ the plan

  echo
  bold "The installer will:"
  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    info "  - install Docker Engine and Docker Compose from download.docker.com"
  fi
  info "  - create $DIR with compose.yml and .env (random passwords and keys)"
  info "  - install the gryffi command in /usr/local/bin"
  info "  - add a daily backup at 03:17 in /etc/cron.d/gryffi (7 kept, in $DIR/backups)"
  info "  - start Gryffi $VERSION at $APP_URL"
  if [ "$HTTPS" = 1 ]; then
    info "    with HTTPS by Caddy on ports 80 and 443"
  else
    if [ "$LISTEN" = 127.0.0.1 ]; then
      info "    on 127.0.0.1:$PORT, for your reverse proxy"
    else
      info "    on $LISTEN:$PORT, without HTTPS: anyone who can reach this server on port $PORT can open Gryffi"
    fi
  fi
  info "    document parser: $([ "$PARSER" = 1 ] && echo "on (5 GB download)" || echo off), NSFW filter: $([ "$NSFW" = 1 ] && echo on || echo off)"
  echo
  confirm "Go ahead?" || die "nothing was changed"

  # ------------------------------------------------------------------ docker

  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    echo
    bold "Installing Docker"
    apt-get update -q
    apt-get install -y -q ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$OS_ID $OS_CODENAME stable" \
      > /etc/apt/sources.list.d/docker.list
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker 2>/dev/null || true
    docker compose version >/dev/null || die "Docker Compose did not install"
  fi

  # ----------------------------------------------------------------- install

  echo
  bold "Installing Gryffi $VERSION in $DIR"
  secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  for file in compose.yml gryffi; do
    curl -fsSL "$RELEASES_URL/download/v$VERSION/$file" -o "$tmp/$file" \
      || die "could not download $file of version $VERSION"
  done

  install -d -m 755 "$DIR"
  install -m 644 "$tmp/compose.yml" "$DIR/compose.yml"
  install -m 755 "$tmp/gryffi" /usr/local/bin/gryffi

  umask 077
  cat > "$DIR/.env" <<EOF
# Gryffi Community Edition, written by the installer on $(date -u +%Y-%m-%d)
# Keep a copy of this file outside the server: OAUTH_TOKEN_KEY is needed to
# read the API keys in a restored backup.
GRYFFI_VERSION=$VERSION
APP_URL=$APP_URL
GRYFFI_DOMAIN=$DOMAIN
COMPOSE_PROFILES=$(IFS=,; echo "${profiles[*]}")
GRYFFI_PORT=$PORT
GRYFFI_LISTEN=$LISTEN
DB_PASSWORD=$(secret 24)
APP_DB_PASSWORD=$(secret 24)
REDIS_PASSWORD=$(secret 24)
SESSION_SECRET=$(secret 32)
OAUTH_TOKEN_KEY=$(secret 32)
GRYFFI_BACKUP_KEEP=7
EOF
  [ -n "${GRYFFI_IMAGE:-}" ] && echo "GRYFFI_IMAGE=$GRYFFI_IMAGE" >> "$DIR/.env"
  umask 022
  chmod 600 "$DIR/.env"

  cat > /etc/cron.d/gryffi <<EOF
# Daily backup of Gryffi (gryffi backup), see GRYFFI_BACKUP_KEEP in $DIR/.env
17 3 * * * root GRYFFI_HOME=$DIR /usr/local/bin/gryffi backup --auto >> /var/log/gryffi-backup.log 2>&1
EOF

  compose() { docker compose --project-directory "$DIR" -f "$DIR/compose.yml" "$@"; }
  if [ "$PARSER" = 1 ]; then size="about 6 GB"; else size="about 1 GB"; fi
  info "Downloading the images ($size). On a slow connection this takes a while."
  compose pull || die "could not download the images"
  compose up -d || die "the containers did not start; see: gryffi logs"

  info "Waiting for Gryffi to start..."
  started=0
  for _ in $(seq 1 60); do
    if compose exec -T app wget -q -O /dev/null http://localhost:3000/health < /dev/null 2>/dev/null; then started=1; break; fi
    sleep 5
  done
  [ "$started" = 1 ] || die "Gryffi did not start within 5 minutes; see: gryffi logs app"

  link="$(GRYFFI_HOME="$DIR" /usr/local/bin/gryffi setup-code < /dev/null | grep -o 'http[^ ]*setup?code=[^ ]*' || true)"

  echo
  bold "Gryffi is running."
  echo
  if [ -n "$link" ]; then
    info "Open this link to set up Gryffi (it works for 72 hours):"
    echo
    bold "  $link"
  else
    info "Get a link to the setup wizard with: gryffi setup-code"
  fi
  echo
  info "Useful commands: gryffi status, gryffi logs, gryffi update, gryffi backup, gryffi doctor"
  info "Keep a copy of $DIR/.env in a safe place."
  [ "$HTTPS" = 1 ] && info "The first visit can take a minute while Caddy gets the HTTPS certificate."
  exit 0
}

main "$@"
