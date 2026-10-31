import unittest

from helpers import BASE_FILES, ToolTestCase, diff_replace, make_mirror, quiet, write_patch

from amaya_tool import cli
from amaya_tool.commands import bump_upstream_json, rebase_cmd
from amaya_tool.patches import (export_patch, import_patches, lint_patch,
                                refresh_patches, split_header)
from amaya_tool.util import AmayaError

P1 = diff_replace("browser/app.txt", "line 2", "line two", "line 1", "line 3")
# Only applies on top of P1: proves sorted application order.
P2 = diff_replace("browser/app.txt", "line two", "line TWO", "line 1", "line 3")


class LintTests(ToolTestCase):
    def test_lint_requires_reason_and_owner_before_diff(self):
        ok = write_patch(self.repo, "0001-ok.patch", P1)
        self.assertEqual(lint_patch(ok), [])
        no_owner = write_patch(self.repo, "0002-no-owner.patch", P1, owner=None)
        self.assertTrue(any("Owner:" in e for e in lint_patch(no_owner)))
        todo = write_patch(self.repo, "0003-todo.patch", P1, reason="TODO: later")
        self.assertTrue(any("TODO" in e for e in lint_patch(todo)))
        # Header text after the first diff does not count.
        late = self.repo / "patches" / "0004-late.patch"
        late.write_text("Subject: x\n\n" + P1 + "Reason: r\nOwner: o\n")
        self.assertEqual(len(lint_patch(late)), 2)
        badname = write_patch(self.repo, "foo.patch", P1)
        self.assertTrue(any("NNNN" in e for e in lint_patch(badname)))

    def test_lint_patches_command_exit_status(self):
        write_patch(self.repo, "0001-ok.patch", P1)
        with quiet():
            self.assertEqual(cli.main(["lint-patches"], ctx=self.ctx()), 0)
        write_patch(self.repo, "0002-bad.patch", P2, reason=None)
        with quiet() as (out, _):
            self.assertEqual(cli.main(["lint-patches"], ctx=self.ctx()), 1)
        self.assertIn("0002-bad.patch", out.getvalue())


class ImportTests(ToolTestCase):
    def setUp(self):
        super().setUp()
        self.engine = self.fetch()

    def do_import(self, **kw):
        with quiet():
            return import_patches(self.ctx(), **kw)

    def test_import_branding_patch_order_and_mozconfig(self):
        # Written in reverse order on purpose; import must sort by name.
        write_patch(self.repo, "0002-second.patch", P2)
        write_patch(self.repo, "0001-first.patch", P1)
        (self.repo / "configs" / "mozconfig.privacy").write_text("# privacy\n")
        result = self.do_import()
        self.assertEqual(result.applied, ["0001-first.patch", "0002-second.patch"])
        self.assertIn("line TWO\n", (self.engine / "browser/app.txt").read_text())
        self.assertEqual(
            (self.engine / "browser/branding/amaya/configure.sh").read_text(),
            "MOZ_APP_DISPLAYNAME=Amaya\n")
        subjects = self.git(self.engine, "log", "--format=%s", "upstream-1.0..HEAD").splitlines()
        self.assertEqual(subjects, ["amaya-patch: 0002-second.patch",
                                    "amaya-patch: 0001-first.patch", "amaya-branding"])
        moz = (self.engine / "mozconfig").read_text()
        common = moz.index("--enable-application=browser")
        privacy = moz.index("# privacy")
        plat = moz.index("--disable-updater")
        self.assertTrue(common < privacy < plat)
        self.assertNotIn("--enable-updater", moz)
        self.assertIn(f"mk_add_options MOZ_OBJDIR={self.work / 'obj-amaya-linux-x86_64'}\n", moz)
        # mozconfig is ignored, so the engine reports clean.
        self.assertEqual(self.git(self.engine, "status", "--porcelain"), "")

    def test_import_without_privacy_config(self):
        self.do_import()
        self.assertNotIn("---- configs/mozconfig.privacy", (self.engine / "mozconfig").read_text())

    def test_import_resets_engine_to_upstream(self):
        self.do_import()
        (self.engine / "README.txt").write_text("local edit\n")
        (self.engine / "untracked.txt").write_text("junk\n")
        objdir_inside = self.engine / "obj-amaya-linux-x86_64"
        objdir_inside.mkdir()
        (objdir_inside / "keep").write_text("build output\n")
        self.do_import()
        self.assertEqual((self.engine / "README.txt").read_text(), "fake firefox\n")
        self.assertFalse((self.engine / "untracked.txt").exists())
        self.assertTrue((objdir_inside / "keep").exists(), "objdir must never be cleaned")

    def test_lint_failure_blocks_import_and_names_patch(self):
        write_patch(self.repo, "0001-noreason.patch", P1, reason=None)
        with quiet(), self.assertRaisesRegex(AmayaError, "0001-noreason.patch.*Reason"):
            import_patches(self.ctx())

    def test_conflict_names_patch(self):
        write_patch(self.repo, "0001-first.patch", P1)
        write_patch(self.repo, "0002-broken.patch",
                    diff_replace("browser/app.txt", "nope", "x", "line 1", "line 3"))
        write_patch(self.repo, "0003-later.patch", P2)
        with quiet(), self.assertRaisesRegex(AmayaError, "0002-broken.patch does not apply"):
            import_patches(self.ctx())
        result = self.do_import(keep_going=True)
        self.assertEqual(result.failed, ["0002-broken.patch"])
        self.assertEqual(result.applied, ["0001-first.patch", "0003-later.patch"])
        with quiet():
            self.assertEqual(cli.main(["import", "--keep-going"], ctx=self.ctx()), 1)


