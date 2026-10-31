import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "tools"))

import firefox_release_watch as w  # noqa: E402


class VersionTests(unittest.TestCase):
    def test_compare(self):
        self.assertTrue(w.is_newer("159.0.1", "159.0"))
        self.assertTrue(w.is_newer("160.0", "159.0.1"))
        self.assertFalse(w.is_newer("159.0", "159.0"))
        self.assertFalse(w.is_newer("159.0", "159.0.1"))
        self.assertFalse(w.is_newer("158.0.2", "159.0"))

    def test_issue_text_mentions_versions_and_commands(self):
        title, body = w.issue_text("159.0", "159.0.1", {"LAST_RELEASE_DATE": "2026-11-06"})
        self.assertIn("159.0.1", title)
        self.assertIn("tools/amaya rebase 159.0.1", body)
        self.assertIn("point release", body)
        self.assertIn("major release", w.issue_text("159.0", "160.0", {})[1])


class CliTests(unittest.TestCase):
    def run_cli(self, pinned, latest):
        with tempfile.TemporaryDirectory() as d:
            up = Path(d, "upstream.json")
            up.write_text(json.dumps({"version": pinned}))
            vj = Path(d, "versions.json")
            vj.write_text(json.dumps({"LATEST_FIREFOX_VERSION": latest, "LAST_RELEASE_DATE": "2026-11-06"}))
            out = subprocess.run(
                [sys.executable, str(REPO / "tools/firefox_release_watch.py"),
                 "--upstream", str(up), "--versions-json", str(vj)],
                capture_output=True, text=True, check=True).stdout
            return json.loads(out)

    def test_newer(self):
        r = self.run_cli("159.0", "160.0")
        self.assertTrue(r["newer"])
        self.assertIn("Firefox 160.0 is out", r["title"])

    def test_same(self):
        r = self.run_cli("159.0", "159.0")
        self.assertFalse(r["newer"])
        self.assertNotIn("title", r)


if __name__ == "__main__":
    unittest.main()
