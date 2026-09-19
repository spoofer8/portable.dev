#!/usr/bin/env bash
set +x
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RELAY_SOURCE="$SCRIPT_DIR/wake-relay"
REMOTE_SOURCE='.local/share/portable-wake-relay-source'

ssh_host=""
mac=""
broadcast=""
interface=""
https_port="443"
relay_port="8787"
cooldown="30"

usage() {
  cat <<'EOF'
Usage: setup-wake-relay.sh [options]

Deploy the fixed-target Wake-on-LAN relay to a Linux host over SSH, expose it
to the tailnet with Tailscale Serve, and configure Portable's encrypted store.

Options:
  --ssh-host HOST         SSH config alias or user@host (required)
  --mac ADDRESS           Mac network-interface MAC address (required)
  --broadcast ADDRESS     Server LAN broadcast address (required)
  --interface NAME        Server LAN interface (required)
  --https-port PORT       Tailscale Serve HTTPS port (default: 443)
  --relay-port PORT       Remote loopback relay port (default: 8787)
  --cooldown SECONDS      Minimum time between wake bursts (default: 30)
  -h, --help              Show this help

Omit required options to enter them interactively. The generated bearer token
is copied through SSH into encrypted local storage, but is never printed.
EOF
}

require_option_value() {
  if (($# < 2)) || [[ -z "$2" ]]; then
    printf 'Missing value for %s\n' "$1" >&2
    exit 2
  fi
}

while (($#)); do
  case "$1" in
    --ssh-host)
      require_option_value "$@"
      ssh_host="$2"
      shift 2
      ;;
    --mac)
      require_option_value "$@"
      mac="$2"
      shift 2
      ;;
    --broadcast)
      require_option_value "$@"
      broadcast="$2"
      shift 2
      ;;
    --interface)
      require_option_value "$@"
      interface="$2"
      shift 2
      ;;
    --https-port)
      require_option_value "$@"
      https_port="$2"
      shift 2
      ;;
    --relay-port)
      require_option_value "$@"
      relay_port="$2"
      shift 2
      ;;
    --cooldown)
      require_option_value "$@"
      cooldown="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -t 0 ]]; then
  [[ -n "$ssh_host" ]] || read -r -p 'Linux SSH host or alias: ' ssh_host
  [[ -n "$mac" ]] || read -r -p 'Mac network-interface MAC address: ' mac
  [[ -n "$broadcast" ]] || read -r -p 'Linux LAN broadcast address: ' broadcast
  [[ -n "$interface" ]] || read -r -p 'Linux LAN interface: ' interface
fi

if [[ ! "$ssh_host" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]]; then
  printf '%s\n' 'A valid --ssh-host or SSH config alias is required' >&2
  exit 2
fi
if [[ ! "$mac" =~ ^([[:xdigit:]]{2}[:-]){5}[[:xdigit:]]{2}$ ]]; then
  printf '%s\n' 'A valid --mac address is required' >&2
  exit 2
