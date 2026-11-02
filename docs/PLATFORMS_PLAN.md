# Platform plan: macOS and Debian arm64

Status 2026-10-30: Amaya ships **Debian/Ubuntu amd64 (x86-64)** — `.deb` and
`.tar.xz`, released from `v*` tags in ~7 minutes on top of a prebuilt engine
(`engine-<key>` releases, see `tools/README.md`). This plan adds:

1. **Debian/Ubuntu arm64** (aarch64: Raspberry Pi 4/5, ARM laptops and servers)
2. **macOS** — Apple Silicon (arm64) first, then Intel (x86-64), later a universal build

Nothing in the privacy layer or the UI is platform-specific except a few
places listed below; most work is build, packaging, signing and CI.

## How the pipeline extends

| Piece | Today | With this plan |
|---|---|---|
| Engine key | `159.0-linux-x86_64-<hash>` | One per platform/arch: `…-linux-aarch64-…`, `…-macos-aarch64-…`, `…-macos-x86_64-…` (already in the key format) |
| `engine.yml` | one Linux job | a **matrix**, one job per platform/arch; each publishes `engine-<key>` |
| `release.yml` | one Linux job | a matrix; each job downloads its engine, stages, tests, uploads; a final job publishes **one** GitHub Release with every platform's files |
| Website (`latest.json`, `sync-release.py`, `site.js`) | `files.deb`, `files.tar` | per-platform files: `files.linux-x86_64.deb`, `files.linux-aarch64.deb`, `files.macos-aarch64.dmg`, …; the page detects the visitor's OS and offers the right one first |
| Update prompt (`ui/modules/update`) | amd64 `.deb`/`.tar.xz` | picks its own platform's file; on macOS uses Firefox's built-in updater instead (below) |

## 1. Debian / Ubuntu arm64

**Build.** GitHub offers free native arm64 Linux runners for public repos
(`ubuntu-22.04-arm`). Build natively there with the same steps as amd64 —
`tools/amaya` already detects `aarch64` and names the objdir
`obj-amaya-linux-aarch64`. Fallback if those runners are too slow: cross-compile
on the x86 runner with `--target=aarch64-unknown-linux-gnu` (Mozilla's bootstrap
provides the arm64 sysroot).

**Packaging.** `build-deb.sh` already supports `AMAYA_DEB_ARCH=arm64` (tested in
the packaging smoke test); Depends come from `dpkg-shlibdeps` on the arm64 runner.

**Tests.** Gate 1 runs natively on the arm64 runner (same namespace harness).

**Work items**
- [ ] `engine.yml` / `release.yml`: add the `linux-aarch64` matrix entry (`runs-on: ubuntu-22.04-arm`)
- [ ] First arm64 engine build on GitHub (2–4 h, likely longer on 4 arm cores; keep swap + `MOZ_PARALLEL_BUILD=3`)
- [ ] Release job publishes `amaya_<ver>_arm64.deb` and `amaya-<ver>.linux-aarch64.tar.xz`
- [ ] Website + mirror + update prompt: per-arch files
- [ ] Smoke test on real hardware (a Raspberry Pi 5 or an arm64 VM)

**Estimate:** about 1 day of work, plus one long engine build.

## 2. macOS (Apple Silicon first, then Intel)

### Build
Mozilla builds Firefox for macOS **on Linux** (cross-compilation with the macOS
SDK, which `mach bootstrap` can fetch). Do the same: the compile runs on the
fast, free Linux runners; only testing needs a Mac runner.

- `configs/macos/mozconfig` (placeholder exists): `--target=aarch64-apple-darwin`,
  `--with-macos-sdk=…`, updater **on**, update channel `release`.
- Intel: second matrix entry `--target=x86_64-apple-darwin`.
- Universal (one app for both) later: Mozilla's `unify` script merges the two builds.

### Branding
- `branding/amaya/firefox.icns` and the dmg background/`.DS_Store` already exist.
- **`Assets.car` is missing**: the macOS icon catalog must be compiled once with
  Xcode's `actool` from `branding/macos/AppIcon.xcassets` (command in
  `branding/README.md`). Needs a Mac (or the GitHub macOS runner) once; commit the result.
- Bundle id `org.amaya.Browser`, app name `Amaya.app`, volume name "Amaya".

