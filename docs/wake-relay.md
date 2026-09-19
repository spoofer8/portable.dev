# Linux wake relay

Portable cannot contact a Mac while the Mac is asleep. The wake relay solves that first hop: the
phone sends an authenticated request to the always-on Linux server, and the server broadcasts a
Wake-on-LAN magic packet on the Mac's LAN. After macOS wakes, the existing Portable connection can
start and its caffeine hook can keep the machine awake while an agent is running.

The relay has one fixed target. It does not accept a MAC address, broadcast address, or interface
from an HTTP request. It listens only on `127.0.0.1`; Tailscale Serve is the intended TLS and
tailnet-access boundary.

## Prerequisites

- Linux server on the same broadcast domain as the Mac
- Python 3.8 or newer
- Tailscale connected on the server and phone
- Docker with the Compose plugin (recommended), or a working systemd user session
- Wake for network access enabled in macOS

Find the Linux LAN interface and broadcast address without guessing:

```bash
ip -4 address
```

Use the interface connected to the Mac's LAN and that subnet's `brd` value. Do not use the
Tailscale interface: Wake-on-LAN is a local broadcast.

## Install

### Deploy from the Mac

The repository-level setup script performs the complete deployment over SSH: it copies an explicit
allowlist of relay files, runs the Docker installer, configures Tailscale Serve, retrieves the
generated token through SSH without displaying it, stores the capability in Portable's encrypted
local secret store, and checks the tailnet health endpoint.

```bash
./scripts/setup-wake-relay.sh \
  --ssh-host 'user@linux-host' \
  --mac 'aa:bb:cc:dd:ee:ff' \
  --broadcast '192.168.1.255' \
  --interface 'eth0'
```

The wake URL and token are encrypted under `~/.portable`; they are not placed in the repository or
forwarded to the API and agent subprocesses. Neither secret is printed. Normal SSH host-key
verification remains enabled. If Tailscale rejects
the Serve command, configure the SSH user as the Tailscale operator once on the server, then rerun:

```bash
sudo tailscale set --operator="$USER"
```

Use `--https-port PORT` when port 443 is already assigned to another Tailscale Serve handler.

### Install directly on Linux

Copy `scripts/wake-relay` to the Linux server, then run:

```bash
cd portable.dev/scripts/wake-relay
./install.sh \
  --mode docker \
  --mac 'aa:bb:cc:dd:ee:ff' \
  --broadcast '192.168.1.255' \
  --interface 'eth0'
```

Docker Compose is recommended. `network_mode: host` is deliberate: the process must bind the
host's loopback address and send on its LAN interface. The container runs as an unprivileged user,
drops all capabilities, has a read-only filesystem, and restarts unless stopped.
Host networking also means the container can reach other host and LAN services. Treat Docker
administrators as root-equivalent and keep the image and relay source under your control.

The installer generates a 256-bit token locally. It stores configuration at
`~/.config/portable-wake-relay/` with mode `0600` and never prints the token or MAC address. Read
`client-token` only when adding the credential to the Portable client.

For the requested systemd user deployment instead:

```bash
./install.sh \
  --mode systemd \
  --mac 'aa:bb:cc:dd:ee:ff' \
  --broadcast '192.168.1.255' \
  --interface 'eth0'
```

A systemd user unit cannot survive logout or boot until an administrator enables lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

The Docker deployment does not need user lingering, provided the Docker daemon starts at boot.

## Expose it to the tailnet

Keep the relay on loopback and let Tailscale terminate HTTPS:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
tailscale serve status
```

Do not bind the Python service to `0.0.0.0` and do not expose port 8787 through the firewall or
router. Tailnet ACLs should restrict the server's HTTPS service to the phone or the user's devices.

The API is intentionally small:

```text
GET  /health   -> 200 {"status":"ok"}
POST /v1/wake  -> 202 {"status":"accepted"}
Authorization: Bearer <64-hex-character token>
```

`POST /v1/wake` accepts no body. Requests received during the 30-second cooldown return the same
accepted response without sending another burst, so retries are safe. Each accepted request sends
five packets. A failed send returns `503`; retries are held for one second and continue to return
`503` rather than falsely reporting success. The service logs only generic send outcomes and never
logs the token, target MAC, request path, or query string.

## Verify and operate

On the server:

```bash
curl --fail http://127.0.0.1:8787/health
cd ~/.local/share/portable-wake-relay
docker compose ps
docker compose logs --tail=20
```

For systemd mode:

```bash
systemctl --user status portable-wake-relay.service
journalctl --user --unit portable-wake-relay.service --lines=20
```

Test a wake without putting the bearer token in the process list:

```bash
python3 - <<'PY'
from pathlib import Path
from urllib.request import Request, urlopen

token = (Path.home() / ".config/portable-wake-relay/client-token").read_text().strip()
request = Request(
    "http://127.0.0.1:8787/v1/wake",
    data=b"",
    headers={"Authorization": "Bearer " + token},
    method="POST",
)
print(urlopen(request, timeout=5).read().decode().strip())
PY
```

## macOS limitations

This relay can send a valid wake packet, but it cannot override Mac hardware and power policy.
Wake over Wi-Fi depends on the Mac model, access point, power source, and macOS's Wake for network
access support. A MacBook with its lid closed and no external power commonly enters a state where
Wi-Fi cannot receive Wake-on-LAN. No tunnel or background process on the sleeping Mac can change
that, because apps do not execute during full sleep.

For reliable unattended wake, use wired Ethernet through a powered adapter/dock and AC power. If
the Mac must remain unplugged with its lid closed, treat wake as best-effort and expect periods when
physical access is required.
