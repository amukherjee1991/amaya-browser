# Amaya Browser — Development Plan

Source of truth for *what* we build: the "AmayaBrowser: Research and Build Plan"
doc (2026-10-24). This file turns it into an engineering plan: order of work,
repo layout, platform sequencing (Debian first, macOS second), and the gates
each phase must pass.

## 1. What we are building

A soft fork of Firefox (release channel, currently **159.0**, pinned in
`upstream.json`): upstream Gecko is downloaded at build time, a thin Amaya
layer is applied on top, and the result is packaged per platform.

```
┌───────────────────────────────────────────────────────────┐
│ Workflow UI      spaces · sidebar · split · glance · cmdk │  Amaya (Phase 2)
├───────────────────────────────────────────────────────────┤
│ Privacy layer    telemetry removed · ETP strict · uBO ·   │  Amaya (Phase 1)
│                  fingerprint modes · HTTPS-only · DoH     │
├───────────────────────────────────────────────────────────┤
│ Gecko engine     sandbox · rendering · JS · WebExtensions │  upstream, rebased
├───────────────────────────────────────────────────────────┤
│ Build & release  tools/amaya · mozconfigs · packaging · CI│  Amaya (Phase 0)
└───────────────────────────────────────────────────────────┘
```

Rule from the plan, enforced in review: **prefer prefs/policies over code
patches**, and **no patch may weaken sandboxing, site isolation, HTTPS-only or
certificate checks.**

## 2. Repository layout

| Path | Contents | Goes into the engine as |
|---|---|---|
| `upstream.json` | Pinned Firefox version, source URL, checksum source | — |
| `tools/amaya` | Python CLI: `fetch`, `import`, `export`, `bootstrap`, `build`, `package`, `run`, `rebase`, `status` | — |
| `configs/` | `mozconfig.common` + per-platform `linux/`, `macos/` mozconfigs | `engine/mozconfig` |
| `patches/` | Ordered `NNNN-area-name.patch` files, each with a `Reason:` and `Owner:` header | applied with `git apply` |
| `branding/amaya/` | Logo sources, generated icons, brand strings, `configure.sh` | `engine/browser/branding/amaya/` |
| `settings/` | `amaya.cfg` (autoconfig prefs), `policies.json`, fingerprint mode pref sets, bundled extensions manifest | installed into the app's `distribution/` and `defaults/pref/` |
| `packaging/debian/` | `.deb` build script, `.desktop`, AppStream metainfo, apt repo notes | — |
| `packaging/macos/` | (Phase M) `.dmg`, signing/notarization, Homebrew cask | — |
| `tests/` | Unit tests for the tooling; the **idle-traffic privacy test** | — |
| `.forgejo/workflows/` | CI: lint + unit tests on every push; full build on a self-hosted runner | — |
| `docs/` | This plan, network-call inventory, release & rebase runbooks | — |

`engine/`, `.cache/`, `dist/` and `obj-*` are never committed.

## 3. Platform sequencing

### Debian first (Phases 0 → 1 → 2 on Linux x86_64)
* Target: Debian 12/13 and Ubuntu-derived distros (this dev box is Zorin 18).
* Build: native on Linux with Mozilla's own toolchains from `./mach bootstrap`
  (installs clang, rust, cbindgen, nodejs, sysroot into `~/.mozbuild`).
* Package: `.deb` first (also unpackaged `.tar.xz`); Flatpak/AppImage/rpm/AUR later.
* Updates: through an apt repository (app updater compiled out on Linux).
* aarch64 Linux after x86_64 is green.

### macOS second (Phase M, starts once Debian passes Gate 1)
* Same patch set and settings; only `configs/macos/mozconfig`, branding icons
  (`.icns`) and `packaging/macos/` are new.
* Requires: a Mac (Apple Silicon) as build host/runner, an Apple Developer ID
  for signing + notarization, universal or per-arch builds (arm64 first,
  x86_64 second).
* Ships `.dmg` + Homebrew cask; updates via Mozilla's updater pointed at an
  Amaya static update manifest (no identifiers in requests).
