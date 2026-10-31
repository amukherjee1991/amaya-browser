# tools/amaya

Build and patch tool for Amaya Browser. Python 3.11+, standard library only.
`tools/amaya` is a thin launcher; the code is in `tools/amaya_tool/`.

## Work directory (engine + objdir)

`mach` refuses to run from a path that contains a space, so the engine and
object directory can live outside the repository. The work dir is resolved as:

1. `$AMAYA_WORKDIR`, else
2. `amaya.local.json` in the repo root: `{"workdir": "/home/me/amaya-build"}`, else
3. the repo root.

Engine = `<workdir>/engine`, objdir = `<workdir>/obj-amaya-<platform>-<arch>`
(e.g. `obj-amaya-linux-x86_64`). Paths are resolved with `realpath`, so
`engine` may be a symlink. Commands that run `mach` fail with a clear message
if either path contains a space. When the work dir is not the repo,
`fetch` also creates `<repo>/engine` as a symlink to the real engine.

## Commands

| Command | What it does |
|---|---|
| `fetch [--force]` | Download the source tarball + `SHA512SUMS` named in `upstream.json` into `.cache/` (cached), verify sha512, extract into the engine (top dir stripped), `git init -b upstream`, commit `upstream firefox <version>`, tag `upstream-<version>`. Refuses to overwrite an existing engine without `--force`. |
| `bootstrap` | Write `engine/mozconfig`, then `./mach --no-interactive bootstrap --application-choice browser` (toolchains into `~/.mozbuild`). |
| `import [--3way] [--keep-going]` | Lint patches; hard-reset the engine to `upstream-<version>` on local branch `amaya` and `git clean` it (objdir never touched); copy `branding/amaya/` to `browser/branding/amaya/` (commit `amaya-branding`); apply `patches/*.patch` in sorted order with `git apply --index` (one commit `amaya-patch: <file>` each); write `engine/mozconfig`. Stops at the first failing patch, naming it; `--3way` leaves conflict markers; `--keep-going` skips failures and lists them (exit 1). |
| `lint-patches` | Check every patch is named `NNNN-area-name.patch`, has a `diff --git`, and has non-empty, non-TODO `Reason:` and `Owner:` lines before the first diff. Exit 1 on problems (for CI). |
| `export <name> [--reason R] [--owner O]` | Turn uncommitted engine changes (excluding `browser/branding/amaya` and `mozconfig`) into `patches/NNNN-<name>.patch` with a `Subject:/Reason:/Owner:` header, and commit it in the engine. Without `--reason/--owner` the header says TODO and lint fails until it is filled in. |
| `export --refresh` | Rewrite every patch from its `amaya-patch:` commit in the engine (keeping its header). Use after resolving conflicts / a rebase. |
| `build [-- mach args]` | `./mach build`, then `stage <objdir>/dist/bin`. |
| `stage <appdir>` | Install `settings/amaya.cfg` → `<appdir>/amaya.cfg`, `settings/autoconfig.js` → `defaults/pref/`, `settings/policies.json` → `distribution/`, and each `settings/extensions.json` entry (`[{"id","url","sha256"}]`) → `distribution/extensions/<id>.xpi` (downloaded to `.cache/extensions/`, sha256-verified). Missing settings files only warn. |
| `run [-- mach args]` | `./mach run …`. |
| `package` | `./mach package`; extract `<objdir>/dist/amaya-*.tar.xz` into `dist/stage/`; `stage` it; re-tar to `dist/amaya-<version>-<rev>.<platform>-<arch>.tar.xz`; on Linux run `packaging/debian/build-deb.sh <appdir> <version>-<rev> dist/` if present. |
| `rebase <version>` | Bump `upstream.json` (version, URLs, `amaya_revision` → 1); fetch and verify the new tarball and commit it on the engine's `upstream` branch (old blobs stay available for real 3-way merges); tag; `import --3way --keep-going`; report failed patches and print next steps for a `rebase/fx-<version>` branch. Re-running resumes. |
| `status` | Pinned version/revision, package names, work dir and its source, engine branch/state, patch count + lint errors, objdir. |

`upstream.json` may contain `"amaya_revision": N` (default 1); the Debian
version is `<firefox version>-<N>`.

## mozconfig

`engine/mozconfig` = `configs/mozconfig.common` + `configs/mozconfig.privacy`
(if present) + `configs/<platform>/mozconfig` + a generated
`mk_add_options MOZ_OBJDIR=<absolute objdir>`. mach is run with
`MOZCONFIG` pointing at it and `DISABLE_TELEMETRY=1` (mach's own telemetry).

## Fixing a patch that no longer applies

```sh
tools/amaya import --3way          # stops at the failing patch, conflict markers in engine/
# resolve the conflicts in engine/, then:
git -C engine add -A && git -C engine commit -m 'amaya-patch: 0003-foo.patch'
tools/amaya export --refresh       # rewrites patches/0003-foo.patch
tools/amaya import                 # re-apply the whole queue cleanly
```

## Tests

```sh
python3 -m unittest discover -s tests/tooling -v
```

## Firefox release watch

`tools/firefox_release_watch.py` compares `upstream.json` with Mozilla's latest
release (product-details) and prints JSON. The **Firefox release watch** GitHub
workflow (`.github/workflows/firefox-release-watch.yml`) runs it every 6 hours
and opens one `upstream-release` issue per new Firefox version, with release
notes, security advisories, the `tools/amaya rebase <version>` steps and a
checklist. Run it by hand from the Actions tab ("Run workflow").

## Fast releases: prebuilt engine

Only `upstream.json` (minus `amaya_revision`), `patches/`, `configs/` and
`branding/amaya/` need a Gecko compile. `tools/amaya engine-key` fingerprints
them; the **Engine build** workflow compiles once per key (2-4 h) and stores the
result as the GitHub Release `engine-<key>`. The **Release** workflow (on `v*`
tags) downloads that engine and runs `tools/amaya package --engine <archive>`,
which stages settings, extensions and `ui/` into it — about 15 minutes.
