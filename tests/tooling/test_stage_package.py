import hashlib
import io
import json
import os
import tarfile
import unittest
from unittest import mock

from helpers import ToolTestCase, quiet

from amaya_tool import commands
from amaya_tool.stage import stage
from amaya_tool.util import AmayaError


class StageTests(ToolTestCase):
    def setUp(self):
        super().setUp()
        self.appdir = self.tmp / "app"
        self.appdir.mkdir()
        s = self.repo / "settings"
        s.mkdir()
        (s / "amaya.cfg").write_text("// cfg\n")
        (s / "autoconfig.js").write_text('pref("general.config.filename", "amaya.cfg");\n')
        (s / "policies.json").write_text('{"policies": {}}\n')
        self.xpi = self.tmp / "ublock.xpi"
        self.xpi.write_bytes(b"PK fake xpi")
        self.sha = hashlib.sha256(self.xpi.read_bytes()).hexdigest()

    def write_ext(self, sha=None, ext_id="uBlock0@raymondhill.net"):
        (self.repo / "settings" / "extensions.json").write_text(json.dumps(
            [{"id": ext_id, "url": self.xpi.as_uri(), "sha256": sha or self.sha}]))

    def test_stage_installs_settings_and_extension(self):
        self.write_ext()
        with quiet():
            stage(self.ctx(), self.appdir)
        self.assertEqual((self.appdir / "amaya.cfg").read_text(), "// cfg\n")
        self.assertTrue((self.appdir / "defaults/pref/autoconfig.js").is_file())
        self.assertTrue((self.appdir / "distribution/policies.json").is_file())
        dest = self.appdir / "distribution/extensions/uBlock0@raymondhill.net.xpi"
        self.assertEqual(dest.read_bytes(), b"PK fake xpi")
        # Cached: works again with the source gone.
        self.xpi.unlink()
        with quiet():
            stage(self.ctx(), self.appdir)
        self.assertEqual(len(list((self.repo / ".cache" / "extensions").iterdir())), 1)

    def test_extension_checksum_mismatch_fails(self):
        self.write_ext(sha="0" * 64)
        with quiet(), self.assertRaisesRegex(AmayaError, "sha256 mismatch"):
            stage(self.ctx(), self.appdir)
        self.assertFalse((self.appdir / "distribution/extensions").exists())

    def test_bad_extension_id_rejected(self):
        self.write_ext(ext_id="../../evil")
        with quiet(), self.assertRaisesRegex(AmayaError, "invalid extension id"):
            stage(self.ctx(), self.appdir)

    def write_ui(self):
        ui = self.repo / "ui"
        files = {
            "loader.js": "// loader\n",
            "tokens.css": ":root{}\n",
            "modules.json": '["shell"]\n',
            "README.md": "# contract\n",
            "modules/shell/shell.js": "// shell\n",
            "modules/shell/shell.css": "/* shell */\n",
            "modules/shell/README.md": "# shell\n",
            "modules/shell/icons/x.svg": "<svg/>\n",
            "modules/shell/design/keep.txt": "nested design/ is not excluded\n",
            "design/tokens.json": "{}\n",
            "tools/shot.py": "# tool\n",
        }
        for rel, text in files.items():
            (ui / rel).parent.mkdir(parents=True, exist_ok=True)
            (ui / rel).write_text(text)
        return ui

    def test_stage_copies_ui_without_design_tools_or_docs(self):
        self.write_ext()
        ui = self.write_ui()
        dest = self.appdir / "amaya-ui"
        dest.mkdir()
        (dest / "stale.js").write_text("// from an older stage\n")
        with quiet():
            stage(self.ctx(), self.appdir)
        staged = sorted(str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file())
        self.assertEqual(staged, [
            "loader.js",
            "modules.json",
            "modules/shell/design/keep.txt",
            "modules/shell/icons/x.svg",
            "modules/shell/shell.css",
            "modules/shell/shell.js",
            "tokens.css",
            "version.json",
        ])
        self.assertEqual((dest / "loader.js").read_text(),
                         (ui / "loader.js").read_text())

    def test_stage_writes_version_json(self):
        self.write_ext()
        self.write_ui()
        src, sums = (json.loads((self.repo / "upstream.json").read_text())[k]
                     for k in ("source_url", "sha512sums_url"))
        self.write_upstream(src, sums, amaya_revision=3)
        with quiet():
            stage(self.ctx(), self.appdir)
        data = json.loads((self.appdir / "amaya-ui" / "version.json").read_text())
        self.assertEqual(data, {"version": f"{self.version}-3"})
        # Default revision is 1.
        self.write_upstream(src, sums)
        with quiet():
            stage(self.ctx(), self.appdir)
        data = json.loads((self.appdir / "amaya-ui" / "version.json").read_text())
        self.assertEqual(data, {"version": f"{self.version}-1"})

    def test_stage_without_ui_warns(self):
        self.write_ext()
        with quiet() as (_, err):
            stage(self.ctx(), self.appdir)
        self.assertIn("ui/loader.js not found", err.getvalue())
        self.assertFalse((self.appdir / "amaya-ui").exists())

    def test_missing_settings_warn_not_fail(self):
        for f in (self.repo / "settings").iterdir():
            f.unlink()
        with quiet() as (_, err):
            stage(self.ctx(), self.appdir)
        self.assertIn("settings/amaya.cfg not found", err.getvalue())
        self.assertIn("extensions.json not found", err.getvalue())