class ExportTests(ToolTestCase):
    def setUp(self):
        super().setUp()
        self.engine = self.fetch()
        write_patch(self.repo, "0001-first.patch", P1)
        with quiet():
            import_patches(self.ctx())

    def test_export_new_patch_excludes_branding(self):
        (self.engine / "toolkit/prefs.js").write_text('pref("a", 1);\npref("b", 3);\n')
        (self.engine / "browser/new-file.txt").write_text("new\n")
        (self.engine / "browser/branding/amaya/configure.sh").write_text("hacked\n")
        with quiet():
            path = export_patch(self.ctx(), "Privacy: no B", reason="b is bad", owner="me")
        self.assertEqual(path.name, "0002-privacy-no-b.patch")
        text = path.read_text()
        header, diff = split_header(text)
        self.assertIn("Subject: Privacy: no B\n", header)
        self.assertIn("Reason: b is bad\n", header)
        self.assertIn("Owner: me\n", header)
        self.assertIn('+pref("b", 3);', diff)
        self.assertIn("browser/new-file.txt", diff)
        self.assertNotIn("branding", diff)
        self.assertNotIn("mozconfig", diff)
        self.assertEqual(lint_patch(path), [])
        # Round trip: a fresh import reproduces the change from patches/.
        with quiet():
            result = import_patches(self.ctx())
        self.assertEqual(result.applied, ["0001-first.patch", "0002-privacy-no-b.patch"])
        self.assertEqual((self.engine / "browser/new-file.txt").read_text(), "new\n")
        self.assertEqual((self.engine / "browser/branding/amaya/configure.sh").read_text(),
                         "MOZ_APP_DISPLAYNAME=Amaya\n")

    def test_export_default_header_is_todo_and_no_changes_errors(self):
        with quiet(), self.assertRaisesRegex(AmayaError, "no uncommitted changes"):
            export_patch(self.ctx(), "nothing")
        (self.engine / "README.txt").write_text("changed\n")
        with quiet():
            path = export_patch(self.ctx(), "readme")
        self.assertIn("Owner: TODO", path.read_text())
        self.assertTrue(lint_patch(path))

    def test_refresh_regenerates_from_commits_keeping_header(self):
        p = self.repo / "patches" / "0001-first.patch"
        p.write_text("Subject: first\nReason: kept reason\nOwner: kept\n\n" + P1)
        with quiet():
            changed = refresh_patches(self.ctx())
        self.assertEqual(changed, ["0001-first.patch"])
        text = p.read_text()
        self.assertTrue(text.startswith("Subject: first\nReason: kept reason\nOwner: kept\n\n"))
        self.assertRegex(text, r"index [0-9a-f]{40}\.\.[0-9a-f]{40}")  # full blob ids
        with quiet():
            self.assertEqual(refresh_patches(self.ctx()), [])


class RebaseTests(ToolTestCase):
    def test_rebase_reapplies_with_3way_and_reports_failures(self):
        engine = self.fetch()
        write_patch(self.repo, "0001-first.patch", P1)
        write_patch(self.repo, "0002-prefs.patch",
                    diff_replace("toolkit/prefs.js", 'pref("b", 2);', 'pref("b", 0);', 'pref("a", 1);'))
        with quiet():
            import_patches(self.ctx())
            refresh_patches(self.ctx())  # give the patches full blob ids
        # 1.1: app.txt changes far from the patched line (patch still applies,
        # via 3-way merge); prefs.js changes the patched line (conflict).
        files = dict(BASE_FILES)
        files["browser/app.txt"] = BASE_FILES["browser/app.txt"].replace("line 19", "line nineteen")
        files["toolkit/prefs.js"] = 'pref("a", 1);\npref("b", 5);\n'
        make_mirror(self.mirror, "1.1", files)
        with quiet() as (out, _):
            rc = rebase_cmd(self.ctx(), "1.1")
        self.assertEqual(rc, 1)
        self.assertIn("FAILED  0002-prefs.patch", out.getvalue())
        self.assertIn("rebase/fx-1.1", out.getvalue())
        up = self.ctx().upstream()
        self.assertEqual(up.version, "1.1")
        self.assertIn("/1.1/", up.source_url)
        self.assertIn("upstream-1.1", self.git(engine, "tag").split())
        self.assertIn("upstream-1.0", self.git(engine, "tag").split())
        app = (engine / "browser/app.txt").read_text()
        self.assertIn("line two\n", app)
        self.assertIn("line nineteen\n", app)

    def test_bump_resets_revision(self):
        self.write_upstream("https://x/1.0/source/firefox-1.0.source.tar.xz",
                            "https://x/1.0/SHA512SUMS", amaya_revision=4)
        with quiet():
            bump_upstream_json(self.ctx(), "2.0")
        up = self.ctx().upstream()
        self.assertEqual((up.version, up.amaya_revision), ("2.0", 1))
        self.assertEqual(up.sha512sums_url, "https://x/2.0/SHA512SUMS")


if __name__ == "__main__":
    unittest.main()
