"""Patch queue: lint, import (apply), export and refresh.

Engine bookkeeping model
------------------------
`import` rebuilds the local branch `amaya` in the engine from the upstream tag:

    upstream-<version>
      └─ "amaya-branding"                   (branding/amaya copied in)
      └─ "amaya-patch: 0001-foo.patch"      (one commit per patch file)
      └─ "amaya-patch: 0002-bar.patch"
      ...

`export <name>` turns the uncommitted work on top of that into the next
numbered patch (and commits it the same way); `export --refresh` regenerates
every patch file from its "amaya-patch:" commit, keeping the header.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .context import Context
from .mozconfig import write_mozconfig
from .util import AmayaError, copy_tree, git, git_out, info, warn

PATCH_NAME_RE = re.compile(r"^(\d{4})-[A-Za-z0-9][A-Za-z0-9._-]*\.patch$")
REQUIRED_HEADERS = ("Reason", "Owner")
PATCH_COMMIT_PREFIX = "amaya-patch: "
BRANDING_COMMIT = "amaya-branding"
BRANDING_REL = "browser/branding/amaya"
WORK_BRANCH = "amaya"
# Paths in the engine that never go into a patch. (engine/mozconfig is kept
# out via .git/info/exclude; naming an ignored file in a pathspec makes
# `git add` fail, so it is not listed here.)
EXPORT_EXCLUDES = (BRANDING_REL,)


# --------------------------------------------------------------------------
# lint
# --------------------------------------------------------------------------
def split_header(text: str) -> tuple[str, str]:
    """Split a patch into (header, diff) at the first `diff --git` line."""
    m = re.search(r"^diff --git ", text, re.M)
    if not m:
        return text, ""
    return text[: m.start()], text[m.start():]


def lint_patch(path: Path) -> list[str]:
    errors = []
    if not PATCH_NAME_RE.match(path.name):
        errors.append(f"{path.name}: file name must look like NNNN-area-name.patch")
    text = path.read_text(errors="replace")
    header, diff = split_header(text)
    if not diff:
        errors.append(f"{path.name}: no `diff --git` section found")
    for key in REQUIRED_HEADERS:
        m = re.search(rf"^{key}:[ \t]*(.*)$", header, re.M)
        if not m:
            errors.append(f"{path.name}: missing `{key}:` header line before the first diff")
        elif not m.group(1).strip() or m.group(1).strip().upper().startswith("TODO"):
            errors.append(f"{path.name}: `{key}:` header is empty or still TODO")
    return errors


def list_patches(ctx: Context) -> list[Path]:
    if not ctx.patches_dir.is_dir():
        return []
    return sorted(p for p in ctx.patches_dir.glob("*.patch") if p.is_file())


def lint_all(ctx: Context) -> list[str]:
    errors = []
    patches = list_patches(ctx)
    for p in patches:
        errors.extend(lint_patch(p))
    seen: dict[str, str] = {}
    for p in patches:
        m = PATCH_NAME_RE.match(p.name)
        if m:
            if m.group(1) in seen:
                errors.append(f"{p.name}: number {m.group(1)} already used by {seen[m.group(1)]}")
            seen[m.group(1)] = p.name
    return errors


def lint_patches_cmd(ctx: Context) -> int:
    patches = list_patches(ctx)
    errors = lint_all(ctx)
    for e in errors:
        print(f"error: {e}")
    if errors:
        print(f"{len(errors)} problem(s) in {len(patches)} patch(es)")
        return 1
    print(f"ok: {len(patches)} patch(es) have Reason:/Owner: headers")
    return 0


# --------------------------------------------------------------------------
# import
# --------------------------------------------------------------------------
def upstream_ref(ctx: Context, engine: Path) -> str:
    tag = ctx.upstream().tag
    if git(engine, "rev-parse", "-q", "--verify", f"refs/tags/{tag}^{{commit}}",
           check=False).returncode == 0:
        return tag
    raise AmayaError(
        f"engine has no tag {tag}; is it at the version pinned in upstream.json? "
        "(re-run `tools/amaya fetch --force`)")


def reset_engine(ctx: Context, engine: Path) -> str:
    """Hard-reset the engine to pristine upstream on branch `amaya`."""
    ref = upstream_ref(ctx, engine)
    info(f"resetting engine to {ref}")
    git(engine, "reset", "-q", "--hard")
    git(engine, "checkout", "-q", "-f", "-B", WORK_BRANCH, ref)
    # No -x: ignored files (incl. any objdir) are left alone; obj-* excluded
    # explicitly in case upstream's ignore rules ever change.
    git(engine, "clean", "-fdq", "-e", "/obj-*/", "-e", "/obj-*")
    return ref


def commit_all(engine: Path, message: str) -> None:
    git(engine, "commit", "-q", "--no-verify", "--allow-empty", "-m", message)


def copy_branding(ctx: Context, engine: Path) -> None:
    if not ctx.branding_dir.is_dir():
        warn(f"{ctx.branding_dir} not found; building without Amaya branding files")
        return
    copy_tree(ctx.branding_dir, engine / BRANDING_REL)
    git(engine, "add", "-A", "-f", "--", BRANDING_REL)
    commit_all(engine, BRANDING_COMMIT)
    info(f"copied branding/amaya -> {BRANDING_REL}")


@dataclass
class ImportResult:
    applied: list[str]
    failed: list[str]


def apply_patch(engine: Path, patch: Path, three_way: bool):
    args = ["apply", "--index", "--whitespace=nowarn"]
    if three_way:
        args.append("--3way")
    return git(engine, *args, str(patch), check=False)


def import_patches(
    ctx: Context, three_way: bool = False, keep_going: bool = False
) -> ImportResult:
    engine = ctx.require_engine()
    ctx.require_no_spaces()
    errors = lint_all(ctx)
    if errors:
        raise AmayaError("patch lint failed:\n  " + "\n  ".join(errors))

    reset_engine(ctx, engine)
    copy_branding(ctx, engine)

    result = ImportResult([], [])
    for patch in list_patches(ctx):
        proc = apply_patch(engine, patch, three_way)
        if proc.returncode == 0:
            commit_all(engine, PATCH_COMMIT_PREFIX + patch.name)
            result.applied.append(patch.name)
            info(f"applied {patch.name}")
            continue
        detail = (proc.stderr + proc.stdout).strip()
        result.failed.append(patch.name)
        if keep_going:
            warn(f"FAILED {patch.name} (skipped):\n{detail}")
            git(engine, "reset", "-q", "--hard", "HEAD")
            git(engine, "clean", "-fdq", "-e", "/obj-*/", "-e", "/obj-*")
            continue
        hint = (
            "Conflict markers were left in the engine. Resolve them, then:\n"
            f"    git -C {engine} add -A && "
            f"git -C {engine} commit -m '{PATCH_COMMIT_PREFIX}{patch.name}'\n"
            "    tools/amaya export --refresh   # rewrite the patch file\n"
            "    tools/amaya import             # re-apply the whole queue"
            if three_way else
            "Retry with `tools/amaya import --3way` to get conflict markers."
        )
        raise AmayaError(f"patch {patch.name} does not apply:\n{detail}\n{hint}")

    write_mozconfig(ctx)
    info(f"import done: {len(result.applied)} patch(es) applied"
         + (f", {len(result.failed)} FAILED" if result.failed else ""))
    return result


# --------------------------------------------------------------------------
# export
# --------------------------------------------------------------------------
def slugify(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name.strip()).strip("-.").lower()
    if not slug:
        raise AmayaError(f"invalid patch name: {name!r}")
    return slug


def next_patch_number(ctx: Context) -> int:
    nums = [int(m.group(1)) for p in list_patches(ctx)
            if (m := PATCH_NAME_RE.match(p.name))]
    return max(nums, default=0) + 1


def header_template(subject: str, reason: str | None, owner: str | None) -> str:
    return (
        f"Subject: {subject}\n"
        f"Reason: {reason or 'TODO: why this cannot be a pref/policy'}\n"
        f"Owner: {owner or 'TODO'}\n"
        "\n"
    )


def _diff(engine: Path, *args: str) -> str:
    # Full blob ids make `git apply --3way` work after a rebase.
    return git(engine, "diff", "--binary", "--full-index", *args).stdout


def _exclude_pathspecs() -> list[str]:
    return ["--", "."] + [f":(exclude){p}" for p in EXPORT_EXCLUDES]


def export_patch(
    ctx: Context, name: str, reason: str | None = None, owner: str | None = None
) -> Path:
    engine = ctx.require_engine()
    git(engine, "add", "-A", *_exclude_pathspecs())
    diff = _diff(engine, "--cached", "HEAD")
    if not diff.strip():
        raise AmayaError("no uncommitted changes in the engine (outside branding/mozconfig)")
    ctx.patches_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{next_patch_number(ctx):04d}-{slugify(name)}.patch"
    path = ctx.patches_dir / fname
    path.write_text(header_template(name, reason, owner) + diff)
    commit_all(engine, PATCH_COMMIT_PREFIX + fname)
    info(f"wrote patches/{fname}")
    for e in lint_patch(path):
        warn(f"{e} — edit the header before committing")
    return path


def refresh_patches(ctx: Context) -> list[str]:
    """Regenerate patch files from their engine commits (after a rebase)."""
    engine = ctx.require_engine()
    ref = upstream_ref(ctx, engine)
    log = git_out(engine, "log", "--reverse", "--format=%H %s", f"{ref}..HEAD")
    changed, seen = [], set()
    for line in log.splitlines():
        sha, _, subject = line.partition(" ")
        if not subject.startswith(PATCH_COMMIT_PREFIX):
            continue
        fname = subject[len(PATCH_COMMIT_PREFIX):].strip()
        seen.add(fname)
        path = ctx.patches_dir / fname
        if path.exists():
            header, _ = split_header(path.read_text())
        else:
            header = header_template(fname, None, None)
        new = header + _diff(engine, f"{sha}^", sha)
        if not path.exists() or path.read_text() != new:
            ctx.patches_dir.mkdir(parents=True, exist_ok=True)
            path.write_text(new)
            changed.append(fname)
            info(f"refreshed patches/{fname}")
    for p in list_patches(ctx):
        if p.name not in seen:
            warn(f"patches/{p.name} has no commit in the engine (not applied?); left unchanged")
    status = git_out(engine, "status", "--porcelain", *_exclude_pathspecs())
    if status:
        warn("the engine has uncommitted changes; they are not in any patch "
             "(use `tools/amaya export <name>`)")
    info(f"refresh done: {len(changed)} patch file(s) changed")
    return changed
