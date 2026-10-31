"""Tests for packaging/debian/apt-repo/build-apt-repo.py (needs dpkg-deb,
apt-ftparchive and gpg; skipped when they are missing)."""

import gzip
import importlib.util
import os
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "packaging/debian/apt-repo/build-apt-repo.py"
TOOLS = ("dpkg-deb", "apt-ftparchive", "gpg", "dpkg")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_apt_repo", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def fake_deb(dest: Path, version: str, arch: str = "amd64") -> Path:
    root = dest / f"root-{version}-{arch}"
    (root / "DEBIAN").mkdir(parents=True)
    (root / "usr/share/doc/amaya").mkdir(parents=True)
    (root / "DEBIAN/control").write_text(
        f"Package: amaya\nVersion: {version}\nArchitecture: {arch}\n"
        "Maintainer: CI <ci@example.invalid>\nDescription: test\n test\n")
    log = (f"amaya ({version}) unstable; urgency=medium\n\n  * test\n\n"
           " -- CI <ci@example.invalid>  Sat, 31 Oct 2026 12:00:00 +0000\n")
    (root / "usr/share/doc/amaya/changelog.Debian.gz").write_bytes(gzip.compress(log.encode(), mtime=0))
    out = dest / f"amaya_{version}_{arch}.deb"
    subprocess.run(["dpkg-deb", "--root-owner-group", "-Zgzip", "--build", str(root), str(out)],
                   check=True, capture_output=True)
    return out


@unittest.skipUnless(all(shutil.which(t) for t in TOOLS), "needs dpkg-deb, apt-ftparchive, gpg")
class BuildAptRepoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = load_builder()
        cls.tmp = Path(tempfile.mkdtemp(prefix="amaya-apt-test-"))
        cls.gnupg = cls.tmp / "gnupg"
        cls.gnupg.mkdir(mode=0o700)
        env = dict(os.environ, GNUPGHOME=str(cls.gnupg))
        subprocess.run(["gpg", "--batch", "--pinentry-mode", "loopback", "--passphrase", "",
                        "--quick-gen-key", "Test <t@example.invalid>", "ed25519", "sign", "1d"],
                       env=env, check=True, capture_output=True)
        cls.debs = cls.tmp / "debs"
        cls.debs.mkdir()
        cls.versions = ["159.0-2", "159.0-3", "159.0-4", "159.0-10"]
        for v in cls.versions:
            fake_deb(cls.debs, v)

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["gpgconf", "--kill", "all"], env=dict(os.environ, GNUPGHOME=str(cls.gnupg)),
                       capture_output=True)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def build(self, repo, *debs, extra=()):
        argv = ["--repo", str(repo), "--gnupghome", str(self.gnupg), *extra]
        if debs:
            argv += ["--deb", *map(str, debs)]
        err = StringIO()
        with redirect_stderr(err):
            rc = self.mod.main(argv)
        return rc, err.getvalue()

    def test_repo_layout_signing_and_dep11(self):
        repo = self.tmp / "repo1"
        rc, _ = self.build(repo, *sorted(self.debs.glob("*.deb")))
        self.assertEqual(rc, 0)
        pool = sorted(p.name for p in (repo / "pool/main/a/amaya").glob("*.deb"))
        # Newest 3 by Debian version order (159.0-10 > 159.0-4), oldest pruned.
        self.assertEqual(pool, ["amaya_159.0-10_amd64.deb", "amaya_159.0-3_amd64.deb", "amaya_159.0-4_amd64.deb"])
        self.assertTrue((repo / "dists").is_symlink())
        dist = repo / "dists/stable"
        release = (dist / "Release").read_text()
        for f in ("main/binary-amd64/Packages.gz", "main/binary-arm64/Packages",
                  "main/dep11/Components-amd64.yml.gz", "main/dep11/Components-amd64.yml",
                  "main/dep11/icons-48x48.tar.gz", "main/dep11/icons-64x64.tar.gz",
                  "main/dep11/icons-128x128.tar.gz"):
            self.assertIn(f" {f}\n", release, f)
        self.assertNotIn(" InRelease\n", release)
        self.assertIn("Architectures: amd64 arm64", release)
        env = dict(os.environ, GNUPGHOME=str(self.gnupg))
        for args in (["--verify", str(dist / "InRelease")],
                     ["--verify", str(dist / "Release.gpg"), str(dist / "Release")]):
            subprocess.run(["gpg", "--batch", *args], env=env, check=True, capture_output=True)
        self.assertEqual((dist / "main/binary-arm64/Packages").read_bytes(), b"")

        yml = gzip.decompress((dist / "main/dep11/Components-amd64.yml.gz").read_bytes()).decode()
        self.assertTrue(yml.startswith("---\nFile: DEP-11\nVersion: '1.0'\nOrigin: amaya\n"))
        for line in ("ID: org.amaya.Browser", "Package: amaya", "ProjectLicense: MPL-2.0",
                     '  homepage: "https://amaya.arghyam.me"', "  - name: amaya_org.amaya.Browser.png",
                     "  - org.amaya.Browser.desktop", "  - x-scheme-handler/https"):
            self.assertIn(line + "\n", yml)
        # Releases: the full Amaya versions, newest first.
        rel = [l for l in yml.splitlines() if l.startswith("- version:")]
        self.assertEqual(rel, ['- version: "159.0-10"', '- version: "159.0-4"', '- version: "159.0-3"'])
        with tarfile.open(dist / "main/dep11/icons-64x64.tar.gz") as tf:
            self.assertEqual(tf.getnames(), ["amaya_org.amaya.Browser.png"])
        try:
            import yaml  # optional: full YAML parse
        except ImportError:
            return
        docs = list(yaml.safe_load_all(yml))
        self.assertEqual(docs[1]["Releases"][0]["version"], "159.0-10")
        self.assertEqual(docs[1]["Icon"]["cached"][0], {"name": "amaya_org.amaya.Browser.png", "width": 48, "height": 48})

    def test_idempotent_and_atomic_switch(self):
        repo = self.tmp / "repo2"
        deb = self.debs / "amaya_159.0-4_amd64.deb"
        self.assertEqual(self.build(repo, deb)[0], 0)
        first = os.readlink(repo / "dists")
        rc, err = self.build(repo, deb)
        self.assertEqual(rc, 0)
        self.assertIn("unchanged", err)
        self.assertEqual(os.readlink(repo / "dists"), first)
        self.assertEqual(self.build(repo, extra=["--force"])[0], 0)
        self.assertNotEqual(os.readlink(repo / "dists"), first)
        self.assertTrue((repo / "dists/stable/InRelease").is_file())
        # Only the current and one previous generation are kept.
        self.assertLessEqual(len(list((repo / ".dists").iterdir())), 2)


if __name__ == "__main__":
    unittest.main()
