import json
import os
import tempfile
import unittest

from allowlist import Allowlist
from events import EventLog, read_jsonl
import harness
import netns_runner
import report


def ev(t, via, host, port=None, proto="tcp", scenario="idle", stage="run", **detail):
    e = {"t": t, "via": via, "host": host, "port": port, "proto": proto,
         "scenario": scenario, "stage": stage}
    if detail:
        e["detail"] = detail
    return e


ALLOW = Allowlist({"version": 1, "entries": [
    {"host": "firefox.settings.services.mozilla.com", "port": 443, "purpose": "rs",
     "phase": "first-run", "source": "x", "provisional": True}]})


class AggregateTest(unittest.TestCase):
    def test_merges_layers_and_keeps_first_seen(self):
        events = [
            ev(2.0, "proxy", "push.services.mozilla.com", 443, method="CONNECT"),
            ev(1.0, "dns", "push.services.mozilla.com", None, "dns", qtype="A"),
            ev(3.0, "sinkhole", "push.services.mozilla.com", 443, "tcp", ip="198.18.0.10"),
            ev(5.0, "proxy", "push.services.mozilla.com", 443, method="CONNECT"),
            ev(0.5, "proxy", "localhost", 8080),
            ev(0.6, "sinkhole", "127.0.0.1", 9, "udp"),
            ev(0.7, "harness", None, None, None, kind="note"),
        ]
        dests, ignored, anomalies, notes = report.aggregate(events)
        by = {(d["host"], d["port"], d["transport"]): d for d in dests}
        self.assertEqual(set(by), {("push.services.mozilla.com", 443, "tcp"),
                                   ("push.services.mozilla.com", None, "dns")})
        tcp = by[("push.services.mozilla.com", 443, "tcp")]
        self.assertEqual(tcp["observed_via"], ["proxy", "sinkhole"])
        self.assertEqual(tcp["first_seen"]["t"], 2.0)
        self.assertEqual(tcp["count"], 3)
        self.assertEqual(tcp["details"]["methods"], ["CONNECT"])
        self.assertEqual(len(ignored), 2)
        self.assertEqual((len(anomalies), len(notes)), (0, 1))


class BuildReportTest(unittest.TestCase):
    def test_pass_when_everything_allowed(self):
        r = report.build_report(
            [ev(1, "proxy", "firefox.settings.services.mozilla.com", 443),
             ev(0.5, "dns", "firefox.settings.services.mozilla.com", None, "dns")], ALLOW)
        self.assertEqual(r["result"], "pass")
        self.assertEqual(r["summary"]["denied"], 0)
        self.assertTrue(all(d["matched_entry"]["index"] == 0 for d in r["destinations"]))

    def test_fail_on_unlisted_host_or_port(self):
        r = report.build_report(
            [ev(1, "proxy", "firefox.settings.services.mozilla.com", 80),
             ev(2, "sinkhole", "incoming.telemetry.mozilla.org", 443, "tcp")], ALLOW)
        self.assertEqual(r["result"], "fail")
        self.assertEqual(r["summary"]["denied_hosts"],
                         ["firefox.settings.services.mozilla.com",
                          "incoming.telemetry.mozilla.org"])

    def test_anomaly_fails(self):
        r = report.build_report([ev(1, "proxy", None, None, error="unparseable")], ALLOW)
        self.assertEqual(r["result"], "fail")

    def test_empty_passes_and_renders(self):
        r = report.build_report([], ALLOW, {"browser": "/x/amaya", "scenarios": ["idle"]})
        self.assertEqual(r["result"], "pass")
        self.assertIn("no outbound destinations observed", report.render_text(r))

    def test_text_and_json_roundtrip(self):
        r = report.build_report(
            [ev(1.25, "proxy", "incoming.telemetry.mozilla.org", 443),
             ev(3, "sinkhole", "2001:db8::1", 443, "udp", stage="shutdown"),
             ev(0.5, "dns", "example.org", None, "dns")], ALLOW,
            {"browser": "/x/firefox", "product": "Firefox", "version": "159.0",
             "layers": ["proxy", "dns", "sinkhole"]})
        txt = report.render_text(r)
        self.assertIn("FAIL", txt)
        self.assertIn("incoming.telemetry.mozilla.org:443/tcp", txt)
        self.assertIn("[2001:db8::1]:443/udp", txt)
        self.assertIn("(shutdown)", txt)
        self.assertIn("example.org (lookup)", txt)
        json.loads(json.dumps(r))


class EventLogTest(unittest.TestCase):
    def test_jsonl_roundtrip_tolerates_truncation(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "events.jsonl")
            log = EventLog(p)
            log.start_clock("idle")
            log.record("proxy", "a.example", 443, method="CONNECT")
            log.close()
            with open(p, "a") as f:
                f.write('{"t": 1, "via": "pro')
            evs = read_jsonl(p)
            self.assertEqual(len(evs), 1)
            self.assertEqual(evs[0]["scenario"], "idle")


class HarnessArgsTest(unittest.TestCase):
    def test_defaults(self):
        a = harness.parse_args(["/x/amaya"])
        self.assertEqual((a.duration, a.scenarios), (300, ["idle"]))
        self.assertTrue(a.allowlist.endswith("tests/privacy/allowlist.json"))

    def test_scenarios(self):
        self.assertEqual(harness.parse_args(["b", "--scenario", "all"]).scenarios,
                         ["idle", "newtab", "restart"])
        self.assertEqual(harness.parse_args(["b", "--scenario", "newtab,idle"]).scenarios,
                         ["newtab", "idle"])

    def test_bad_args_exit_2(self):
        for argv in (["b", "--scenario", "bogus"], ["b", "--duration", "1"], []):
            with self.assertRaises(SystemExit) as cm:
                with open(os.devnull, "w") as devnull:
                    import contextlib
                    with contextlib.redirect_stderr(devnull):
                        harness.parse_args(argv)
            self.assertEqual(cm.exception.code, 2)

    def test_missing_binary_is_harness_error(self):
        import contextlib
        import io
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(harness.main(["/nonexistent/amaya", "--duration", "5"]), 2)


class UserJsTest(unittest.TestCase):
    def test_only_proxy_prefs(self):
        js = netns_runner.user_js(3128, False)
        prefs = [l.split('"')[1] for l in js.splitlines() if l.startswith("user_pref")]
        self.assertTrue(prefs)
        self.assertTrue(all(p.startswith("network.proxy.") for p in prefs), prefs)
        self.assertIn('user_pref("network.proxy.ssl_port", 3128);', js)
        self.assertIn('user_pref("network.proxy.failover_direct", false);', js)

    def test_marionette_only_adds_recommended_prefs_off(self):
        js = netns_runner.user_js(None, True)
        prefs = [l.split('"')[1] for l in js.splitlines() if l.startswith("user_pref")]
        self.assertEqual(prefs, ["remote.prefs.recommended"])


if __name__ == "__main__":
    unittest.main()
