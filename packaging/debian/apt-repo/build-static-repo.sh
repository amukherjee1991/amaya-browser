#!/usr/bin/env bash
# Build (or update) a signed static apt repository that any web server can
# host (Forgejo Pages, nginx, S3, ...). Alternative to Forgejo's registry.
#
# Usage: packaging/debian/apt-repo/build-static-repo.sh <repo-dir> <file.deb>...
#
# Environment:
#   GPG_KEY_ID        key used to sign Release (required; must be in the keyring)
#   APT_DISTRIBUTION  default: stable
#   APT_COMPONENT     default: main
#   GNUPGHOME         as usual for gpg
#
# Result:
#   <repo-dir>/pool/<component>/a/amaya/*.deb
#   <repo-dir>/dists/<dist>/<component>/binary-<arch>/Packages{,.gz,.xz}
#   <repo-dir>/dists/<dist>/{Release,Release.gpg,InRelease}
#   <repo-dir>/amaya-archive-keyring.asc   (public key for clients)
#
# Needs: apt-utils (apt-ftparchive), gpg, gzip, xz-utils, dpkg-deb.

set -euo pipefail

die() { echo "${0##*/}: error: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: ${0##*/} <repo-dir> <file.deb>..."
: "${GPG_KEY_ID:?set GPG_KEY_ID to the signing key}"
command -v apt-ftparchive >/dev/null || die "apt-ftparchive not found (apt install apt-utils)"
command -v gpg >/dev/null || die "gpg not found"

repo=$1; shift
dist=${APT_DISTRIBUTION:-stable}
comp=${APT_COMPONENT:-main}
mkdir -p "$repo"
repo=$(cd "$repo" && pwd)

for deb in "$@"; do
    [ -f "$deb" ] || die "not a file: $deb"
    name=$(dpkg-deb -f "$deb" Package)
    dest="$repo/pool/$comp/${name:0:1}/$name"
    mkdir -p "$dest"
    cp -f "$deb" "$dest/"
done

cd "$repo"
archs=$(find "pool/$comp" -name '*.deb' -exec dpkg-deb -f {} Architecture \; | sort -u)
[ -n "$archs" ] || die "no packages in pool/$comp"
for arch in $archs; do
    d="dists/$dist/$comp/binary-$arch"
    mkdir -p "$d"
    apt-ftparchive --arch "$arch" packages "pool/$comp" >"$d/Packages"
    gzip -9nkf "$d/Packages"
    xz -kf "$d/Packages"
done

arch_list=${archs//$'\n'/ }   # "amd64 arm64"

# Write outside dists/ so the file is not listed in its own index.
tmp_release=$(mktemp)
rm -f "dists/$dist/Release" "dists/$dist/InRelease" "dists/$dist/Release.gpg"
apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=Amaya \
    -o APT::FTPArchive::Release::Label=Amaya \
    -o APT::FTPArchive::Release::Suite="$dist" \
    -o APT::FTPArchive::Release::Codename="$dist" \
    -o APT::FTPArchive::Release::Components="$comp" \
    -o APT::FTPArchive::Release::Architectures="$arch_list" \
    release "dists/$dist" >"$tmp_release"
mv "$tmp_release" "dists/$dist/Release"
chmod 0644 "dists/$dist/Release"

gpg --batch --yes --local-user "$GPG_KEY_ID" --clearsign \
    -o "dists/$dist/InRelease" "dists/$dist/Release"
gpg --batch --yes --local-user "$GPG_KEY_ID" --armor --detach-sign \
    -o "dists/$dist/Release.gpg" "dists/$dist/Release"
gpg --batch --yes --armor --export "$GPG_KEY_ID" >amaya-archive-keyring.asc

echo "repository ready in $repo (dist=$dist component=$comp archs: $arch_list)"