### Signing and notarization
Without an Apple Developer ID, macOS Gatekeeper blocks the app ("Amaya can't be
opened"); users would have to right-click → Open or run `xattr -dr
com.apple.quarantine`. For a real release:
- Apple Developer Program membership (USD 99/year) → a **Developer ID
  Application** certificate.
- Sign with the hardened runtime and the entitlements Firefox needs (JIT etc.;
  listed in `packaging/macos/README.md`), using **`rcodesign`**, which signs
  and notarizes from Linux — no Mac needed for releases.
- Notarize with an App Store Connect API key, then staple the ticket to the `.dmg`.
- GitHub secrets: the certificate (`.p12` + password) and the notary API key.

### Updates on macOS
Eventually keep **Firefox's built-in updater** (MAR files): it can replace
the app without admin rights. Amaya serves a static update manifest from
amaya.arghyam.me (`/update/<channel>/update.xml`) — no identifiers in the URL
beyond version and platform, per the plan. Sign MAR files with an Amaya MAR
key (`--enable-verify-mar` with Amaya's public key compiled in). The release
job generates the complete MAR and the manifest. The `update` UI module will
defer to the built-in updater on macOS once that exists.

**Interim (now):** `configs/macos/mozconfig` keeps `--enable-updater` compiled
in for that future, but it is not configured — `application.ini` still carries
Mozilla's own real `aus5.mozilla.org` URL unmodified, compiled in, which a left
-enabled updater would periodically query with build/version/channel info.
`settings/policies.json` sets `DisableAppUpdate: true` to turn that off until
the MAR key + manifest above exist (found 2026-11-01: the first macOS build
would otherwise have silently checked Mozilla's real update server). The
`ui/modules/update/` JS module (the Linux mechanism: a static `latest.json`,
manual download, user-initiated) now also covers macOS via a `"dmg"` file
entry — `packagedType()` returns `"dmg"` on macOS instead of falling through to
`"tar"` (found and fixed the same day: it was offering the Linux tarball).

### Packaging and distribution
- `.dmg` from `mach package` (works when cross-compiling).
- Homebrew cask: template in `packaging/macos/amaya.rb.template`; publish in a
  tap repo (`amukherjee1991/homebrew-amaya`) so `brew install --cask amukherjee1991/amaya/amaya` works.

### UI layer on macOS
- Shell: window controls (traffic lights) top-left of the sidebar — already
  handled; in compact mode they hide until hover (known gap).
- Keyboard: `Cmd` instead of `Ctrl` — cmdbar uses `Accel`; check spaces
  (`Cmd+1…9`), compact (`Cmd+Shift+S`), split (`Cmd+Option+arrows`), Glance (`Option+click`).
- Native look: vibrancy/translucent sidebar background (the plan's "port Zen's
  native panel backgrounds"), as a later polish.

### Tests
- Gate 1 on macOS: the namespace harness is Linux-only; port it with `pf` +
  `pflog` per `tests/privacy/README.md` and run it on GitHub's `macos-14`
  (Apple Silicon) runner.
- UI screenshots via `ui/tools/shot.py` on the macOS runner.

**Work items**
- [ ] Decide the Apple Developer account (needed before a signed release)
- [x] `configs/macos/mozconfig`, `tools/amaya fetch/bootstrap/import` run natively on an
      Apple Silicon Mac without changes (`feat/macos` branch, 2026-11-01); `tools/amaya build`
      underway as this is written — see the branch for the outcome. `engine.yml` /
      `release.yml` got `macos-aarch64` jobs, gated behind `workflow_dispatch`
      (`build_macos: true`) rather than the normal push/tag trigger until a
      real CI run has been checked — cross-compiling on Linux is still untried
- [x] Compile `Assets.car` once on a Mac (`xcrun actool`, committed to `branding/amaya/`)
- [x] `tools/amaya package` on macOS: mounts mach's own `.dmg` (background/icon/
      `Applications` symlink already baked in from `branding/amaya/`), re-stages
      settings into `Contents/Resources`, rebuilds an **unsigned** `Amaya-<version>-<arch>.dmg`.
      No separate build-dmg.sh needed — mach's native DMG packaging already does the
      Finder polish; signing + notarization (`rcodesign`) still need the Apple Developer ID
- [ ] MAR signing key + update manifest on amaya.arghyam.me
- [ ] Gate 1 macOS port (pf) on `macos-14`
- [x] Keyboard and window-control checks in each UI module — confirmed already handled:
      `cmdbar.js`/`shell.js` branch `e.metaKey` vs `e.ctrlKey` on `AppConstants.platform`;
      compact-mode traffic-light hover is still a known cosmetic gap
- [x] amaya.arghyam.me: `.dmg` wired into `latest.json`/`sync-release.py`/`site.js`,
      offered first to visitors on a Mac (website repo, `feat/macos` branch)
- [ ] Homebrew tap
- [ ] Intel build, then universal

**Estimate:** 3–5 days of work once the Apple Developer account exists; an
unsigned preview build can come first (about 2 days), clearly labelled.

## Order

1. arm64 Debian (small, uses everything that exists)
2. macOS Apple Silicon, unsigned preview
3. macOS signed + notarized, built-in updates
4. macOS Intel, then universal
5. (separately) the signed apt repo for both Debian architectures

## Decided

- **macOS order:** Apple Silicon first, then Intel (owner, 2026-10-30). Universal build later.

## Decisions for the owner

| Question | Why it matters |
|---|---|
| Apple Developer Program (USD 99/yr)? | Required for a macOS build that opens without warnings and can auto-update cleanly |
| Is there a Mac for testing? | GitHub's macOS runner covers CI; a real Mac is still the best check for the UI |
| Ship an unsigned macOS preview before signing? | Faster feedback; users need one extra step to open it |
