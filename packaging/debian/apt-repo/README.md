# Amaya's apt repository

Amaya is published as a signed static apt repository at
**<https://amaya.arghyam.me/apt/>**. The `.deb` registers it (like Chrome's
package does), so installing the downloaded `.deb` once is enough: later
releases arrive through `apt upgrade`, Software Updater and GNOME Software.

## Signing key

| | |
|---|---|
| User ID | `Amaya Browser repository signing key <noreply@amaya.arghyam.me>` |
| Fingerprint | `6242 000F 8ECA 87AB 349E  B142 510D 7EE9 065E B0AC` |
| Algorithm | Ed25519, sign only |
| Created / expires | 2026-10-31 / 2029-10-30 |

Public key, in this directory and on the site:

* `amaya-archive-keyring.gpg`: binary keyring for `Signed-By`
  (<https://amaya.arghyam.me/apt/amaya-archive-keyring.gpg>)
* `amaya-archive-keyring.asc`: the same key, armored
  (<https://amaya.arghyam.me/apt/amaya-archive-keyring.asc>)

The secret key lives only on the web host, in
`~/.local/share/amaya-apt/gnupg` (no passphrase, so the 6-hourly sync can sign
unattended), with an offline-able backup in
`~/.local/share/amaya-apt/backup/amaya-repo-secret-<fingerprint>.asc`. Never
commit it.

**Before 2029-10-30** extend the expiry (`gpg --quick-set-expire <fpr> 3y`),
re-export both public files here, rebuild the `.deb` and re-sign the repo
(`build-apt-repo.py --force`). Old `.deb`s keep working because the key
stays the same.

## What the .deb installs

| Path | Owner | Notes |
|---|---|---|
| `/etc/apt/sources.list.d/amaya.sources` | conffile | deb822: `URIs: https://amaya.arghyam.me/apt/`, `Suites: stable`, `Components: main`, `Architectures: <arch>`, `Signed-By:` the keyring below. Add `Enabled: no` to stop apt updates; the edit survives upgrades. Deleted on `apt purge`. |
| `/usr/share/keyrings/amaya-archive-keyring.gpg` | package file | The public key above. |

* `preinst` removes an `amaya.sources` that dpkg does not track yet (the
  manual setup on the website, or an upgrade from 159.0-4 or older) when it
  points at the same repository, so dpkg does not stop with a
  conffile question.
* `postrm remove` puts the key back after `apt remove` (dpkg keeps the
  conffile until purge, and a source without its key would break
  `apt update`); `postrm purge` deletes it.
* lintian's `package-installs-apt-sources` error is expected for a
  third-party package and suppressed in `test-build-deb.sh`.

## Layout

```
apt/
  amaya-archive-keyring.gpg, .asc
  pool/main/a/amaya/amaya_<version>_<arch>.deb      newest 3 versions
  dists -> .dists/<stamp>/dists                     switched atomically
  dists/stable/InRelease, Release, Release.gpg
  dists/stable/main/binary-{amd64,arm64}/Packages{,.gz,.xz}   arm64 empty for now
  dists/stable/main/dep11/Components-{amd64,arm64}.yml{,.gz}  AppStream catalog
  dists/stable/main/dep11/icons-{48x48,64x64,128x128,64x64@2,128x128@2}.tar{,.gz}
  media/org.amaya.Browser/icons/<N>x<N>/amaya_org.amaya.Browser.png
```

The AppStream (DEP-11) catalog is what GNOME Software / Zorin Software /
Ubuntu's App Center read for packages that are not installed yet: name,
summary, description, **MPL-2.0** licence, homepage, the Λ icon (cached icons
named `amaya_org.amaya.Browser.png`, the DEP-11 `<package>_<id>.png` rule),
categories, keywords, MIME types and the releases (`159.0-4`, …, the full
Amaya version). It is generated from `../org.amaya.Browser.metainfo.xml.in`,
`../org.amaya.Browser.desktop` and `branding/linux/hicolor`.

### Which version Software shows

GNOME Software shows the *package* version with the epoch and the Debian
`-revision` cut off (`gs_app_get_version_ui`), so `159.0-4` appears as
**159.0** on the details and updates pages; the release list (from the
AppStream `Releases` above, and the installed metainfo) does say `159.0-4`.
Not checked in a running GNOME Software (no desktop in the test containers). Fixing that means changing the Debian
version scheme, which has not been done. Options:

| Scheme | Software shows | Notes |
|---|---|---|
| `159.0-4` (today) | 159.0 | Revision hidden; two Amaya builds of one Gecko look identical. |
| `159.0.0.4-1` | 159.0.0.4 | Always `<major>.<minor>.<patch>.<amaya rev>`; sorts above `159.0-4` and stays ordered across Firefox point releases (`159.0.0.4` < `159.0.1.1`). Long. |
| `159.0.4-1` | 159.0.4 | Short, but collides with Firefox point releases: Amaya rev 4 of 159.0 (`159.0.4`) would sort above rev 1 of Firefox 159.0.1 (`159.0.1.1`). |
| `159.0+a4-1` | 159.0+a4 | Sorts above `159.0-4` and before `159.0.1`; reads oddly, and some front ends trim `+…` suffixes. |

## Building

`build-apt-repo.py` (Python stdlib + `apt-ftparchive` + `dpkg-deb` + `gpg`):

```sh
packaging/debian/apt-repo/build-apt-repo.py --repo ~/amaya-apt \
    --deb dist/amaya_159.0-5_amd64.deb
```

* copies the `.deb`s into `pool/`, keeps the newest 3 versions per
  package/arch (`--keep`), writes `Packages`, the DEP-11 catalog and icon
  tarballs, a `Release` with MD5/SHA256/SHA512 for every index, then signs
  `InRelease` (clearsigned) and `Release.gpg` (detached).
* builds the new `dists/` under `.dists/` and switches the `dists` symlink with
  one `rename`, so clients never see a half-written repository; the previous
  generation is kept for clients that are mid-update.
* is idempotent: with nothing new it prints `unchanged` and changes nothing
  (`--force` re-signs anyway).
* key: `--gnupghome` (default `~/.local/share/amaya-apt/gnupg`, or
  `$AMAYA_APT_GNUPGHOME`) and `--key <fingerprint>` (default: the only secret
  key there, or `$AMAYA_APT_KEY`). `--no-sign` is for tests.

On the web host the repository folder `~/amaya-apt` is mounted read-only into
the `amaya-web` nginx container at `/apt/`; the website's `sync-release.py`
(systemd timer, every 6 h) runs this script after it mirrors a new release, and
`publish-local.sh` does the same for manual publishes.

## Manual setup (without the .deb)

```sh
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://amaya.arghyam.me/apt/amaya-archive-keyring.gpg \
  | sudo tee /etc/apt/keyrings/amaya-archive-keyring.gpg >/dev/null
printf '%s\n' 'Types: deb' 'URIs: https://amaya.arghyam.me/apt/' 'Suites: stable' \
  'Components: main' 'Architectures: amd64' \
  'Signed-By: /etc/apt/keyrings/amaya-archive-keyring.gpg' \
  | sudo tee /etc/apt/sources.list.d/amaya.sources
sudo apt update && sudo apt install amaya
```

Installing the package then replaces this `amaya.sources` with its own (same
repository, key under `/usr/share/keyrings`).

## Compatibility note

`build-deb.sh` computes `Depends` with `dpkg-shlibdeps` on the build host, so
the package names match the build host's distro. A build on Ubuntu 24.04 /
Zorin 18 / Debian 13 depends on the `t64` library names (`libgtk-3-0t64`,
`libasound2t64`, …) and will not install on Debian 12 or Ubuntu 22.04: apt
sees the repository and the version there, but cannot resolve the
dependencies. To target those as well, build in that environment, or set
`AMAYA_DEB_NO_SHLIBDEPS=1` to use the built-in list, which has `new | old`
alternatives for the renamed libraries.

## Alternative: Forgejo's Debian registry

`publish-forgejo.sh` uploads a `.deb` to Forgejo's built-in package registry,
which signs with Forgejo's own key (see `docs/forgejo-setup.md` §2):

```sh
FORGEJO_URL=https://forgejo.example.org FORGEJO_OWNER=amaya \
FORGEJO_USER=<you> FORGEJO_TOKEN=<token> \
packaging/debian/apt-repo/publish-forgejo.sh dist/amaya_159.0-1_amd64.deb
```

Users of that registry would need its key and URL instead of the ones above;
the `.deb` itself always points at amaya.arghyam.me.