class PackageTests(ToolTestCase):
    def make_mach_package(self):
        dist = self.work / "obj-amaya-linux-x86_64" / "dist"
        dist.mkdir(parents=True)
        path = dist / "amaya-1.0.en-US.linux-x86_64.tar.xz"
        with tarfile.open(path, "w:xz") as tf:
            for name, data in (("amaya/amaya", b"#!/bin/sh\n"), ("amaya/omni.ja", b"x")):
                info = tarfile.TarInfo(name)
                info.size = len(data)
                tf.addfile(info, io.BytesIO(data))
        return path

    def test_repackage_stages_and_names_tarball(self):
        settings = self.repo / "settings"
        settings.mkdir()
        (settings / "amaya.cfg").write_text("// cfg\n")
        archive = self.make_mach_package()
        self.assertEqual(commands.find_mach_package(self.ctx()), archive)
        with quiet():
            appdir, out = commands.repackage(self.ctx(), archive)
        self.assertEqual(appdir, self.repo / "dist" / "stage" / "amaya")
        self.assertEqual(out.name, "amaya-1.0-1.linux-x86_64.tar.xz")
        with tarfile.open(out) as tf:
            names = tf.getnames()
        self.assertIn("amaya/amaya.cfg", names)
        self.assertIn("amaya/omni.ja", names)

    def test_package_calls_build_deb(self):
        self.make_mach_package()
        self.fetch()
        (self.work / "engine" / "mozconfig").write_text("")
        deb = self.repo / "packaging" / "debian"
        deb.mkdir(parents=True)
        log = self.tmp / "deb-args"
        script = deb / "build-deb.sh"
        script.write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{log}"\n')
        os.chmod(script, 0o755)
        with mock.patch.object(commands, "mach", return_value=0) as m, quiet():
            self.assertEqual(commands.package_cmd(self.ctx()), 0)
        m.assert_called_once_with(mock.ANY, "package")
        self.assertEqual(log.read_text().splitlines(), [
            str(self.repo / "dist" / "stage" / "amaya"), "1.0-1", str(self.repo / "dist")])

    def test_mach_env(self):
        env = self.ctx().mach_env()
        self.assertEqual(env["MOZCONFIG"], str(self.work / "engine" / "mozconfig"))
        self.assertEqual(env["DISABLE_TELEMETRY"], "1")


if __name__ == "__main__":
    unittest.main()


class EngineTests(PackageTests):
    def test_engine_key_tracks_compiled_inputs_only(self):
        key = commands.engine_key(self.ctx())
        self.assertTrue(key.startswith("1.0-linux-x86_64-"))
        # amaya_revision, settings and ui/ are staged, not compiled.
        data = json.loads((self.repo / "upstream.json").read_text())
        data["amaya_revision"] = 7
        (self.repo / "upstream.json").write_text(json.dumps(data))
        (self.repo / "settings").mkdir(exist_ok=True)
        (self.repo / "settings" / "amaya.cfg").write_text("// changed\n")
        (self.repo / "ui").mkdir(exist_ok=True)
        (self.repo / "ui" / "loader.js").write_text("// ui\n")
        self.assertEqual(commands.engine_key(self.ctx()), key)
        # A patch or a mozconfig change needs a new engine.
        (self.repo / "patches").mkdir(exist_ok=True)
        (self.repo / "patches" / "0001-x.patch").write_text("Reason: r\nOwner: o\n")
        key2 = commands.engine_key(self.ctx())
        self.assertNotEqual(key2, key)
        (self.repo / "configs" / "mozconfig.common").write_text("# changed\n")
        self.assertNotEqual(commands.engine_key(self.ctx()), key2)

    def test_package_with_prebuilt_engine_skips_mach(self):
        archive = self.make_mach_package()
        moved = self.tmp / "engine.tar.xz"
        archive.rename(moved)
        with quiet():
            rc = commands.package_cmd(self.ctx(), engine=moved)
        self.assertEqual(rc, 0)
        self.assertTrue((self.repo / "dist" / "amaya-1.0-1.linux-x86_64.tar.xz").is_file())

    def test_package_with_missing_engine_fails(self):
        with self.assertRaises(commands.AmayaError):
            commands.package_cmd(self.ctx(), engine=self.tmp / "nope.tar.xz")