* Port Zen's native panel background work only if we adopt Zen's UI code (see §6).

## 4. Phases and gates (Debian timeline)

| Phase | Scope | Gate (must pass to continue) |
|---|---|---|
| **0 Foundations** | Repo + git hygiene, `tools/amaya`, mozconfigs, rebrand (`amaya` binary, own icons, no Mozilla marks), first Linux build, `.deb`, Forgejo CI | **Gate 0:** reproducible `tools/amaya build && package` produces an installable `.deb` that launches as "Amaya" |
| **1 Hardened core** | Telemetry/studies/Pocket/sponsored content removed at build + policy level; ETP Strict + Total Cookie Protection; HTTPS-only; DoH (user-chosen, default off until first-run); uBlock Origin bundled; Balanced/Uniform fingerprint modes; network-call inventory | **Gate 1:** idle-traffic test — fresh profile, 5 min idle, zero connections outside `tests/privacy/allowlist.json` |
| **M macOS** | macOS mozconfig, `.icns`, `.dmg`, signing, notarization, cask | Signed + notarized dmg launches on clean macOS; idle-traffic test passes on macOS |
| **2 Workflow UI** | Vertical tabs default, spaces = containers, split view (4 panes), Glance, command bar, mods, importers, first-run (search choice) | **Gate 2:** daily-driver beta on Debian + macOS |
| **3 Trust & scale** | E2E sync (self-hostable), reproducible builds, update/blocklist relay, independent audit, extension guide, Windows | **Gate 3:** audit passed, 1.0 |

## 5. How work is split across agents (this session)

Each agent works on its own branch in its own git worktree and owns disjoint paths;
the integrator (main session) reviews and merges with `--no-ff`.

| Branch | Owner area | Paths |
|---|---|---|
| `feat/tooling` | Build/patch CLI, mozconfigs | `tools/`, `configs/`, `tests/tooling/` |
| `feat/privacy` | Prefs, policies, telemetry build flags, uBO bundle, fingerprint modes, network inventory | `settings/`, `patches/` (privacy), `docs/network-calls.md` |
| `feat/branding` | Name, icons, brand strings | `branding/` |
| `feat/packaging-ci` | `.deb`, desktop integration, Forgejo workflows | `packaging/`, `.forgejo/` |
| `feat/privacy-test` | Idle-traffic test harness + allow-list | `tests/privacy/` |

After merge: integration build on this machine → Gate 0 → Gate 1.

## 6. Decisions (defaults taken, change any time)

| Open question from the plan | Default used now | Revisit |
|---|---|---|
| Vendor Zen's UI or rebuild? | Not needed until Phase 2; leaning **rebuild** a smaller UI so release timing is not tied to Zen | Before Phase 2 |
| Fingerprinting default | **Balanced** (Uniform is opt-in) | — |
| Search engine offered first | Interim **DuckDuckGo, no partner code**; first-run chooser in Phase 2 | Phase 2 |
| Relay vs local lists | **Phase 1: keep Mozilla's security-critical Remote Settings collections** (add-on blocklist, CRLite/cert revocation) direct, everything else off; relay in Phase 3 | Phase 3 |
| Final name | **"Amaya" as working name**; binary `amaya`, app ID `org.amaya.Browser` | Trademark search before any public release |
| Funding | Out of scope for engineering | — |

## 7. Git & Forgejo conventions

* `main` is always buildable; work happens on `feat/*`, `fix/*`, `rebase/fx-NNN` branches.
* Conventional commit subjects (`feat(privacy): …`, `build: …`, `ci: …`).
* Firefox upgrades: `tools/amaya rebase <version>` on a `rebase/fx-<version>` branch → PR; target ≤ 48 h after each Firefox security release.
* Every patch file carries `Reason:` and `Owner:` headers; CI rejects patches without them.
* Forgejo: add the remote later with
  `git remote add origin ssh://git@<forgejo-host>/<owner>/amaya-browser.git && git push -u origin --all`.
  CI lives in `.forgejo/workflows/`; heavy builds need a self-hosted runner labelled `amaya-linux-x64` (and later `amaya-macos-arm64`).
