"""mach-driven commands (bootstrap/build/run/package), rebase and status."""

from __future__ import annotations

import json
import os
import shutil
import tarfile
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
    candidates = [p for pat in ("amaya-*.tar.xz", "amaya-*.tar.bz2")
                  for p in dist.glob(pat) if p.is_file()]
    if not candidates:
        raise AmayaError(f"no amaya-*.tar.xz / .tar.bz2 found in {dist}")
    return max(candidates, key=lambda p: p.stat().st_mtime)


def extract(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    if shutil.which("tar"):
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


def repackage(ctx: Context, mach_archive: Path) -> tuple[Path, Path]:
    """Extract mach's archive into dist/stage, stage settings, re-tar."""
    up = ctx.upstream()
    stage_root = ctx.dist / "stage"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    extract(mach_archive, stage_root)
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


def package_cmd(ctx: Context) -> int:
    require_mozconfig(ctx)
    mach(ctx, "package")
    appdir, _ = repackage(ctx, find_mach_package(ctx))
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
