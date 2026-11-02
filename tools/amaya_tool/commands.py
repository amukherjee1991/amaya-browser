"""mach-driven commands (bootstrap/build/run/package), rebase and status."""

from __future__ import annotations

import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path

from .context import WORKDIR_ENV, Context
from .fetch import fetch, fetch_update
from .mozconfig import write_mozconfig
from .patches import import_patches, list_patches, lint_all, upstream_ref
from .stage import stage
from .util import AmayaError, git, info, join_cmd, run, warn


# --------------------------------------------------------------------------
# mach
# --------------------------------------------------------------------------
def mach(ctx: Context, *args: str, check: bool = True) -> int:
    engine = ctx.require_engine()
    ctx.require_no_spaces()
    cmd = ["./mach", *args]
    info(f"(in {engine}) {join_cmd(cmd)}")
    proc = run(cmd, cwd=engine, env=ctx.mach_env(), check=False)
    if check and proc.returncode != 0:
        raise AmayaError(f"`{join_cmd(cmd)}` failed with exit {proc.returncode}")
    return proc.returncode


def require_mozconfig(ctx: Context) -> None:
    if not ctx.mozconfig_path.is_file():
        raise AmayaError(f"{ctx.mozconfig_path} missing — run `tools/amaya import` first")


def bootstrap_cmd(ctx: Context) -> int:
    ctx.require_engine()
    # bootstrap reads the mozconfig to decide which toolchains to install.
    write_mozconfig(ctx)
    return mach(ctx, "--no-interactive", "bootstrap", "--application-choice", "browser")


def build_cmd(ctx: Context, extra: list[str]) -> int:
    require_mozconfig(ctx)
    mach(ctx, "build", *extra)
    appdir = ctx.objdir / "dist" / "bin"
    stage(ctx, appdir)
    info(f"build ready: {appdir}")
    return 0


def run_cmd(ctx: Context, extra: list[str]) -> int:
    require_mozconfig(ctx)
    return mach(ctx, "run", *extra, check=False)


