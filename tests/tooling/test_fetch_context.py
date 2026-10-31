import json
import os
import unittest
from pathlib import Path

from helpers import ToolTestCase, make_mirror, quiet

from amaya_tool.context import Context, detect_arch, detect_platform, load_upstream
from amaya_tool.fetch import fetch, parse_sha512sums
from amaya_tool.util import AmayaError


class FetchTests(ToolTestCase):
    def test_fetch_verifies_extracts_and_tags(self):
        engine = self.fetch()
        self.assertEqual(engine, self.work / "engine")
        self.assertEqual((engine / "README.txt").read_text(), "fake firefox\n")
        self.assertFalse((engine / "firefox-1.0").exists(), "top dir must be stripped")
        self.assertEqual(self.git(engine, "branch", "--show-current"), "upstream")
        self.assertEqual(self.git(engine, "log", "-1", "--format=%s"), "upstream firefox 1.0")
        self.assertEqual(self.git(engine, "tag"), "upstream-1.0")
        self.assertTrue((self.repo / ".cache" / "firefox-1.0.source.tar.xz").is_file())
        # Convenience symlink <repo>/engine -> workdir engine.
        link = self.repo / "engine"
        self.assertTrue(link.is_symlink())
        self.assertEqual(Path(os.path.realpath(link)), engine)

    def test_fetch_refuses_to_clobber_without_force(self):
        engine = self.fetch()
        (engine / "local-change").write_text("x")
        with quiet(), self.assertRaisesRegex(AmayaError, "--force"):
            fetch(self.ctx())
        with quiet():
            fetch(self.ctx(), force=True)
        self.assertFalse((engine / "local-change").exists())
        self.assertEqual(self.git(engine, "tag"), "upstream-1.0")

    def test_checksum_mismatch_fails_and_extracts_nothing(self):
        src, sums = make_mirror(self.tmp / "badmirror", "1.0", corrupt_sum=True)
        self.write_upstream(src, sums)
        with quiet(), self.assertRaisesRegex(AmayaError, "sha512 mismatch"):
            fetch(self.ctx())
        self.assertFalse((self.work / "engine").exists())
        self.assertFalse((self.repo / ".cache" / "firefox-1.0.source.tar.xz").exists())

    def test_existing_plain_sha512sums_is_reused(self):
        src, sums = make_mirror(self.tmp / "m2", "1.0")
        cache = self.repo / ".cache"
        cache.mkdir()
        (cache / "SHA512SUMS").write_bytes(Path(sums[len("file://"):]).read_bytes())
        # Break the remote URL: the cached file must be used instead.
        self.write_upstream(src, "file:///nonexistent/SHA512SUMS")
        self.fetch()

    def test_parse_sha512sums(self):
        text = f"{'a' * 128}  source/x.tar.xz.asc\n{'b' * 128}  source/x.tar.xz\n"
        self.assertEqual(parse_sha512sums(text, "x.tar.xz"), "b" * 128)
        self.assertIsNone(parse_sha512sums(text, "y.tar.xz"))


class WorkdirTests(ToolTestCase):
    def test_env_wins_over_local_json(self):
        (self.repo / "amaya.local.json").write_text(json.dumps({"workdir": str(self.tmp / "other")}))
        ctx = self.ctx()
        self.assertEqual(ctx.workdir, self.work)
        self.assertEqual(ctx.engine, self.work / "engine")
        self.assertEqual(ctx.objdir, self.work / "obj-amaya-linux-x86_64")

    def test_local_json_then_repo_default(self):
        (self.repo / "amaya.local.json").write_text(json.dumps({"workdir": str(self.tmp / "other")}))
        ctx = self.ctx(env={})
        self.assertEqual(ctx.workdir, self.tmp / "other")
        self.assertEqual(ctx.workdir_source()[1], "amaya.local.json")
        (self.repo / "amaya.local.json").unlink()
        ctx = self.ctx(env={})
        self.assertEqual(ctx.workdir, self.repo)
        self.assertEqual(ctx.objdir, self.repo / "obj-amaya-linux-x86_64")
        self.assertEqual(self.ctx(env={}, plat="macos", arch="aarch64").objdir,
                         self.repo / "obj-amaya-macos-aarch64")

    def test_engine_symlink_is_resolved(self):
        real = self.tmp / "elsewhere" / "engine"
        real.mkdir(parents=True)
        (self.repo / "engine").symlink_to(real)
        ctx = self.ctx(env={})
        self.assertEqual(ctx.engine, real)

    def test_space_in_path_fails_with_hint(self):
        spacey = self.tmp / "with space"
        ctx = self.ctx(env={"AMAYA_WORKDIR": str(spacey)})
        with self.assertRaisesRegex(AmayaError, "AMAYA_WORKDIR"):
            ctx.require_no_spaces()
        with quiet(), self.assertRaisesRegex(AmayaError, "contains a space"):
            fetch(ctx)
        # A space only in the repo path is fine once AMAYA_WORKDIR is set.
        spacey_repo_ctx = Context(repo=spacey, env=self.env, plat="linux", arch="x86_64")
        spacey_repo_ctx.require_no_spaces()

    def test_platform_detection(self):
        self.assertEqual(detect_platform("linux"), "linux")
        self.assertEqual(detect_platform("darwin"), "macos")
        with self.assertRaises(AmayaError):
            detect_platform("win32")
        self.assertEqual(detect_arch("AMD64"), "x86_64")
        self.assertEqual(detect_arch("arm64"), "aarch64")


class VersionTests(ToolTestCase):
    def test_version_strings_default_revision(self):
        up = load_upstream(self.repo / "upstream.json")
        self.assertEqual(up.amaya_revision, 1)
        self.assertEqual(up.tag, "upstream-1.0")
        self.assertEqual(up.tarball_name, "firefox-1.0.source.tar.xz")
        self.assertEqual(up.amaya_version, "1.0-1")
        self.assertEqual(up.deb_version, "1.0.0.1-1")
        self.assertEqual(up.dist_tarball_name("linux", "x86_64"),
                         "amaya-1.0-1.linux-x86_64.tar.xz")

    def test_explicit_revision(self):
        self.write_upstream("file:///a/firefox-1.0.source.tar.xz", "file:///a/SHA512SUMS",
                            amaya_revision=3)
        up = self.ctx().upstream()
        self.assertEqual(up.amaya_version, "1.0-3")
        self.assertEqual(up.deb_version, "1.0.0.3-1")

    def test_deb_version_sorts_across_point_releases(self):
        import subprocess
        from amaya_tool.context import Upstream
        cases = [("159.0", 5, "159.0.0.5-1"), ("159.0.1", 2, "159.0.1.2-1"), ("160.0", 1, "160.0.0.1-1")]
        for v, rev, want in cases:
            up = Upstream(version=v, source_url="file:///x", sha512sums_url="file:///y", amaya_revision=rev, channel="release", product="firefox")
            self.assertEqual(up.deb_version, want)
        # dpkg order: old scheme 159.0-4 < 159.0.0.5-1 < 159.0.1.1-1 < 160.0.0.1-1
        chain = ["159.0-4", "159.0.0.5-1", "159.0.1.1-1", "160.0.0.1-1"]
        for a, b in zip(chain, chain[1:]):
            r = subprocess.run(["dpkg", "--compare-versions", a, "lt", b])
            self.assertEqual(r.returncode, 0, f"{a} should sort before {b}")

    def test_invalid_revision(self):
        self.write_upstream("u", "s", amaya_revision="2")
        with self.assertRaises(AmayaError):
            self.ctx().upstream()


if __name__ == "__main__":
    unittest.main()
