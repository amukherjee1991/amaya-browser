import json
import os
import tempfile
import unittest

from allowlist import Allowlist, AllowlistError, normalize_host

HERE = os.path.dirname(os.path.abspath(__file__))


def al(*entries):
    return Allowlist({"version": 1, "entries": list(entries)})


class NormalizeTest(unittest.TestCase):
    def test_case_dot_brackets(self):
        self.assertEqual(normalize_host("Example.COM."), "example.com")
        self.assertEqual(normalize_host("[2001:DB8::1]"), "2001:db8::1")
        self.assertEqual(normalize_host("2001:0db8:0:0::1"), "2001:db8::1")


class MatchTest(unittest.TestCase):
    def test_exact_host_and_port(self):
        a = al({"host": "firefox.settings.services.mozilla.com", "port": 443})
        self.assertIsNotNone(a.match("firefox.settings.services.mozilla.com", 443))
        self.assertIsNotNone(a.match("FIREFOX.settings.services.mozilla.com.", 443))
        self.assertIsNone(a.match("firefox.settings.services.mozilla.com", 80))
        self.assertIsNone(a.match("x.firefox.settings.services.mozilla.com", 443))
        self.assertIsNone(a.match("settings.services.mozilla.com", 443))

    def test_single_label_wildcard(self):
        a = al({"host": "*.cdn.mozilla.net", "port": 443})
        self.assertIsNotNone(a.match("firefox-settings-attachments.cdn.mozilla.net", 443))
        self.assertIsNone(a.match("cdn.mozilla.net", 443))
        self.assertIsNone(a.match("a.b.cdn.mozilla.net", 443))
        self.assertIsNone(a.match("evilcdn.mozilla.net", 443))
        self.assertIsNone(a.match("x.cdn.mozilla.net.evil.com", 443))

    def test_deep_wildcard(self):
        a = al({"host": "**.cdn.mozilla.net", "port": 443})
        self.assertIsNotNone(a.match("a.b.cdn.mozilla.net", 443))
        self.assertIsNotNone(a.match("a.cdn.mozilla.net", 443))
        self.assertIsNone(a.match("cdn.mozilla.net", 443))

    def test_ports_list_and_any(self):
        a = al({"host": "a.example.com", "ports": [80, 443]}, {"host": "b.example.com"})
        self.assertIsNotNone(a.match("a.example.com", 80))
        self.assertIsNone(a.match("a.example.com", 8080))
        self.assertIsNotNone(a.match("b.example.com", 1234))
        self.assertEqual(len(a.warnings()), 1)

    def test_dns_only_matches_host(self):
        a = al({"host": "a.example.com", "port": 443})
        self.assertIsNotNone(a.match("a.example.com", None))
        self.assertIsNone(a.match("b.example.com", None))

    def test_ip_literal(self):
        a = al({"host": "2001:db8::1", "port": 443})
        self.assertIsNotNone(a.match("[2001:0db8::1]", 443))

    def test_first_match_returned(self):
        a = al({"host": "a.example.com", "port": 443}, {"host": "*.example.com", "port": 443})
        self.assertEqual(a.match("a.example.com", 443).index, 0)
        self.assertEqual(a.match("b.example.com", 443).index, 1)


class DenyTest(unittest.TestCase):
    def test_known_bad(self):
        a = Allowlist({"version": 1, "entries": [{"host": "a.example", "port": 443}],
                       "deny": ["incoming.telemetry.mozilla.org", "*.ads.example"]})
        self.assertTrue(a.is_known_bad("Incoming.Telemetry.Mozilla.org"))
        self.assertTrue(a.is_known_bad("x.ads.example"))
        self.assertFalse(a.is_known_bad("a.example"))

    def test_contradiction_rejected(self):
        with self.assertRaises(AllowlistError):
            Allowlist({"version": 1, "entries": [{"host": "a.example", "port": 443}],
                       "deny": ["a.example"]})
        with self.assertRaises(AllowlistError):
            Allowlist({"version": 1, "entries": [], "deny": "a.example"})


class ValidationTest(unittest.TestCase):
    def bad(self, data):
        with self.assertRaises(AllowlistError):
            Allowlist(data)

    def test_rejects(self):
        self.bad({"version": 2, "entries": []})
        self.bad({"version": 1})
        self.bad({"version": 1, "entries": [{"port": 443}]})
        self.bad({"version": 1, "entries": [{"host": "*", "port": 443}]})
        self.bad({"version": 1, "entries": [{"host": "*.com", "port": 443}]})
        self.bad({"version": 1, "entries": [{"host": "a.*.com", "port": 443}]})
        self.bad({"version": 1, "entries": [{"host": "a*.example.com", "port": 443}]})
        self.bad({"version": 1, "entries": [{"host": "a.example.com", "port": 0}]})
        self.bad({"version": 1, "entries": [{"host": "a.example.com", "port": "443"}]})
        self.bad({"version": 1, "entries": [{"host": "a.example.com", "port": True}]})
        self.bad({"version": 1, "entries": [{"host": "a.example.com", "port": 1, "ports": [2]}]})
        self.bad({"version": 1, "entries": [{"host": "a.example.com", "phase": "boot"}]})

    def test_load_errors(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{not json")
        try:
            with self.assertRaises(AllowlistError):
                Allowlist.load(f.name)
        finally:
            os.unlink(f.name)
        with self.assertRaises(AllowlistError):
            Allowlist.load("/nonexistent/allowlist.json")

    def test_shipped_allowlist_is_valid_and_strict(self):
        path = os.path.join(HERE, "allowlist.json")
        a = Allowlist.load(path)
        self.assertEqual(a.warnings(), [])
        with open(path) as f:
            raw = json.load(f)
        for e in raw["entries"]:
            for k in ("host", "port", "purpose", "phase", "source"):
                self.assertIn(k, e)
        self.assertIsNone(a.match("incoming.telemetry.mozilla.org", 443))
        self.assertIsNone(a.match("push.services.mozilla.com", 443))
        self.assertTrue(all(e.get("provisional") for e in raw["entries"]))
        self.assertTrue(a.is_known_bad("incoming.telemetry.mozilla.org"))


if __name__ == "__main__":
    unittest.main()
