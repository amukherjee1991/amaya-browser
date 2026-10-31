import socket
import unittest

from events import EventLog
from logproxy import LoggingProxy, parse_request_head, split_authority


class ParseTest(unittest.TestCase):
    def test_connect(self):
        r = parse_request_head(b"CONNECT push.services.mozilla.com:443 HTTP/1.1\r\n"
                               b"Host: push.services.mozilla.com:443")
        self.assertEqual((r["method"], r["host"], r["port"], r["url"]),
                         ("CONNECT", "push.services.mozilla.com", 443, None))

    def test_connect_ipv6(self):
        r = parse_request_head(b"CONNECT [2001:db8::1]:8443 HTTP/1.1")
        self.assertEqual((r["host"], r["port"]), ("2001:db8::1", 8443))

    def test_connect_needs_port(self):
        with self.assertRaises(ValueError):
            parse_request_head(b"CONNECT example.com HTTP/1.1")

    def test_absolute_form(self):
        r = parse_request_head(b"GET http://detectportal.firefox.com/canonical.html HTTP/1.1\r\n"
                               b"Host: detectportal.firefox.com")
        self.assertEqual((r["method"], r["host"], r["port"]),
                         ("GET", "detectportal.firefox.com", 80))
        self.assertEqual(r["url"], "http://detectportal.firefox.com/canonical.html")
        r = parse_request_head(b"POST http://Example.com:8080/x HTTP/1.1")
        self.assertEqual((r["host"], r["port"]), ("example.com", 8080))

    def test_origin_form_uses_host_header(self):
        r = parse_request_head(b"GET /x HTTP/1.1\r\nHost: a.example:81")
        self.assertEqual((r["host"], r["port"]), ("a.example", 81))

    def test_garbage(self):
        for head in (b"", b"\x16\x03\x01\x02\x00", b"GET / HTTP/1.1", b"HELLO"):
            with self.assertRaises((ValueError, IndexError)):
                parse_request_head(head)

    def test_split_authority(self):
        self.assertEqual(split_authority("user:pw@h.example:99"), ("h.example", 99))
        self.assertEqual(split_authority("h.example.", 80), ("h.example", 80))
        with self.assertRaises(ValueError):
            split_authority("h.example:70000")


class LiveProxyTest(unittest.TestCase):
    def setUp(self):
        self.log = EventLog()
        self.proxy = LoggingProxy(self.log).start()

    def tearDown(self):
        self.proxy.stop()

    def roundtrip(self, data):
        with socket.create_connection(("127.0.0.1", self.proxy.port), timeout=5) as s:
            s.sendall(data)
            out = b""
            while True:
                chunk = s.recv(4096)
                if not chunk:
                    return out
                out += chunk

    def test_connect_is_logged_and_blocked(self):
        resp = self.roundtrip(b"CONNECT incoming.telemetry.mozilla.org:443 HTTP/1.1\r\n"
                              b"Host: incoming.telemetry.mozilla.org:443\r\n\r\n")
        self.assertTrue(resp.startswith(b"HTTP/1.1 403"))
        ev = [e for e in self.log.events if e["via"] == "proxy"]
        self.assertEqual(len(ev), 1)
        self.assertEqual((ev[0]["host"], ev[0]["port"], ev[0]["detail"]["method"]),
                         ("incoming.telemetry.mozilla.org", 443, "CONNECT"))

    def test_http_is_logged_with_url(self):
        resp = self.roundtrip(b"GET http://detectportal.firefox.com/success.txt?ipv4 HTTP/1.1\r\n"
                              b"Host: detectportal.firefox.com\r\n\r\n")
        self.assertTrue(resp.startswith(b"HTTP/1.1 403"))
        ev = self.log.events[-1]
        self.assertEqual(ev["detail"]["url"], "http://detectportal.firefox.com/success.txt?ipv4")

    def test_garbage_is_an_anomaly(self):
        resp = self.roundtrip(b"\x16\x03\x01garbage\r\n\r\n")
        self.assertTrue(resp.startswith(b"HTTP/1.1 400"))
        self.assertIsNone(self.log.events[-1]["host"])
        self.assertIn("error", self.log.events[-1]["detail"])

    def test_nothing_is_forwarded(self):
        # A listener standing in for "the internet": the proxy must never connect to it.
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        srv.settimeout(0.5)
        port = srv.getsockname()[1]
        self.roundtrip(b"CONNECT 127.0.0.1:%d HTTP/1.1\r\n\r\n" % port)
        with self.assertRaises(socket.timeout):
            srv.accept()
        srv.close()


if __name__ == "__main__":
    unittest.main()
