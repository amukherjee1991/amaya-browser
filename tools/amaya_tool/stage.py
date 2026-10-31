"""`amaya stage <appdir>`: install Amaya settings + bundled extensions.

Contract with settings/ (owned by the privacy work):
  settings/amaya.cfg        -> <appdir>/amaya.cfg
  settings/autoconfig.js    -> <appdir>/defaults/pref/autoconfig.js
  settings/policies.json    -> <appdir>/distribution/policies.json
  settings/extensions.json  -> [{"id", "url", "sha256"}, ...], each downloaded
                               (cached in .cache/extensions/, sha256-verified)
                               to <appdir>/distribution/extensions/<id>.xpi
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .context import Context
from .util import AmayaError, copy_file, download, file_hash, info, warn

SETTINGS_FILES = (
    ("amaya.cfg", Path("amaya.cfg")),
    ("autoconfig.js", Path("defaults/pref/autoconfig.js")),
    ("policies.json", Path("distribution/policies.json")),
)

# Extension IDs are either an email-like id or a {GUID}; never a path.
EXT_ID_RE = re.compile(r"^(\{[0-9A-Fa-f-]{36}\}|[A-Za-z0-9._+-]+@[A-Za-z0-9._-]+)$")


def load_extensions(path: Path) -> list[dict]:
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        raise AmayaError(f"{path}: invalid JSON: {e}") from e
    if not isinstance(data, list):
        raise AmayaError(f"{path}: expected a JSON list of {{id, url, sha256}}")
    for i, ext in enumerate(data):
        if not isinstance(ext, dict) or not all(
            isinstance(ext.get(k), str) and ext.get(k) for k in ("id", "url", "sha256")
        ):
            raise AmayaError(f"{path}: entry {i} needs string id, url and sha256")
        if not EXT_ID_RE.match(ext["id"]):
            raise AmayaError(f"{path}: entry {i}: invalid extension id {ext['id']!r}")
        if not re.fullmatch(r"[0-9a-fA-F]{64}", ext["sha256"]):
            raise AmayaError(f"{path}: entry {i}: sha256 must be 64 hex chars")
    return data


def fetch_extension(ctx: Context, ext: dict) -> Path:
    sha = ext["sha256"].lower()
    cached = ctx.cache / "extensions" / f"{ext['id']}-{sha[:16]}.xpi"
    if cached.is_file() and file_hash(cached, "sha256") == sha:
        return cached
    download(ext["url"], cached)
    actual = file_hash(cached, "sha256")
    if actual != sha:
        cached.unlink()
        raise AmayaError(
            f"sha256 mismatch for extension {ext['id']} from {ext['url']}\n"
            f"  expected {sha}\n  actual   {actual}")
    return cached


def stage(ctx: Context, appdir: Path) -> None:
    appdir = Path(appdir)
    if not appdir.is_dir():
        raise AmayaError(f"app directory {appdir} does not exist")
    sdir = ctx.settings_dir
    for name, rel in SETTINGS_FILES:
        src = sdir / name
        if src.is_file():
            copy_file(src, appdir / rel)
            info(f"staged settings/{name} -> {rel}")
        else:
            warn(f"settings/{name} not found; skipping")

    manifest = sdir / "extensions.json"
    if not manifest.is_file():
        warn("settings/extensions.json not found; no extensions bundled")
        return
    for ext in load_extensions(manifest):
        xpi = fetch_extension(ctx, ext)
        dest = appdir / "distribution" / "extensions" / f"{ext['id']}.xpi"
        copy_file(xpi, dest)
        info(f"staged extension {ext['id']}")
