#!/usr/bin/env python3
"""A loopback-only, single-target Wake-on-LAN HTTP relay."""

import fcntl
import hashlib
import hmac
import ipaddress
import json
import os
import re
import socket
import socketserver
import struct
import sys
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Mapping, Optional, Tuple


LISTEN_HOST = "127.0.0.1"
DEFAULT_LISTEN_PORT = 8787
DEFAULT_COOLDOWN_SECONDS = 30.0
PACKET_COUNT = 5
PACKET_INTERVAL_SECONDS = 0.1
WOL_PORT = 9
SIOCGIFADDR = 0x8915
SIOCGIFNETMASK = 0x891B
FAILURE_BACKOFF_SECONDS = 1.0
INTERFACE_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{1,15}\Z")
TOKEN_PATTERN = re.compile(r"[0-9a-fA-F]{64}\Z")
MAC_PATTERN = re.compile(r"(?:[0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}\Z")


@dataclass(frozen=True)
class RelayConfig:
    token: str = field(repr=False)
    mac: bytes = field(repr=False)
    broadcast: str
    interface: str
    listen_host: str = LISTEN_HOST
    listen_port: int = DEFAULT_LISTEN_PORT
    cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "RelayConfig":
        token = env.get("WAKE_RELAY_TOKEN", "")
        if not TOKEN_PATTERN.fullmatch(token):
            raise ValueError("WAKE_RELAY_TOKEN must contain exactly 64 hexadecimal characters")

        mac_text = env.get("WAKE_RELAY_MAC", "")
        if not MAC_PATTERN.fullmatch(mac_text):
            raise ValueError("WAKE_RELAY_MAC must be a six-byte MAC address")
        mac = bytes.fromhex(mac_text.replace(":", "").replace("-", ""))

        broadcast_text = env.get("WAKE_RELAY_BROADCAST", "")
        try:
            broadcast_address = ipaddress.IPv4Address(broadcast_text)
        except ipaddress.AddressValueError as error:
            raise ValueError("WAKE_RELAY_BROADCAST must be an IPv4 address") from error
        if broadcast_address.is_loopback or broadcast_address.is_multicast or broadcast_address.is_unspecified:
            raise ValueError("WAKE_RELAY_BROADCAST must be a usable IPv4 broadcast address")

        interface = env.get("WAKE_RELAY_INTERFACE", "")
        if not INTERFACE_PATTERN.fullmatch(interface):
            raise ValueError("WAKE_RELAY_INTERFACE must be a valid Linux interface name")

        listen_port = _integer_setting(env, "WAKE_RELAY_PORT", DEFAULT_LISTEN_PORT, 1024, 65535)
        cooldown_seconds = _float_setting(
            env, "WAKE_RELAY_COOLDOWN_SECONDS", DEFAULT_COOLDOWN_SECONDS, 1.0, 3600.0
        )
        return cls(
            token=token,
            mac=mac,
            broadcast=str(broadcast_address),
            interface=interface,
            listen_port=listen_port,
            cooldown_seconds=cooldown_seconds,
        )


def _integer_setting(
    env: Mapping[str, str], name: str, default: int, minimum: int, maximum: int
) -> int:
    raw = env.get(name, str(default))
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError("{} must be an integer".format(name)) from error
    if not minimum <= value <= maximum:
        raise ValueError("{} must be between {} and {}".format(name, minimum, maximum))
    return value


def _float_setting(
    env: Mapping[str, str], name: str, default: float, minimum: float, maximum: float
) -> float:
    raw = env.get(name, str(default))
    try:
        value = float(raw)
    except ValueError as error:
        raise ValueError("{} must be numeric".format(name)) from error
    if not minimum <= value <= maximum:
        raise ValueError("{} must be between {} and {}".format(name, minimum, maximum))
    return value


def build_magic_packet(mac: bytes) -> bytes:
    if len(mac) != 6:
        raise ValueError("MAC address must contain six bytes")
    return b"\xff" * 6 + mac * 16


def interface_network(interface: str) -> Tuple[str, str]:
    """Resolve an interface address and broadcast without invoking a shell."""
    request = struct.pack("256s", interface.encode("ascii"))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        address_result = fcntl.ioctl(sock.fileno(), SIOCGIFADDR, request)
        netmask_result = fcntl.ioctl(sock.fileno(), SIOCGIFNETMASK, request)
    source_address = socket.inet_ntoa(address_result[20:24])
    netmask = socket.inet_ntoa(netmask_result[20:24])
    network = ipaddress.IPv4Network((source_address, netmask), strict=False)
    return source_address, str(network.broadcast_address)


def send_magic_packets(
    config: RelayConfig, sleep: Callable[[float], None] = time.sleep
) -> None:
    packet = build_magic_packet(config.mac)
    source_address, interface_broadcast = interface_network(config.interface)
    if config.broadcast != interface_broadcast:
        raise OSError("configured broadcast does not match the selected interface")
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind((source_address, 0))
        for index in range(PACKET_COUNT):
            sock.sendto(packet, (config.broadcast, WOL_PORT))
            if index + 1 < PACKET_COUNT:
                sleep(PACKET_INTERVAL_SECONDS)


