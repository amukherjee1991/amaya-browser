#!/usr/bin/env bash
# Upload .deb files to Forgejo's built-in Debian package registry.
#
# Usage: packaging/debian/apt-repo/publish-forgejo.sh <file.deb>...
#
# Environment:
#   FORGEJO_URL     e.g. https://forgejo.example.org   (required)
#   FORGEJO_OWNER   user or org that owns the registry (required)
#   FORGEJO_USER    account the token belongs to       (default: FORGEJO_OWNER)
#   FORGEJO_TOKEN   personal access token, scope write:package (required)
#   APT_DISTRIBUTION  default: stable
#   APT_COMPONENT     default: main
#   REPLACE=1       delete an existing identical name/version/arch first
#                   (the registry answers 409 Conflict otherwise)
#
# The registry signs its own Release/InRelease files; clients fetch the key
# from $FORGEJO_URL/api/packages/$FORGEJO_OWNER/debian/repository.key.

set -euo pipefail

die() { echo "${0##*/}: error: $*" >&2; exit 1; }

[ $# -ge 1 ] || die "usage: ${0##*/} <file.deb>..."
: "${FORGEJO_URL:?set FORGEJO_URL}"
: "${FORGEJO_OWNER:?set FORGEJO_OWNER}"
: "${FORGEJO_TOKEN:?set FORGEJO_TOKEN}"
user=${FORGEJO_USER:-$FORGEJO_OWNER}
dist=${APT_DISTRIBUTION:-stable}
comp=${APT_COMPONENT:-main}
base="${FORGEJO_URL%/}/api/packages/$FORGEJO_OWNER/debian/pool/$dist/$comp"

# Keep the token out of the process list: pass credentials via a netrc file.
netrc=$(mktemp)
trap 'rm -f "$netrc"' EXIT
host=${FORGEJO_URL#*://}
host=${host%%/*}
host=${host%%:*}
printf 'machine %s login %s password %s\n' "$host" "$user" "$FORGEJO_TOKEN" >"$netrc"

upload() {
    curl --silent --show-error --netrc-file "$netrc" --output /dev/stderr \
        --write-out '%{http_code}' --upload-file "$1" "$base/upload"
}

for deb in "$@"; do
    [ -f "$deb" ] || die "not a file: $deb"
    name=$(dpkg-deb -f "$deb" Package)
    version=$(dpkg-deb -f "$deb" Version)
    arch=$(dpkg-deb -f "$deb" Architecture)
    echo "uploading $name $version ($arch) to $base" >&2
    code=$(upload "$deb")
    if [ "$code" = 409 ] && [ "${REPLACE:-0}" = 1 ]; then
        echo "  exists; deleting and re-uploading (REPLACE=1)" >&2
        curl --silent --show-error --fail --netrc-file "$netrc" -X DELETE \
            "$base/$name/$version/$arch"
        code=$(upload "$deb")
    fi
    case $code in
        201) echo "  published" >&2 ;;
        409) die "$name $version ($arch) already exists in $dist/$comp (set REPLACE=1 to overwrite)" ;;
        *) die "upload failed with HTTP $code" ;;
    esac
done
