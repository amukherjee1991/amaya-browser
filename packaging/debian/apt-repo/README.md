# Publishing Amaya as an apt repository

Two ways to ship `amaya_<version>_<arch>.deb` to users. Use the first one unless
you need to host the repo somewhere other than Forgejo.

## 1. Forgejo's built-in Debian package registry (primary)

Forgejo hosts and signs the repository itself. Nothing else is needed.

**Upload** (needs a personal access token with the `write:package` scope):

```sh
FORGEJO_URL=https://forgejo.example.org \
FORGEJO_OWNER=amaya \
FORGEJO_USER=<your-user> \
FORGEJO_TOKEN=<token> \
packaging/debian/apt-repo/publish-forgejo.sh dist/amaya_159.0-1_amd64.deb
```

The script calls the registry's upload endpoint:

```sh
curl --user <user>:<token> --upload-file dist/amaya_159.0-1_amd64.deb \
  https://forgejo.example.org/api/packages/amaya/debian/pool/stable/main/upload
```

* `stable` / `main` can be changed with `APT_DISTRIBUTION` / `APT_COMPONENT`.
* Re-uploading the same name + version + arch returns **409 Conflict**. Bump
  the Debian revision (`159.0-2`) or set `REPLACE=1`, which deletes the old
  file first (`DELETE …/pool/stable/main/amaya/159.0-1/amd64`).

**Users install with:**

```sh
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://forgejo.example.org/api/packages/amaya/debian/repository.key \
  -o /etc/apt/keyrings/forgejo-amaya.asc
echo "deb [signed-by=/etc/apt/keyrings/forgejo-amaya.asc] https://forgejo.example.org/api/packages/amaya/debian stable main" \
  | sudo tee /etc/apt/sources.list.d/amaya.list
sudo apt update && sudo apt install amaya
```

If the owning user/org is private, apt needs credentials in the URL
(`https://<user>:<token>@forgejo.example.org/...`); keep the registry public.

## 2. Static signed repository (any web host)

`build-static-repo.sh` builds a classic `dists/` + `pool/` tree with
`apt-ftparchive` and signs it with your own GPG key (`InRelease` via
`gpg --clearsign`, plus `Release.gpg`). Serve the directory with nginx,
Forgejo/Codeberg Pages, S3, etc.

```sh
# once: create a signing key (keep it offline / on a hardware token)
gpg --quick-gen-key "Amaya Archive Signing Key" ed25519 sign 2y

GPG_KEY_ID=<fingerprint> packaging/debian/apt-repo/build-static-repo.sh \
  public/apt dist/amaya_159.0-1_amd64.deb
rsync -a public/apt/ host:/var/www/apt/
```

Running it again with new `.deb`s adds them to the pool and re-signs. Users:

```sh
sudo curl -fsSL https://apt.example.org/amaya-archive-keyring.asc \
  -o /etc/apt/keyrings/amaya.asc
echo "deb [signed-by=/etc/apt/keyrings/amaya.asc] https://apt.example.org stable main" \
  | sudo tee /etc/apt/sources.list.d/amaya.list
```

Tested: a repo built by this script in a `debian:trixie` container passes
`apt update` with `signed-by`, `apt install amaya` registers the
`x-www-browser`/`gnome-www-browser` alternatives, and `apt remove` removes them.

## Compatibility note

`build-deb.sh` computes `Depends` with `dpkg-shlibdeps` on the build host, so
the package names match the build host's distro. A build on Ubuntu 24.04 /
Zorin 18 / Debian 13 depends on the `t64` library names (`libgtk-3-0t64`,
`libasound2t64`, …) and will not install on Debian 12. To target Debian 12 as
well, build in a Debian 12 environment, or set
`AMAYA_DEB_NO_SHLIBDEPS=1` to use the built-in list, which has
`new | old` alternatives for the renamed libraries.
