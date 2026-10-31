# Forgejo setup

The repository will live on a Forgejo instance. CI (Forgejo Actions) is **not**
set up for now: builds and the packaging smoke test run locally (see
`docs/release-runbook.md`). This page covers only the remote and, optionally,
publishing `.deb` files to Forgejo's Debian package registry by hand.

Placeholders: `<forgejo-host>` (e.g. `forgejo.example.org`), `<owner>` (user or
organisation), repo name `amaya-browser`.

## 1. Create the repository and push

1. In the Forgejo web UI: **New repository** → owner `<owner>`, name
   `amaya-browser`, *empty* (no README/licence/.gitignore, since we already have them).
2. Add your SSH key under **Settings → SSH / GPG keys** if you haven't.
3. From the main checkout:

```sh
cd "/home/arghya/Documents/Amaya Browser"
git remote add origin ssh://git@<forgejo-host>/<owner>/amaya-browser.git
#   (non-standard SSH port: ssh://git@<forgejo-host>:2222/<owner>/amaya-browser.git)
git push -u origin --all     # every branch: main, feat/*, …
git push origin --tags       # release tags v159.0-1, …
```

Check: `git remote -v` and `git ls-remote --heads origin`.

Notes:

* `engine/`, `dist/`, `.cache/` and `obj-*` are git-ignored and must never be
  pushed (the engine is a ~4 GB upstream tree that `tools/amaya fetch` downloads).
* Once the remote exists, `packaging/debian/build-deb.sh` derives the package
  `Homepage` and AppStream homepage URL from `origin`
  (`https://<forgejo-host>/<owner>/amaya-browser`). Set `AMAYA_HOMEPAGE` to override.
* Recommended in **Settings → Branches**: protect `main` (no force-push, no
  deletion). Work happens on `feat/*`, `fix/*` and `rebase/fx-*` branches.

## 2. (Optional) Publish a .deb to Forgejo's Debian registry

Every Forgejo user/org has a built-in, Forgejo-signed apt repository at
`https://<forgejo-host>/api/packages/<owner>/debian`.

1. Create a token: **Settings → Applications → Generate new token**, scope
   **package: Read and write**.
2. Upload (the helper wraps the same `curl` call and handles 409 conflicts):

```sh
FORGEJO_URL=https://<forgejo-host> FORGEJO_OWNER=<owner> \
FORGEJO_USER=<your-user> FORGEJO_TOKEN=<token> \
packaging/debian/apt-repo/publish-forgejo.sh dist/amaya_159.0-1_amd64.deb

# equivalent raw call
curl --user <your-user>:<token> \
  --upload-file dist/amaya_159.0-1_amd64.deb \
  https://<forgejo-host>/api/packages/<owner>/debian/pool/stable/main/upload
```

   `201` = published, `409` = that name/version/arch already exists (bump the
   Debian revision, or rerun the helper with `REPLACE=1`).

3. The package shows up under **<owner> → Packages**. Users install it with:

```sh
sudo install -d -m 0755 /etc/apt/keyrings
sudo curl -fsSL https://<forgejo-host>/api/packages/<owner>/debian/repository.key \
  -o /etc/apt/keyrings/forgejo-<owner>.asc
echo "deb [signed-by=/etc/apt/keyrings/forgejo-<owner>.asc] https://<forgejo-host>/api/packages/<owner>/debian stable main" \
  | sudo tee /etc/apt/sources.list.d/amaya.list
sudo apt update && sudo apt install amaya
```

To attach the `.deb`, `.tar.xz` and `.sha256` files to a release, use the web UI:
**Releases → New release**, pick the tag, drag the files in.

For hosting outside Forgejo, see `packaging/debian/apt-repo/README.md`
(static repository signed with our own key).