class WakeRelay:
    def __init__(
        self,
        config: RelayConfig,
        sender: Callable[[RelayConfig], None] = send_magic_packets,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._config = config
        self._sender = sender
        self._clock = clock
        self._lock = threading.Lock()
        self._last_success = None  # type: Optional[float]
        self._last_failure = None  # type: Optional[float]

    def authorize(self, authorization: Optional[str]) -> bool:
        candidate = ""
        if authorization and authorization.startswith("Bearer "):
            candidate = authorization[len("Bearer ") :]
        candidate_digest = hashlib.sha256(candidate.encode("utf-8")).digest()
        expected_digest = hashlib.sha256(self._config.token.encode("ascii")).digest()
        return hmac.compare_digest(candidate_digest, expected_digest)

    def wake(self) -> bool:
        with self._lock:
            now = self._clock()
            if (
                self._last_success is not None
                and now - self._last_success < self._config.cooldown_seconds
            ):
                return False
            if (
                self._last_failure is not None
                and now - self._last_failure < FAILURE_BACKOFF_SECONDS
            ):
                raise OSError("wake temporarily unavailable")
            try:
                self._sender(self._config)
            except (OSError, RuntimeError):
                self._last_failure = now
                raise
            self._last_success = self._clock()
            self._last_failure = None
            return True


class RelayHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 8

    def __init__(self, *args, **kwargs) -> None:
        self._request_slots = threading.BoundedSemaphore(8)
        super().__init__(*args, **kwargs)

    def server_bind(self) -> None:
        # HTTPServer performs a reverse-DNS lookup here by default. The relay
        # has a fixed loopback identity, so that lookup only delays startup.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port

    def get_request(self) -> Tuple[socket.socket, Tuple[str, int]]:
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request: socket.socket, client_address: Tuple[str, int]) -> None:
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        super().process_request(request, client_address)

    def process_request_thread(
        self, request: socket.socket, client_address: Tuple[str, int]
    ) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()

    def handle_error(self, request: socket.socket, client_address: Tuple[str, int]) -> None:
        return


def handler_for(app: WakeRelay):
    class WakeRequestHandler(BaseHTTPRequestHandler):
        server_version = "PortableWakeRelay"
        sys_version = ""

        def log_message(self, _format: str, *args: object) -> None:
            return

        def log_error(self, _format: str, *args: object) -> None:
            return

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if self.path == "/v1/wake":
                self._send_json(405, {"error": "method_not_allowed"}, {"Allow": "POST"})
                return
            self._send_json(404, {"error": "not_found"})

        def do_POST(self) -> None:
            if self.path != "/v1/wake":
                self._send_json(404, {"error": "not_found"})
                return
            if not self._has_empty_body():
                self.close_connection = True
                self._send_json(400, {"error": "request_body_not_allowed"})
                return
            if not app.authorize(self.headers.get("Authorization")):
                self._send_json(
                    401,
                    {"error": "unauthorized"},
                    {"WWW-Authenticate": 'Bearer realm="wake-relay"'},
                )
                return
            try:
                sent = app.wake()
            except (OSError, RuntimeError):
                print("wake-relay packet send failed", file=sys.stderr, flush=True)
                self._send_json(503, {"error": "wake_unavailable"})
                return
            if sent:
                print("wake-relay magic packet burst sent", flush=True)
            self._send_json(202, {"status": "accepted"})

        def do_PUT(self) -> None:
            self._method_not_allowed()

        def do_DELETE(self) -> None:
            self._method_not_allowed()

        def do_PATCH(self) -> None:
            self._method_not_allowed()

        def _method_not_allowed(self) -> None:
            if self.path == "/v1/wake":
                self._send_json(405, {"error": "method_not_allowed"}, {"Allow": "POST"})
            else:
                self._send_json(404, {"error": "not_found"})

        def _has_empty_body(self) -> bool:
            if self.headers.get("Transfer-Encoding"):
                return False
            raw_length = self.headers.get("Content-Length", "0")
            try:
                return int(raw_length) == 0
            except ValueError:
                return False

        def _send_json(self, status: int, value: object, extra_headers=None) -> None:
            payload = json.dumps(value, separators=(",", ":")).encode("utf-8") + b"\n"
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            if extra_headers:
                for name, header_value in extra_headers.items():
                    self.send_header(name, header_value)
            self.end_headers()
            self.wfile.write(payload)

    return WakeRequestHandler


def create_server(
    config: RelayConfig, app: Optional[WakeRelay] = None, port: Optional[int] = None
) -> RelayHTTPServer:
    relay = app or WakeRelay(config)
    listen_port = config.listen_port if port is None else port
    return RelayHTTPServer((LISTEN_HOST, listen_port), handler_for(relay))


def main() -> int:
    try:
        config = RelayConfig.from_env(os.environ)
        server = create_server(config)
    except (OSError, ValueError) as error:
        print("wake-relay configuration failed: {}".format(error), file=sys.stderr)
        return 2

    print("wake-relay listening on 127.0.0.1:{}".format(config.listen_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
