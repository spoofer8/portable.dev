#!/usr/bin/env bash
set +x
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/share/portable-wake-relay"
CONFIG_DIR="$HOME/.config/portable-wake-relay"
USER_UNIT_DIR="$HOME/.config/systemd/user"

mode="docker"
mac="${WAKE_RELAY_MAC:-}"
broadcast="${WAKE_RELAY_BROADCAST:-}"
interface="${WAKE_RELAY_INTERFACE:-}"
port="${WAKE_RELAY_PORT:-8787}"
cooldown="${WAKE_RELAY_COOLDOWN_SECONDS:-30}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Installs a fixed-target Wake-on-LAN relay. The bearer token is generated
locally and is never accepted as a command-line argument.

Options:
  --mode docker|systemd  Deployment mode (default: docker)
  --mac ADDRESS          Target MAC address
  --broadcast ADDRESS    LAN broadcast address
  --interface NAME       Linux LAN interface used for broadcasts
  --port PORT            Loopback HTTP port (default: 8787)
  --cooldown SECONDS     Minimum time between packet bursts (default: 30)
  -h, --help             Show this help
EOF
}

while (($#)); do
  case "$1" in
    --mode) mode="${2:-}"; shift 2 ;;
    --mac) mac="${2:-}"; shift 2 ;;
    --broadcast) broadcast="${2:-}"; shift 2 ;;
    --interface) interface="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --cooldown) cooldown="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$mode" != "docker" && "$mode" != "systemd" ]]; then
  printf '%s\n' '--mode must be docker or systemd' >&2
  exit 2
fi

if [[ -t 0 ]]; then
  [[ -n "$mac" ]] || read -r -p 'Mac Ethernet/Wi-Fi MAC address: ' mac
  [[ -n "$broadcast" ]] || read -r -p 'LAN broadcast address: ' broadcast
  [[ -n "$interface" ]] || read -r -p 'Linux LAN interface: ' interface
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
if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
  printf '%s\n' '--port must be between 1024 and 65535' >&2
  exit 2
fi
if [[ ! "$cooldown" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  printf '%s\n' '--cooldown must be a positive number' >&2
  exit 2
fi
if ! awk -v value="$cooldown" 'BEGIN { exit !(value >= 1 && value <= 3600) }'; then
  printf '%s\n' '--cooldown must be between 1 and 3600 seconds' >&2
  exit 2
fi
command -v ip >/dev/null 2>&1 || { printf '%s\n' 'iproute2 is required' >&2; exit 1; }
if ! ip link show dev "$interface" >/dev/null 2>&1; then
  printf 'Interface does not exist: %s\n' "$interface" >&2
  exit 2
fi
if ! ip -4 address show dev "$interface" | grep -q 'inet '; then
  printf 'Interface has no IPv4 address: %s\n' "$interface" >&2
  exit 2
fi
interface_broadcasts="$(
  ip -o -4 address show dev "$interface" |
    awk '{ for (field = 1; field <= NF; field++) if ($field == "brd") print $(field + 1) }'
)"
if ! grep -Fqx -- "$broadcast" <<<"$interface_broadcasts"; then
  printf '%s\n' 'Broadcast address does not match the selected interface' >&2
  exit 2
fi

umask 077
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR"
chmod 700 "$INSTALL_DIR" "$CONFIG_DIR"

token_file="$CONFIG_DIR/client-token"
if [[ -f "$token_file" ]]; then
  if [[ -L "$token_file" || ! -f "$token_file" ]]; then
    printf '%s\n' 'Existing client-token must be a regular, non-symlink file' >&2
    exit 2
  fi
  chmod 600 "$token_file"
  token="$(tr -d '\r\n' < "$token_file")"
  if [[ ! "$token" =~ ^[[:xdigit:]]{64}$ ]]; then
    printf '%s\n' 'Existing client-token is invalid; remove it and rerun the installer' >&2
    exit 2
  fi
else
  token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  token_temp="$(mktemp "$CONFIG_DIR/client-token.tmp.XXXXXX")"
  printf '%s\n' "$token" > "$token_temp"
  mv "$token_temp" "$token_file"
  chmod 600 "$token_file"
fi

environment_file="$CONFIG_DIR/env"
if [[ -e "$environment_file" || -L "$environment_file" ]] && \
   { [[ -L "$environment_file" ]] || [[ ! -f "$environment_file" ]]; }; then
  printf '%s\n' 'Existing environment file must be a regular, non-symlink file' >&2
  exit 2
fi
environment_temp="$(mktemp "$CONFIG_DIR/env.tmp.XXXXXX")"
{
  printf 'WAKE_RELAY_TOKEN=%s\n' "$token"
  printf 'WAKE_RELAY_MAC=%s\n' "$mac"
  printf 'WAKE_RELAY_BROADCAST=%s\n' "$broadcast"
  printf 'WAKE_RELAY_INTERFACE=%s\n' "$interface"
  printf 'WAKE_RELAY_PORT=%s\n' "$port"
  printf 'WAKE_RELAY_COOLDOWN_SECONDS=%s\n' "$cooldown"
} > "$environment_temp"
mv "$environment_temp" "$environment_file"
chmod 600 "$environment_file"
unset token

install -m 755 "$SCRIPT_DIR/wake_relay.py" "$INSTALL_DIR/wake_relay.py"

if [[ "$mode" == "docker" ]]; then
  command -v docker >/dev/null 2>&1 || { printf '%s\n' 'docker is required' >&2; exit 1; }
  docker compose version >/dev/null 2>&1 || { printf '%s\n' 'docker compose is required' >&2; exit 1; }
  install -m 644 "$SCRIPT_DIR/Dockerfile" "$INSTALL_DIR/Dockerfile"
  install -m 644 "$SCRIPT_DIR/.dockerignore" "$INSTALL_DIR/.dockerignore"
  install -m 644 "$SCRIPT_DIR/compose.yaml" "$INSTALL_DIR/compose.yaml"
  if [[ -e "$INSTALL_DIR/.env" || -L "$INSTALL_DIR/.env" ]] && \
     { [[ -L "$INSTALL_DIR/.env" ]] || [[ ! -f "$INSTALL_DIR/.env" ]]; }; then
    printf '%s\n' 'Existing Docker environment file must be a regular, non-symlink file' >&2
    exit 2
  fi
  install -m 600 "$environment_file" "$INSTALL_DIR/.env"
  (
    cd "$INSTALL_DIR"
    docker compose up --detach --build
  )
else
  command -v systemctl >/dev/null 2>&1 || { printf '%s\n' 'systemctl is required' >&2; exit 1; }
  mkdir -p "$USER_UNIT_DIR"
  install -m 644 "$SCRIPT_DIR/portable-wake-relay.service" \
    "$USER_UNIT_DIR/portable-wake-relay.service"
  systemctl --user daemon-reload
  systemctl --user enable --now portable-wake-relay.service
  if command -v loginctl >/dev/null 2>&1 && \
     [[ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || true)" != "yes" ]]; then
    printf '%s\n' 'Warning: user lingering is disabled; an administrator must run:' >&2
    printf '  sudo loginctl enable-linger %q\n' "$USER" >&2
  fi
fi

printf '%s\n' 'Wake relay installed without printing its token or target address.'
printf 'Health check: curl --fail http://127.0.0.1:%s/health\n' "$port"
printf 'Client token: %s\n' "$token_file"
