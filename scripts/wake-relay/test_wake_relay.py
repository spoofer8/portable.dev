import http.client
import importlib.util
import io
import os
import socket
import threading
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("wake_relay.py")
SPEC = importlib.util.spec_from_file_location("wake_relay", MODULE_PATH)
assert SPEC and SPEC.loader
wake_relay = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wake_relay)


VALID_ENV = {
    "WAKE_RELAY_TOKEN": "11" * 32,
    "WAKE_RELAY_MAC": "02:00:00:00:00:01",
    "WAKE_RELAY_BROADCAST": "192.0.2.255",
    "WAKE_RELAY_INTERFACE": "eth0",
}


class ConfigTests(unittest.TestCase):
    def test_config_requires_a_256_bit_hex_token(self):
        with self.assertRaisesRegex(ValueError, "64 hexadecimal"):
            wake_relay.RelayConfig.from_env({**VALID_ENV, "WAKE_RELAY_TOKEN": "short"})

    def test_config_normalizes_the_fixed_target(self):
        config = wake_relay.RelayConfig.from_env(VALID_ENV)

        self.assertEqual(config.mac, bytes.fromhex("020000000001"))
        self.assertEqual(config.broadcast, "192.0.2.255")
        self.assertEqual(config.interface, "eth0")
        self.assertEqual(config.listen_host, "127.0.0.1")


class MagicPacketTests(unittest.TestCase):
    def test_magic_packet_has_six_ff_bytes_and_sixteen_mac_repetitions(self):
        mac = bytes.fromhex("020000000001")

        self.assertEqual(wake_relay.build_magic_packet(mac), b"\xff" * 6 + mac * 16)

    def test_sender_binds_to_configured_interface_address_and_repeats_packets(self):
        fake_socket = mock.MagicMock()
        fake_socket.__enter__.return_value = fake_socket
        config = wake_relay.RelayConfig.from_env(VALID_ENV)

        with mock.patch.object(
            wake_relay,
            "interface_network",
            return_value=("192.0.2.10", "192.0.2.255"),
        ), mock.patch.object(wake_relay.socket, "socket", return_value=fake_socket):
            wake_relay.send_magic_packets(config, sleep=lambda _seconds: None)

        fake_socket.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        fake_socket.bind.assert_called_once_with(("192.0.2.10", 0))
        self.assertEqual(fake_socket.sendto.call_count, wake_relay.PACKET_COUNT)
        fake_socket.sendto.assert_called_with(
            wake_relay.build_magic_packet(config.mac), ("192.0.2.255", wake_relay.WOL_PORT)
        )

    def test_sender_rejects_a_broadcast_outside_the_interface_network(self):
        config = wake_relay.RelayConfig.from_env(VALID_ENV)

        with mock.patch.object(
            wake_relay,
            "interface_network",
            return_value=("192.0.2.10", "192.0.2.127"),
        ):
            with self.assertRaisesRegex(OSError, "does not match"):
                wake_relay.send_magic_packets(config, sleep=lambda _seconds: None)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.now = 100.0
        config = wake_relay.RelayConfig.from_env(VALID_ENV)
        app = wake_relay.WakeRelay(
            config,
            sender=lambda _config: self.sent.append("sent"),
            clock=lambda: self.now,
        )
        self.server = wake_relay.create_server(config, app=app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, method, path, *, token=None, body=None):
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, response.getheaders(), payload

    def wake_request(self):
        with mock.patch("sys.stdout", io.StringIO()):
            return self.request("POST", "/v1/wake", token=VALID_ENV["WAKE_RELAY_TOKEN"])

    def test_health_is_public_and_contains_no_target_details(self):
        status, headers, payload = self.request("GET", "/health")

        self.assertEqual(status, 200)
        self.assertEqual(payload, b'{"status":"ok"}\n')
        self.assertNotIn(VALID_ENV["WAKE_RELAY_MAC"].encode(), payload)
        self.assertIn(("Cache-Control", "no-store"), headers)

    def test_wake_requires_the_exact_bearer_token(self):
        for token in (None, "22" * 32, "11" * 31):
            status, _, _ = self.request("POST", "/v1/wake", token=token)
            self.assertEqual(status, 401)

        self.assertEqual(self.sent, [])

    def test_wake_is_idempotent_during_the_cooldown(self):
        first_status, _, first_payload = self.wake_request()
        second_status, _, second_payload = self.wake_request()

        self.assertEqual((first_status, second_status), (202, 202))
        self.assertEqual(first_payload, b'{"status":"accepted"}\n')
        self.assertEqual(second_payload, b'{"status":"accepted"}\n')
        self.assertEqual(self.sent, ["sent"])

        self.now += 31
        status, _, _ = self.wake_request()
        self.assertEqual(status, 202)
        self.assertEqual(self.sent, ["sent", "sent"])

    def test_wake_rejects_request_bodies_and_other_methods(self):
        status, _, _ = self.request(
            "POST", "/v1/wake", token=VALID_ENV["WAKE_RELAY_TOKEN"], body=b"unexpected"
        )
        self.assertEqual(status, 400)

        status, headers, _ = self.request("GET", "/v1/wake")
        self.assertEqual(status, 405)
        self.assertIn(("Allow", "POST"), headers)

    def test_failed_wake_attempt_is_rate_limited(self):
        attempts = []

        def fail(_config):
            attempts.append("attempted")
            raise OSError("network unavailable")

        config = wake_relay.RelayConfig.from_env(VALID_ENV)
        app = wake_relay.WakeRelay(config, sender=fail, clock=lambda: self.now)
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.server = wake_relay.create_server(config, app=app, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

        with mock.patch("sys.stderr", io.StringIO()):
            first_status, _, _ = self.request(
                "POST", "/v1/wake", token=VALID_ENV["WAKE_RELAY_TOKEN"]
            )
            second_status, _, _ = self.request(
                "POST", "/v1/wake", token=VALID_ENV["WAKE_RELAY_TOKEN"]
            )

        self.assertEqual(first_status, 503)
        self.assertEqual(second_status, 503)
        self.assertEqual(attempts, ["attempted"])

        self.now += wake_relay.FAILURE_BACKOFF_SECONDS
        with mock.patch("sys.stderr", io.StringIO()):
            third_status, _, _ = self.request(
                "POST", "/v1/wake", token=VALID_ENV["WAKE_RELAY_TOKEN"]
            )
        self.assertEqual(third_status, 503)
        self.assertEqual(attempts, ["attempted", "attempted"])

    def test_server_does_not_log_requests_tokens_or_targets(self):
        stderr = io.StringIO()
        with mock.patch("sys.stderr", stderr):
            self.request("POST", "/v1/wake", token="22" * 32)

        output = stderr.getvalue()
        self.assertEqual(output, "")
        self.assertNotIn(VALID_ENV["WAKE_RELAY_MAC"], output)
        self.assertNotIn("22" * 32, output)


if __name__ == "__main__":
    unittest.main()