# --------------------------------------------------------------------------
# package
# --------------------------------------------------------------------------
def find_mach_package(ctx: Context) -> Path:
    dist = ctx.objdir / "dist"
    if ctx.platform == "macos":
        candidates = [p for p in dist.glob("*.dmg") if p.is_file()]
        hint = "*.dmg"
    else:
        candidates = [p for pat in ("amaya-*.tar.xz", "amaya-*.tar.bz2")
                      for p in dist.glob(pat) if p.is_file()]
        hint = "amaya-*.tar.xz / .tar.bz2"
    if not candidates:
        raise AmayaError(f"no {hint} found in {dist}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def extract_dmg(dmg: Path, dest: Path) -> None:
    """Mount a dmg read-only and copy its whole volume into dest, including
    the Applications symlink, custom volume icon and Finder background that
    mach's own mac packaging step already built from branding/amaya/."""
    mount_point = Path(tempfile.mkdtemp(prefix="amaya-dmg-"))
    try:
        run(["hdiutil", "attach", str(dmg), "-readonly", "-nobrowse",
             "-noautoopen", "-mountpoint", str(mount_point)])
        try:
            run(["cp", "-a", f"{mount_point}/.", str(dest)])
        finally:
            run(["hdiutil", "detach", str(mount_point), "-quiet"], check=False)
    finally:
        mount_point.rmdir()


def extract(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if archive.suffix == ".dmg":
        extract_dmg(archive, dest)
    elif shutil.which("tar"):
        run(["tar", "-xf", archive, "-C", dest])
    else:  # pragma: no cover
        with tarfile.open(archive) as tf:
            tf.extractall(dest, filter="data")


def make_tar_xz(src_root: Path, name: str, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".part")
    if shutil.which("tar"):
        env = dict(os.environ, XZ_OPT=os.environ.get("XZ_OPT", "-T0"))
        run(["tar", "-cJf", tmp, "-C", src_root, name], env=env)
    else:  # pragma: no cover
        with tarfile.open(tmp, "w:xz") as tf:
            tf.add(src_root / name, arcname=name)
    tmp.replace(out)


def macos_arch_label(ctx: Context) -> str:
    """Homebrew-style arch label (matches packaging/macos/amaya.rb.template)."""
    return "arm64" if ctx.arch == "aarch64" else ctx.arch


def find_app_bundle(root: Path) -> Path:
    apps = [p for p in root.iterdir() if p.is_dir() and p.suffix == ".app"]
    if len(apps) != 1:
        raise AmayaError(f"expected exactly one .app bundle in {root}, "
                         f"found {[p.name for p in apps]}")
    return apps[0]


def make_dmg(src_root: Path, out: Path) -> None:
    """Build an UNSIGNED dmg from src_root (the full volume layout: the .app,
    the Applications symlink, background and volume icon). Gatekeeper will
    refuse to open it without right-click -> Open until it is signed and
    notarized (packaging/macos/README.md secs 2 and 4)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    # hdiutil appends .dmg to the output path if it doesn't already end in
    # .dmg, so a plain ".part" suffix would silently become ".part.dmg".
    tmp = out.with_name(out.stem + ".part.dmg")
    tmp.unlink(missing_ok=True)
    run(["hdiutil", "create", "-volname", "Amaya", "-srcfolder", str(src_root),
         "-fs", "HFS+", "-format", "UDZO", "-ov", str(tmp)])
    tmp.replace(out)


def repackage(ctx: Context, mach_archive: Path) -> tuple[Path, Path]:
    """Extract mach's package into dist/stage, stage settings, and rebuild
    the final artifact (re-tar on Linux, rebuild the dmg on macOS)."""
    up = ctx.upstream()
    stage_root = ctx.dist / "stage"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    extract(mach_archive, stage_root)
    if ctx.platform == "macos":
        appdir = find_app_bundle(stage_root)
        stage(ctx, appdir / "Contents" / "Resources")
        out = ctx.dist / f"Amaya-{up.amaya_version}-{macos_arch_label(ctx)}.dmg"
        make_dmg(stage_root, out)
    else:
        tops = [p for p in stage_root.iterdir() if p.is_dir()]
        if len(tops) != 1:
            raise AmayaError(f"expected one top-level directory in {mach_archive.name}, "
                             f"found {[p.name for p in tops]}")
        appdir = tops[0]
        stage(ctx, appdir)
        out = ctx.dist / up.dist_tarball_name(ctx.platform, ctx.arch)
        make_tar_xz(stage_root, appdir.name, out)
    info(f"wrote {out}")
    return appdir, out


# Inputs that need a full engine compile. Settings, policies, extensions and
# the ui/ layer are staged into an existing engine, so they are not part of it.
ENGINE_INPUTS = ("patches", "configs", "branding/amaya")


def engine_key(ctx: Context) -> str:
    """Fingerprint of everything baked into the compiled engine."""
    import hashlib
    h = hashlib.sha256()
    up = json.loads(ctx.upstream_json.read_text())
    up.pop("amaya_revision", None)  # a new Amaya revision alone does not need a compile
    h.update(json.dumps(up, sort_keys=True).encode())
    for rel in ENGINE_INPUTS:
        root = ctx.repo / rel
        for f in sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []:
            h.update(str(f.relative_to(ctx.repo)).encode() + b"\0")
            h.update(f.read_bytes())
    return f"{up['version']}-{ctx.platform}-{ctx.arch}-{h.hexdigest()[:12]}"


def engine_key_cmd(ctx: Context) -> int:
    print(engine_key(ctx))
    return 0


def package_cmd(ctx: Context, engine: Path | None = None) -> int:
    """Package a release. With `engine`, reuse a prebuilt engine archive (the
    output of `mach package`) instead of compiling: only settings, extensions
    and the ui/ layer are staged into it."""
    if engine is None:
        require_mozconfig(ctx)
        mach(ctx, "package")
        engine = find_mach_package(ctx)
    elif not engine.is_file():
        raise AmayaError(f"engine archive not found: {engine}")
    appdir, _ = repackage(ctx, engine)
    deb_script = ctx.repo / "packaging" / "debian" / "build-deb.sh"
    if ctx.platform == "linux" and deb_script.is_file():
        version = ctx.upstream().deb_version
        cmd = [str(deb_script), str(appdir), version, str(ctx.dist)]
        if not os.access(deb_script, os.X_OK):
            cmd.insert(0, "bash")
        info(f"building .deb {version}")
        run(cmd, cwd=ctx.repo)
    elif ctx.platform == "linux":
        warn("packaging/debian/build-deb.sh not found; skipping .deb")
    return 0


# --------------------------------------------------------------------------
# rebase
# --------------------------------------------------------------------------
def bump_upstream_json(ctx: Context, new_version: str) -> None:
    path = ctx.upstream_json
    data = json.loads(path.read_text())
    old = str(data["version"])
    if old == new_version:
        info(f"upstream.json already at {new_version}; resuming rebase")
        return
    data["version"] = new_version
    for key in ("source_url", "sha512sums_url"):
        url = data[key]
        if old not in url:
            raise AmayaError(f"cannot derive new {key}: {url!r} does not contain {old!r}")
        data[key] = url.replace(old, new_version)
    if "amaya_revision" in data:
        data["amaya_revision"] = 1
    path.write_text(json.dumps(data, indent=2) + "\n")
    info(f"upstream.json: {old} -> {new_version}")


def rebase_cmd(ctx: Context, new_version: str) -> int:
    ctx.require_no_spaces()
    old_version = ctx.upstream().version
    bump_upstream_json(ctx, new_version)
    if (ctx.engine / ".git").exists():
        fetch_update(ctx)
    else:
        fetch(ctx)
    result = import_patches(ctx, three_way=True, keep_going=True)
    print()
    print(f"Rebase {old_version} -> {new_version}: "
          f"{len(result.applied)} patch(es) applied, {len(result.failed)} failed.")
    for name in result.failed:
        print(f"  FAILED  {name}")
    print("\nNext steps:")
    print(f"  git switch -c rebase/fx-{new_version}")
    if result.failed:
        print("  For each failed patch (in order):")
        print(f"    tools/amaya import --3way      # stops at the first failure with conflict markers")
        print("    # resolve in engine/, then commit as instructed and re-run import")
    print("  tools/amaya export --refresh      # rewrite patches against the new upstream")
    print("  tools/amaya lint-patches && tools/amaya build && tools/amaya run")
    print(f"  git add upstream.json patches && git commit -m 'build: rebase on Firefox {new_version}'")
    return 1 if result.failed else 0


# --------------------------------------------------------------------------
# status
# --------------------------------------------------------------------------
def status_cmd(ctx: Context) -> int:
    up = ctx.upstream()
    workdir, source = ctx.workdir_source()
    print(f"pinned:    {up.product} {up.version} ({up.channel}), amaya revision {up.amaya_revision}")
    print(f"package:   {up.deb_version} / {up.dist_tarball_name(ctx.platform, ctx.arch)}")
    print(f"platform:  {ctx.platform}-{ctx.arch}")
    print(f"workdir:   {workdir}  [{source}]")
    eng = ctx.engine
    if (eng / ".git").exists():
        try:
            ref = upstream_ref(ctx, eng)
            on = git(eng, "describe", "--tags", "--always", "HEAD", check=False).stdout.strip()
            branch = git(eng, "branch", "--show-current", check=False).stdout.strip()
            dirty = git(eng, "status", "--porcelain", "--", ".", ":(exclude)mozconfig",
                        check=False).stdout.strip()
            ahead = git(eng, "rev-list", "--count", f"{ref}..HEAD", check=False).stdout.strip()
            state = f"branch {branch or '(detached)'} at {on}, {ahead} commit(s) on {ref}"
            state += ", uncommitted changes" if dirty else ", clean"
        except AmayaError as e:
            state = str(e)
        print(f"engine:    {eng}\n           {state}")
        print(f"mozconfig: {'present' if ctx.mozconfig_path.is_file() else 'missing (run import)'}")
    else:
        print(f"engine:    {eng} (not fetched)")
    patches = list_patches(ctx)
    errors = lint_all(ctx)
    print(f"patches:   {len(patches)}" + (f" ({len(errors)} lint error(s))" if errors else ""))
    obj = ctx.objdir
    print(f"objdir:    {obj} ({'exists' if obj.is_dir() else 'not built'})")
    for p in (ctx.engine, obj):
        if " " in str(p):
            warn(f"{p} contains a space; mach will refuse it. Set {WORKDIR_ENV}.")
            break
    return 0
