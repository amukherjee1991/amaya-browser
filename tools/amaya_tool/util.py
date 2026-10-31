"""Small shared helpers: logging, subprocess, hashing, downloads, git."""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Iterable, Mapping, Sequence

# Identity used for the engine's local bookkeeping commits. These commits never
# leave the machine; using a fixed identity avoids depending on git config.
GIT_IDENTITY = [
    "-c", "user.name=amaya-tool",
    "-c", "user.email=amaya-tool@localhost",
    "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false",
    "-c", "core.autocrlf=false",
]


class AmayaError(Exception):
    """A user-facing error: printed without a traceback, exit status 1."""


def info(msg: str) -> None:
    print(f"amaya: {msg}", flush=True)


def warn(msg: str) -> None:
    print(f"amaya: warning: {msg}", file=sys.stderr, flush=True)


def run(
    cmd: Sequence[str | os.PathLike],
    cwd: Path | None = None,
    env: Mapping[str, str] | None = None,
    check: bool = True,
    capture: bool = False,
    input: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a command. With capture=True, stdout/stderr are returned as text."""
    cmd = [str(c) for c in cmd]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=dict(env) if env is not None else None,
            text=True,
            input=input,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.PIPE if capture else None,
        )
    except FileNotFoundError as e:
        raise AmayaError(f"command not found: {cmd[0]}") from e
    if check and proc.returncode != 0:
        detail = ""
        if capture:
            detail = "\n" + ((proc.stderr or "") + (proc.stdout or "")).strip()
        raise AmayaError(
            f"command failed (exit {proc.returncode}): {' '.join(cmd)}{detail}"
        )
    return proc


def git(
    repo: Path,
    *args: str,
    check: bool = True,
    capture: bool = True,
    input: str | None = None,
) -> subprocess.CompletedProcess:
    return run(
        ["git", *GIT_IDENTITY, "-C", str(repo), *args],
        check=check,
        capture=capture,
        input=input,
    )


def git_out(repo: Path, *args: str) -> str:
    return git(repo, *args).stdout.strip()


def file_hash(path: Path, algo: str) -> str:
    h = hashlib.new(algo)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path) -> None:
    """Download url to dest atomically (via a .part file). file:// works too."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    info(f"downloading {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "amaya-tool"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(part, "wb") as out:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            last_pct = -10
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
                done += len(chunk)
                if total and sys.stderr.isatty():
                    pct = done * 100 // total
                    if pct >= last_pct + 10:
                        print(f"  {pct}%", file=sys.stderr, flush=True)
                        last_pct = pct
    except OSError as e:
        part.unlink(missing_ok=True)
        raise AmayaError(f"download failed: {url}: {e}") from e
    part.replace(dest)


def copy_tree(src: Path, dst: Path) -> None:
    """Replace dst with a copy of src."""
    if dst.is_symlink() or dst.is_file():
        dst.unlink()
    elif dst.exists():
        shutil.rmtree(dst)
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dst, symlinks=True)


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_symlink():
        dst.unlink()
    shutil.copyfile(src, dst)


def join_cmd(parts: Iterable[str]) -> str:
    import shlex

    return " ".join(shlex.quote(str(p)) for p in parts)
