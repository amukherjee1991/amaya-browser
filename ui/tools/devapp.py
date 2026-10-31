#!/usr/bin/env python3
"""Shared helpers for ui/tools/dev.sh and ui/tools/shot.py.

The shipped app (dist/stage/amaya, read-only for us) may carry an older
amaya.cfg / autoconfig.js.  We keep cheap hardlinked copies of it in
~/.cache/amaya-ui-dev/app-<key> (override AMAYA_DEV_CACHE) with the two
settings files taken from this checkout, so the loader block in the repo's
settings/amaya.cfg is what actually runs.

CLI:  devapp.py app                 -> prints the prepared app dir
      devapp.py profile [--dark]    -> creates a fresh temp profile, prints it
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
UI_DIR = TOOLS.parent
REPO = UI_DIR.parent
DEFAULT_APP = "/home/arghya/Documents/Amaya Browser/dist/stage/amaya/amaya"

# Repo file -> path inside the app dir.
SETTINGS = (
    (REPO / "settings" / "amaya.cfg", Path("amaya.cfg")),
    (REPO / "settings" / "autoconfig.js", Path("defaults/pref/autoconfig.js")),
)

BASE_PREFS = {
    # Print chrome console.* (the [amaya-ui:*] lines) to stdout.
    "devtools.console.stdout.chrome": True,
    "browser.dom.window.dump.enabled": True,
    "devtools.chrome.enabled": True,
    "devtools.debugger.remote-enabled": True,
    "devtools.debugger.prompt-connection": False,
    "browser.shell.checkDefaultBrowser": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.tabs.warnOnClose": False,
    "browser.warnOnQuit": False,
    "browser.sessionstore.resume_from_crash": False,
}


def source_app() -> Path:
    return Path(os.environ.get("AMAYA_APP", DEFAULT_APP)).resolve().parent


def cache_root() -> Path:
    return Path(os.environ.get("AMAYA_DEV_CACHE",
                               Path.home() / ".cache" / "amaya-ui-dev"))


def _stamp(src: Path) -> str:
    st = (src / "libxul.so").stat() if (src / "libxul.so").exists() else src.stat()
    omni = src / "omni.ja"
    om = omni.stat().st_mtime_ns if omni.exists() else 0
    return f"{src}|{st.st_ino}|{st.st_mtime_ns}|{om}"


def _copy_tree(src: Path, dst: Path) -> None:
    """Hardlink every file (falls back to copy across filesystems)."""
    def link(s, d):
        try:
            os.link(s, d)
        except OSError:
            shutil.copy2(s, d)
    shutil.copytree(src, dst, symlinks=True, copy_function=link)


def _replace(src: Path, dst: Path) -> None:
    """Atomically replace dst with a private copy of src (never write through
    a hardlink into the shipped app)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dst.parent, prefix=".amaya-dev-")
    os.close(fd)
    shutil.copyfile(src, tmp)
    os.chmod(tmp, 0o644)
    os.replace(tmp, dst)


def prepare_app() -> Path:
    """Return the dev app dir: a cached hardlink copy of the shipped app with
    this checkout's settings files.  The cache is keyed by the shipped app's
    identity plus the settings content, and each copy is immutable once built,
    so parallel runs from different worktrees never fight over it."""
    src = source_app()
    if not (src / "amaya").exists():
        sys.exit(f"devapp: no app at {src} (set AMAYA_APP to the amaya binary)")
    h = hashlib.sha256(_stamp(src).encode())
    for repo_file, _ in SETTINGS:
        h.update(repo_file.read_bytes())
    key = h.hexdigest()[:12]
    root = cache_root()
    root.mkdir(parents=True, exist_ok=True)
    app = root / f"app-{key}"
    if (app / ".complete").exists():
        return app
    # Build next to it, then rename into place so nobody sees a half copy.
    tmp = Path(tempfile.mkdtemp(dir=root, prefix="build-"))
    _copy_tree(src, tmp / "app")
    # Never pick up a staged amaya-ui/ from the shipped app.
    shutil.rmtree(tmp / "app" / "amaya-ui", ignore_errors=True)
    for repo_file, rel in SETTINGS:
        _replace(repo_file, tmp / "app" / rel)
    (tmp / "app" / ".complete").write_text(_stamp(src))
    try:
        os.rename(tmp / "app", app)
    except OSError:
        pass  # another run won the race; theirs is identical
    shutil.rmtree(tmp, ignore_errors=True)
    _prune(root, keep=app)
    return app


def _prune(root: Path, keep: Path, max_age=3 * 86400) -> None:
    """Drop cached copies not used for a few days (they are only hardlinks)."""
    now = time.time()
    os.utime(keep)
    for d in root.glob("app-*"):
        try:
            if d != keep and now - d.stat().st_mtime > max_age:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


def make_profile(extra: dict | None = None, dark: bool = False) -> Path:
    base = Path(os.environ.get("TMPDIR", "/tmp"))
    prof = Path(tempfile.mkdtemp(prefix="amaya-ui-profile-", dir=base))
    prefs = dict(BASE_PREFS)
    if dark:
        prefs["ui.systemUsesDarkTheme"] = 1
    prefs.update(extra or {})
    with open(prof / "user.js", "w") as f:
        for k, v in prefs.items():
            f.write(f"user_pref({json.dumps(k)}, {json.dumps(v)});\n")
    return prof


def main(argv):
    if not argv or argv[0] not in ("app", "profile"):
        sys.exit(__doc__)
    if argv[0] == "app":
        print(prepare_app())
    else:
        print(make_profile(dark="--dark" in argv))


if __name__ == "__main__":
    main(sys.argv[1:])
