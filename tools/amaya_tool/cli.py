"""Command-line entry point for `tools/amaya`."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import commands
from .context import Context
from .fetch import fetch
from .patches import export_patch, import_patches, lint_patches_cmd, refresh_patches
from .stage import stage
from .util import AmayaError


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="amaya",
        description="Build and patch tooling for Amaya Browser (a Firefox soft fork).",
    )
    p.add_argument("--repo", type=Path, help=argparse.SUPPRESS)
    sub = p.add_subparsers(dest="command", required=True, metavar="COMMAND")

    s = sub.add_parser("fetch", help="download, verify and unpack the pinned Firefox source")
    s.add_argument("--force", action="store_true", help="delete and re-create an existing engine")

    sub.add_parser("bootstrap", help="write mozconfig and run `mach bootstrap` (toolchains)")

    s = sub.add_parser("import", help="reset engine to upstream, apply branding + patches, write mozconfig")
    s.add_argument("--3way", dest="three_way", action="store_true",
                   help="use `git apply --3way` (leave conflict markers on failure)")
    s.add_argument("--keep-going", action="store_true",
                   help="skip patches that fail and report them at the end")

    sub.add_parser("lint-patches", help="check every patch has Reason:/Owner: headers (CI)")

    s = sub.add_parser("export", help="turn uncommitted engine changes into patches/NNNN-<name>.patch")
    s.add_argument("name", nargs="?", help="short name, e.g. privacy-disable-foo")
    s.add_argument("--refresh", action="store_true",
                   help="regenerate all existing patches from the engine (after a rebase)")
    s.add_argument("--reason", help="value for the Reason: header")
    s.add_argument("--owner", help="value for the Owner: header")

    s = sub.add_parser("build", help="`mach build`, then stage settings into <objdir>/dist/bin")
    s.add_argument("mach_args", nargs=argparse.REMAINDER, help="extra args for mach build")

    s = sub.add_parser("stage", help="install settings/ and bundled extensions into an app dir")
    s.add_argument("appdir", type=Path)

    s = sub.add_parser("run", help="`mach run` (extra args are passed through)")
    s.add_argument("mach_args", nargs=argparse.REMAINDER)

    s = sub.add_parser("package", help="`mach package`, stage, re-tar into dist/, build .deb")
    s.add_argument("--engine", type=Path, help="reuse a prebuilt engine archive instead of compiling")
    sub.add_parser("engine-key", help="print the key of the compiled engine the current tree needs")

    s = sub.add_parser("rebase", help="move to a new Firefox version and re-apply patches")
    s.add_argument("version", help="new Firefox version, e.g. 160.0")

    sub.add_parser("status", help="show pinned version, engine state, patches, objdir")
    return p


def dispatch(args: argparse.Namespace, ctx: Context) -> int:
    c = args.command
    if c == "fetch":
        fetch(ctx, force=args.force)
    elif c == "bootstrap":
        return commands.bootstrap_cmd(ctx)
    elif c == "import":
        result = import_patches(ctx, three_way=args.three_way, keep_going=args.keep_going)
        if result.failed:
            print("failed patches:\n  " + "\n  ".join(result.failed), file=sys.stderr)
            return 1
    elif c == "lint-patches":
        return lint_patches_cmd(ctx)
    elif c == "export":
        if args.refresh:
            if args.name:
                raise AmayaError("export --refresh takes no name")
            refresh_patches(ctx)
        else:
            if not args.name:
                raise AmayaError("export needs a patch name (or --refresh)")
            export_patch(ctx, args.name, reason=args.reason, owner=args.owner)
    elif c == "build":
        return commands.build_cmd(ctx, _strip_dashdash(args.mach_args))
    elif c == "stage":
        stage(ctx, args.appdir)
    elif c == "run":
        return commands.run_cmd(ctx, _strip_dashdash(args.mach_args))
    elif c == "package":
        return commands.package_cmd(ctx, args.engine)
    elif c == "engine-key":
        return commands.engine_key_cmd(ctx)
    elif c == "rebase":
        return commands.rebase_cmd(ctx, args.version)
    elif c == "status":
        return commands.status_cmd(ctx)
    return 0


def _strip_dashdash(extra: list[str]) -> list[str]:
    return extra[1:] if extra[:1] == ["--"] else extra


def main(argv: list[str] | None = None, ctx: Context | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        ctx = ctx or Context(repo=args.repo)
        return dispatch(args, ctx)
    except AmayaError as e:
        print(f"amaya: error: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("amaya: interrupted", file=sys.stderr)
        return 130