fi
if [[ ! "$broadcast" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  printf '%s\n' 'A valid --broadcast IPv4 address is required' >&2
  exit 2
fi
if [[ ! "$interface" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]]; then
  printf '%s\n' 'A valid --interface name is required' >&2
  exit 2
fi
for port_name in https_port relay_port; do
  port_value="${!port_name}"
  if [[ ! "$port_value" =~ ^[0-9]+$ ]] || ((port_value < 1 || port_value > 65535)); then
    printf '%s must be between 1 and 65535\n' "--${port_name//_/-}" >&2
    exit 2
  fi
done
if ((relay_port < 1024)); then
  printf '%s\n' '--relay-port must be at least 1024' >&2
  exit 2
fi
if [[ ! "$cooldown" =~ ^[0-9]+([.][0-9]+)?$ ]] || \
   ! awk -v value="$cooldown" 'BEGIN { exit !(value >= 1 && value <= 3600) }'; then
  printf '%s\n' '--cooldown must be between 1 and 3600 seconds' >&2
  exit 2
fi

for command_name in ssh tar curl awk python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'Required command not found: %s\n' "$command_name" >&2
    exit 1
  }
done

for source_file in \
  .dockerignore \
  Dockerfile \
  compose.yaml \
  install.sh \
  portable-wake-relay.service \
  wake_relay.py; do
  if [[ ! -f "$RELAY_SOURCE/$source_file" ]]; then
    printf 'Relay source file not found: %s\n' "$source_file" >&2
    exit 1
  fi
done

printf 'Checking SSH access to %s...\n' "$ssh_host"
ssh -- "$ssh_host" 'set -eu; command -v docker >/dev/null; command -v tailscale >/dev/null; command -v python3 >/dev/null'

printf '%s\n' 'Copying the wake relay...'
tar -C "$RELAY_SOURCE" -cf - \
  .dockerignore Dockerfile compose.yaml install.sh portable-wake-relay.service wake_relay.py |
  ssh -- "$ssh_host" "set -eu; umask 077; install -d -m 700 \"\$HOME/$REMOTE_SOURCE\"; tar -xf - -C \"\$HOME/$REMOTE_SOURCE\""

printf '%s\n' 'Installing the remote Docker service...'
ssh -- "$ssh_host" bash -s -- "$mac" "$broadcast" "$interface" "$relay_port" "$cooldown" <<'REMOTE_INSTALL'
set -euo pipefail
"$HOME/.local/share/portable-wake-relay-source/install.sh" \
  --mode docker \
  --mac "$1" \
  --broadcast "$2" \
  --interface "$3" \
  --port "$4" \
  --cooldown "$5"
REMOTE_INSTALL

printf '%s\n' 'Configuring Tailscale Serve...'
ssh -- "$ssh_host" bash -s -- "$https_port" "$relay_port" <<'REMOTE_SERVE'
set -euo pipefail
tailscale serve --yes --bg --https="$1" "http://127.0.0.1:$2"
REMOTE_SERVE

remote_dns="$(
  ssh -- "$ssh_host" \
    "tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)[\"Self\"][\"DNSName\"].rstrip(\".\"))'"
)"
if [[ ! "$remote_dns" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
  printf '%s\n' 'Could not determine the remote Tailscale DNS name' >&2
  exit 1
fi

if [[ "$https_port" == "443" ]]; then
  wake_base_url="https://$remote_dns"
else
  wake_base_url="https://$remote_dns:$https_port"
fi
wake_url="$wake_base_url/v1/wake"

umask 077
token_temp="$(mktemp "${TMPDIR:-/tmp}/portable-wake-token.XXXXXX")"
cleanup() {
  rm -f -- "$token_temp"
}
trap cleanup EXIT HUP INT TERM

ssh -- "$ssh_host" 'cat "$HOME/.config/portable-wake-relay/client-token"' > "$token_temp"
chmod 600 "$token_temp"
token="$(tr -d '\r\n' < "$token_temp")"
if [[ ! "$token" =~ ^[[:xdigit:]]{64}$ ]]; then
  printf '%s\n' 'The remote wake token was missing or invalid' >&2
  exit 1
fi

printf '%s' "$token" | bun "$REPO_ROOT/packages/launcher/src/configureWakeCapability.ts" "$wake_url"
unset token

# Remove credentials written by older versions of this installer. The encrypted
# LocalSecretStore is now the only on-Mac source of the wake capability.
legacy_env="$REPO_ROOT/.env"
if [[ -f "$legacy_env" && ! -L "$legacy_env" ]]; then
  legacy_env_temp="$(mktemp "$REPO_ROOT/.env.wake.XXXXXX")"
  awk '!/^PORTABLE_WAKE_URL=/ && !/^PORTABLE_WAKE_TOKEN=/' "$legacy_env" > "$legacy_env_temp"
  chmod 600 "$legacy_env_temp"
  mv -- "$legacy_env_temp" "$legacy_env"
fi

printf '%s\n' 'Verifying the relay through Tailscale HTTPS...'
health_ok=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  if health_response="$(curl --fail --silent --show-error --max-time 5 "$wake_base_url/health" 2>/dev/null)" && \
     [[ "$health_response" == '{"status":"ok"}' ]]; then
    health_ok=true
    break
  fi
  sleep 2
done
if [[ "$health_ok" != "true" ]]; then
  printf 'Health verification failed: %s/health\n' "$wake_base_url" >&2
  exit 1
fi

printf 'Wake relay ready: %s\n' "$wake_url"
printf '%s\n' 'Portable wake capability stored in the encrypted local secret store.'
