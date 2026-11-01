# Release runbook (Linux / Debian)

Amaya version = Firefox version + Amaya revision, written as a Debian version:
`159.0-1` = Firefox 159.0, first Amaya build of it. Tags are `v<debversion>`
(`v159.0-1`). There is no CI yet. Every step below runs on the Linux
build machine.

## Target: 48 hours for Firefox security releases

When Mozilla ships a release that fixes security bugs (check the advisories
at <https://www.mozilla.org/security/advisories/>), Amaya must have a tagged,
published build within **48 hours**. For non-security point releases, the
same process applies without the deadline.

| Hour | Step |
|---|---|
| 0 | Firefox release published, rebase branch opened (§1) |
| ≤ 24 | Patches rebased, builds, checklist (§3) green |
| ≤ 36 | Merged to `main`, tagged, packaged |
| ≤ 48 | Published to the apt repository, release notes up |

If a patch cannot be rebased in time, it is better to ship without the
feature it carries (and say so in the release notes) than to ship late.
That never applies to privacy-critical patches: ship late before shipping
a build that leaks.

## 1. New upstream Firefox version

```sh
git switch main && git pull
git switch -c rebase/fx-159.0.1
tools/amaya rebase 159.0.1        # updates upstream.json, re-applies patches/
tools/amaya build
```

`upstream.json` gets the new `version` and the Amaya revision goes back to
`1` (`amaya_revision`, default 1 if the field is absent). Fix patches that no
longer apply. Each patch keeps its `Reason:`/`Owner:` headers. Open a PR
`rebase/fx-159.0.1 → main` and merge with `--no-ff` once §3 is green.

## 2. Amaya-only release (same Firefox)

Changes in prefs, policies, branding or packaging without a Firefox bump:
increment `amaya_revision` in `upstream.json` (`159.0-1` → `159.0-2`) in the
PR that makes the change. Never reuse a version number: the apt repository
rejects a second upload of the same name/version/arch.

## 3. Release checklist

Run on the merge commit, before tagging:

- [ ] `tools/amaya fetch && tools/amaya import && tools/amaya build` from a
      clean `AMAYA_WORKDIR` succeeds (no leftover objdir state).
- [ ] `python3 -m unittest discover -s tests/tooling` and
      `tools/amaya lint-patches` pass.
- [ ] `packaging/debian/test-build-deb.sh` passes.
- [ ] **Sandbox unchanged:** `about:support` → *Sandbox*: content process
      sandbox level 4 on Linux, user namespaces available, no
      `security.sandbox.*` prefs changed from upstream defaults.
- [ ] **Site isolation unchanged:** `fission.autostart` is `true`, and
      `about:support` shows Fission windows enabled.
- [ ] **HTTPS-only unchanged:** `dom.security.https_only_mode` is `true`, and
      `http://example.com` upgrades to HTTPS.
- [ ] **Mixed scripts never load over http:** on
      <https://mixed-script.badssl.com> the `http://` script is upgraded to
      https (HTTPS-Only) or blocked. To check on the wire:
      `MOZ_LOG=nsHttp:3 MOZ_LOG_FILE=/tmp/mc amaya --headless --screenshot
      /tmp/mc.png https://mixed-script.badssl.com/`; the log must show
      `GET /nonsecure.js` only on a `mixed-script.badssl.com:443` connection.
- [ ] **Certificate checks unchanged:** <https://expired.badssl.com> and
      <https://self-signed.badssl.com> show an error page.
- [ ] `git diff <previous-tag> -- patches/ settings/` reviewed. No patch
      weakens sandboxing, site isolation, HTTPS-only or certificate checks.
- [ ] **Idle-traffic test green:** `tests/privacy/run.sh <path-to-amaya>`
      (fresh profile, 5 min idle, zero connections outside
      `tests/privacy/allowlist.json`).
- [ ] **Comparative benchmarks run for this version** (once per release, not
      continuously): run the benchmark suite from the private test repo
      against the build being released. It compares Amaya with the current
      Firefox, Chrome, Brave, LibreWolf and Mullvad Browser and publishes
      the results for this version to the website's benchmarks page.
- [ ] `.deb` installs on a clean Debian 13 VM (and Ubuntu 24.04), launches
      as "Amaya" with the Amaya icon, and appears as an `x-www-browser`
      alternative.

## 4. Tag, package, publish

```sh
git switch main && git pull
git tag -s v159.0-1 -m "Amaya 159.0-1 (Firefox 159.0)"
tools/amaya package          # dist/amaya_159.0-1_amd64.deb (+ .sha256), dist/*.tar.xz
sha256sum -c dist/*.sha256
git push origin main v159.0-1
```

The apt repository at <https://amaya.arghyam.me/apt/> (the one the `.deb`
registers) updates itself: the website's `sync-release.py` timer mirrors the
newest GitHub release every 6 h and runs
`packaging/debian/apt-repo/build-apt-repo.py` on the new `.deb`. To publish
at once instead, run on the web host:

```sh
packaging/debian/apt-repo/build-apt-repo.py --repo ~/amaya-apt --deb dist/amaya_159.0-1_amd64.deb
```

Optionally also publish to Forgejo's registry (see `docs/forgejo-setup.md` §2):

```sh
FORGEJO_URL=https://<forgejo-host> FORGEJO_OWNER=<owner> FORGEJO_USER=<you> \
FORGEJO_TOKEN=<token> packaging/debian/apt-repo/publish-forgejo.sh dist/amaya_159.0-1_amd64.deb
```

Then create the Forgejo release for the tag and attach the `.deb`, `.tar.xz`
and `.sha256` files. Release notes list the Firefox version and its security
advisory link, plus Amaya changes since the previous tag.

## 5. After release

* `sudo apt update && apt policy amaya` on a test machine shows the new
  version from `https://amaya.arghyam.me/apt`, and an upgrade from the
  previous version works (Software Updater lists it).
* If something is wrong, do not delete and re-upload the same version.
  Ship `159.0-2`.
