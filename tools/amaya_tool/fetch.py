"""`amaya fetch`: download, verify and unpack the pinned Firefox source."""

from __future__ import annotations

import os
import shutil
import tarfile
from pathlib import Path

from .context import Context, Upstream
from .util import AmayaError, download, file_hash, git, info, run, warn


def parse_sha512sums(text: str, filename: str) -> str | None:
    """Find the sha512 for `filename` in a SHA512SUMS file.

    Mozilla's file lists paths like `source/firefox-159.0.source.tar.xz`.
    """
    for line in text.splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        digest, path = parts
        path = path.lstrip("*")
        if path == filename or path.endswith("/" + filename):
            if len(digest) == 128:
                return digest.lower()
    return None


def _sums_file(ctx: Context, up: Upstream) -> Path:
    """Return a local SHA512SUMS that lists our tarball, downloading if needed."""
    versioned = ctx.cache / f"SHA512SUMS-{up.version}"
    if versioned.is_file():
        return versioned
    plain = ctx.cache / "SHA512SUMS"
    if plain.is_file() and parse_sha512sums(plain.read_text(), up.tarball_name):
        return plain
    download(up.sha512sums_url, versioned)
    return versioned


def ensure_verified_tarball(ctx: Context, up: Upstream) -> Path:
    """Download (if not cached) and sha512-verify the source tarball."""
    ctx.cache.mkdir(parents=True, exist_ok=True)
    sums = _sums_file(ctx, up)
    expected = parse_sha512sums(sums.read_text(), up.tarball_name)
    if not expected:
        raise AmayaError(f"{sums.name} has no entry for {up.tarball_name}")
    tarball = ctx.cache / up.tarball_name
    for attempt in (1, 2):
        if not tarball.is_file():
            download(up.source_url, tarball)
        info(f"verifying sha512 of {tarball.name}")
        actual = file_hash(tarball, "sha512")
        if actual == expected:
            return tarball
        tarball.unlink()
        if attempt == 1:
            warn("checksum mismatch on cached/downloaded tarball; downloading again")
    raise AmayaError(
        f"sha512 mismatch for {up.tarball_name}\n  expected {expected}\n"
        f"  actual   {actual}\nThe download was deleted; nothing was extracted.")


def extract_strip_top(tarball: Path, dest: Path) -> None:
    """Extract tarball into dest, dropping the single top-level directory."""
    dest.mkdir(parents=True)
    if shutil.which("tar"):
        run(["tar", "-xf", tarball, "-C", dest, "--strip-components=1"])
        return
    with tarfile.open(tarball) as tf:  # pragma: no cover - fallback path
        members = []
        for m in tf.getmembers():
            parts = m.name.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            m.name = parts[1]
            members.append(m)
        tf.extractall(dest, members=members, filter="data")


def is_nonempty_dir(p: Path) -> bool:
    return p.is_dir() and any(p.iterdir())


def remove_engine(path: Path) -> None:
    real = Path(os.path.realpath(path))
    if real == Path("/") or real == Path.home():
        raise AmayaError(f"refusing to delete {real}")
    shutil.rmtree(real)


def link_repo_engine(ctx: Context, engine: Path) -> None:
    """Make <repo>/engine point at the workdir engine (convenience symlink)."""
    link = ctx.repo_engine_link
    if Path(os.path.realpath(link)) == engine:
        return
    if link.is_symlink():
        link.unlink()
    elif link.exists():
        warn(f"{link} exists and is not a symlink; not linking it to {engine}")
        return
    link.symlink_to(engine, target_is_directory=True)
    info(f"linked {link} -> {engine}")


def init_engine_repo(engine: Path, version: str) -> None:
    info("creating engine git repository (this takes a while for a full tree)")
    git(engine, "init", "-q", "-b", "upstream")
    # -f: commit exactly what the tarball contains, even files upstream ignores.
    git(engine, "add", "-A", "-f")
    git(engine, "commit", "-q", "--no-verify", "-m", f"upstream firefox {version}")
    git(engine, "tag", f"upstream-{version}")


def tag_exists(engine: Path, tag: str) -> bool:
    return git(engine, "rev-parse", "-q", "--verify", f"refs/tags/{tag}",
               check=False).returncode == 0


def fetch_update(ctx: Context) -> Path:
    """Replace the engine's tree with the pinned version, keeping its git repo.

    Used by `rebase`: the new upstream becomes a new commit on the `upstream`
    branch of the same repository, so the old version's blobs stay available
    and `git apply --3way` can do real three-way merges of old patches.
    """
    up = ctx.upstream()
    ctx.require_no_spaces()
    engine = ctx.require_engine()
    if tag_exists(engine, up.tag):
        info(f"engine already has {up.tag}; not re-extracting")
        return engine
    tarball = ensure_verified_tarball(ctx, up)
    tmp = engine.parent / f".{engine.name}.extract-tmp"
    old = engine.parent / f".{engine.name}.old"
    for p in (tmp, old):
        if p.exists():
            shutil.rmtree(p)
    info(f"extracting {tarball.name}")
    try:
        extract_strip_top(tarball, tmp)
        shutil.move(str(engine / ".git"), str(tmp / ".git"))
    except BaseException:
        if (tmp / ".git").is_dir() and not (engine / ".git").exists():
            shutil.move(str(tmp / ".git"), str(engine / ".git"))
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    engine.rename(old)
    tmp.rename(engine)
    shutil.rmtree(old)
    git(engine, "symbolic-ref", "HEAD", "refs/heads/upstream")
    git(engine, "reset", "-q")  # index := previous upstream commit
    git(engine, "add", "-A", "-f")
    git(engine, "commit", "-q", "--no-verify", "-m", f"upstream firefox {up.version}")
    git(engine, "tag", up.tag)
    info(f"engine updated to {up.tag}")
    return engine


def fetch(ctx: Context, force: bool = False) -> Path:
    up = ctx.upstream()
    ctx.require_no_spaces()
    ctx.workdir.mkdir(parents=True, exist_ok=True)
    engine = ctx.engine
    if is_nonempty_dir(engine):
        if not force:
            raise AmayaError(
                f"{engine} already exists; refusing to overwrite it "
                "(use --force to delete and re-extract)")
        info(f"--force: removing existing {engine}")
        remove_engine(engine)

    tarball = ensure_verified_tarball(ctx, up)

    tmp = engine.parent / f".{engine.name}.extract-tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    info(f"extracting {tarball.name} into {engine}")
    try:
        extract_strip_top(tarball, tmp)
        if engine.is_dir():  # empty directory left over
            engine.rmdir()
        tmp.rename(engine)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    init_engine_repo(engine, up.version)
    if ctx.workdir != ctx.repo:
        link_repo_engine(ctx, engine)
    info(f"engine ready at {engine} (tag upstream-{up.version})")
    return engine
