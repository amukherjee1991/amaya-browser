"""Fixtures for tooling tests: a fake upstream mirror and a fake Amaya repo."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from amaya_tool.context import Context  # noqa: E402

BASE_FILES = {
    "README.txt": "fake firefox\n",
    "browser/app.txt": "".join(f"line {i}\n" for i in range(1, 21)),
    "browser/branding/unofficial/configure.sh": "MOZ_APP_DISPLAYNAME=Nightly\n",
    "toolkit/prefs.js": 'pref("a", 1);\npref("b", 2);\n',
}


def make_tarball(dest: Path, version: str, files: dict[str, str]) -> Path:
    """Create firefox-<version>.source.tar.xz with a single top-level dir."""
    dest.mkdir(parents=True, exist_ok=True)
    path = dest / f"firefox-{version}.source.tar.xz"
    with tarfile.open(path, "w:xz") as tf:
        for rel, content in files.items():
            data = content.encode()
            info = tarfile.TarInfo(f"firefox-{version}/{rel}")
            info.size = len(data)
            info.mode = 0o644
            tf.addfile(info, io.BytesIO(data))
    return path


def make_mirror(root: Path, version: str, files: dict[str, str] | None = None,
                corrupt_sum: bool = False) -> tuple[str, str]:
    """Fake archive.mozilla.org layout; returns (source_url, sums_url)."""
    rel = root / "releases" / version
    tarball = make_tarball(rel / "source", version, files or BASE_FILES)
    digest = hashlib.sha512(tarball.read_bytes()).hexdigest()
    if corrupt_sum:
        digest = "0" * 128
    (rel / "SHA512SUMS").write_text(
        f"{'f' * 128}  source/{tarball.name}.asc\n"
        f"{digest}  source/{tarball.name}\n"
    )
    return tarball.as_uri(), (rel / "SHA512SUMS").as_uri()


def write_patch(repo: Path, name: str, diff: str, reason="test", owner="tests") -> Path:
    p = repo / "patches" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    header = f"Subject: {name}\n"
    if reason is not None:
        header += f"Reason: {reason}\n"
    if owner is not None:
        header += f"Owner: {owner}\n"
    p.write_text(header + "\n" + diff)
    return p


def diff_replace(path: str, old: str, new: str, before: str, after: str | None = None) -> str:
    """Hand-written unified diff replacing line 2 of a file (no blob ids).

    Pass `after` unless line 2 is the last line: git anchors hunks with less
    trailing than leading context to the end of the file.
    """
    n = 3 if after is not None else 2
    tail = f" {after}\n" if after is not None else ""
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n+++ b/{path}\n"
        f"@@ -1,{n} +1,{n} @@\n {before}\n-{old}\n+{new}\n{tail}"
    )


class ToolTestCase(unittest.TestCase):
    """Creates <tmp>/repo (fake Amaya repo) and <tmp>/work (AMAYA_WORKDIR)."""

    version = "1.0"

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(prefix="amaya-test-")
        self.tmp = Path(self._tmp.name).resolve()
        self.mirror = self.tmp / "mirror"
        self.repo = self.tmp / "repo"
        self.work = self.tmp / "work"
        self.repo.mkdir()
        src, sums = make_mirror(self.mirror, self.version)
        self.write_upstream(src, sums)
        cfg = self.repo / "configs"
        (cfg / "linux").mkdir(parents=True)
        (cfg / "macos").mkdir(parents=True)
        (cfg / "mozconfig.common").write_text("ac_add_options --enable-application=browser\n")
        (cfg / "linux" / "mozconfig").write_text("ac_add_options --disable-updater\n")
        (cfg / "macos" / "mozconfig").write_text("ac_add_options --enable-updater\n")
        brand = self.repo / "branding" / "amaya"
        brand.mkdir(parents=True)
        (brand / "configure.sh").write_text("MOZ_APP_DISPLAYNAME=Amaya\n")
        self.env = {"AMAYA_WORKDIR": str(self.work), "PATH": "/usr/bin:/bin"}

    def tearDown(self):
        self._tmp.cleanup()

    def write_upstream(self, src, sums, **extra):
        data = {"product": "firefox", "version": self.version, "channel": "release",
                "source_url": src, "sha512sums_url": sums, **extra}
        (self.repo / "upstream.json").write_text(json.dumps(data, indent=2))

    def ctx(self, env=None, plat="linux", arch="x86_64") -> Context:
        return Context(repo=self.repo, env=self.env if env is None else env,
                       plat=plat, arch=arch)

    def fetch(self):
        from amaya_tool.fetch import fetch
        with quiet():
            return fetch(self.ctx())

    def git(self, cwd: Path, *args: str) -> str:
        return subprocess.run(["git", "-C", str(cwd), *args], check=True,
                              capture_output=True, text=True).stdout.strip()


@contextlib.contextmanager
def quiet():
    """Silence the tool's progress output (keeps test output readable)."""
    with contextlib.redirect_stdout(io.StringIO()) as out, \
            contextlib.redirect_stderr(io.StringIO()) as err:
        yield out, err


def rmtree(p: Path):
    shutil.rmtree(p, ignore_errors=True)
