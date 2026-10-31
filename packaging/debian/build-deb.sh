#!/usr/bin/env bash
# Build the Amaya .deb from a staged (already extracted) application directory.
#
# Usage: packaging/debian/build-deb.sh <staged-appdir> <debversion> <outdir>
#
#   <staged-appdir>  directory containing the `amaya` launcher, libxul.so, ...
#                    (the extracted output of `./mach package`)
#   <debversion>     Debian version, e.g. 159.0-1
#   <outdir>         where amaya_<debversion>_<arch>.deb (+ .sha256) are written
#
# Environment overrides:
#   AMAYA_DEB_ARCH          Debian architecture (default: dpkg --print-architecture)
#   AMAYA_DEB_DEPENDS       Use this Depends value verbatim (skips dpkg-shlibdeps)
#   AMAYA_DEB_NO_SHLIBDEPS  =1 to skip dpkg-shlibdeps and use the built-in list
#   AMAYA_DEB_COMPRESSION   dpkg-deb -Z value (default: xz)
#   AMAYA_BRANDING_DIR      icon source (default: <repo>/branding/linux)
#   DEBFULLNAME, DEBEMAIL   Maintainer (default: git config user.name/email)
#   AMAYA_HOMEPAGE          Homepage URL (default: derived from git remote
#                           "origin", else a placeholder)
#   SOURCE_DATE_EPOCH       timestamp for files/changelog (default: last commit)
#
# Needs: bash, coreutils, findutils, gzip, dpkg-deb. Optional: dpkg-shlibdeps.
# No root required (dpkg-deb --root-owner-group).

set -euo pipefail

PROG=${0##*/}
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

APP_ID=org.amaya.Browser
PKG=amaya
LIBDIR=/usr/lib/amaya

die() { echo "$PROG: error: $*" >&2; exit 1; }
log() { echo "$PROG: $*" >&2; }

usage() {
    sed -n '2,/^$/{s/^# \{0,1\}//;p}' "${BASH_SOURCE[0]}" >&2
    exit 2
}

[ $# -eq 3 ] || usage
APPDIR=$1
DEBVERSION=$2
OUTDIR=$3

[ -d "$APPDIR" ] || die "staged app dir not found: $APPDIR"
APPDIR=$(cd "$APPDIR" && pwd)
[ -x "$APPDIR/amaya" ] || die "$APPDIR/amaya is missing or not executable"
[[ $DEBVERSION =~ ^[0-9][A-Za-z0-9.+~]*-[A-Za-z0-9.+~]+$ ]] \
    || die "invalid Debian version '$DEBVERSION' (expected e.g. 159.0-1)"
UPSTREAM_VERSION=${DEBVERSION%-*}

ARCH=${AMAYA_DEB_ARCH:-}
if [ -z "$ARCH" ]; then
    ARCH=$(dpkg --print-architecture 2>/dev/null) \
        || die "dpkg --print-architecture failed; set AMAYA_DEB_ARCH"
fi

command -v dpkg-deb >/dev/null || die "dpkg-deb not found (apt install dpkg)"

mkdir -p "$OUTDIR"
OUTDIR=$(cd "$OUTDIR" && pwd)
DEB_NAME="${PKG}_${DEBVERSION}_${ARCH}.deb"

# --- reproducibility --------------------------------------------------------
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
    SOURCE_DATE_EPOCH=$(git -C "$REPO_ROOT" log -1 --format=%ct 2>/dev/null || date +%s)
fi
export SOURCE_DATE_EPOCH
export LC_ALL=C.UTF-8 TZ=UTC
umask 022

# --- maintainer -------------------------------------------------------------
maint_name=${DEBFULLNAME:-$(git -C "$REPO_ROOT" config user.name 2>/dev/null || true)}
maint_email=${DEBEMAIL:-$(git -C "$REPO_ROOT" config user.email 2>/dev/null || true)}
MAINTAINER="${maint_name:-Amaya Browser maintainers} <${maint_email:-amaya@localhost}>"

# --- homepage ---------------------------------------------------------------
homepage_from_remote() {
    local url
    url=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null) || return 1
    case $url in
        https://*) url=${url%.git} ;;
        ssh://*@*) url=${url#ssh://*@}; url=https://${url%.git}
                   url=$(printf '%s' "$url" | sed -E 's#^(https://[^/:]+):[0-9]+/#\1/#') ;;
        *@*:*) url=${url#*@}; url=https://${url%%:*}/${url#*:}; url=${url%.git} ;;
        *) return 1 ;;
    esac
    printf '%s' "$url"
}
HOMEPAGE=${AMAYA_HOMEPAGE:-$(homepage_from_remote || true)}
if [ -z "$HOMEPAGE" ]; then
    HOMEPAGE=https://amaya.invalid/
    log "warning: no AMAYA_HOMEPAGE and no git remote; using placeholder $HOMEPAGE"
fi

# --- staging tree -----------------------------------------------------------
# The package root lives at <work>/debian/amaya so dpkg-shlibdeps recognises
# libraries inside it as belonging to the package being built.
WORK=$(mktemp -d "${TMPDIR:-/tmp}/amaya-deb.XXXXXXXX")
trap 'rm -rf "$WORK"' EXIT
ROOT=$WORK/debian/$PKG
mkdir -p "$ROOT/DEBIAN" "$ROOT$LIBDIR" "$ROOT/usr/bin" \
    "$ROOT/usr/share/applications" "$ROOT/usr/share/metainfo" \
    "$ROOT/usr/share/doc/$PKG" "$ROOT/usr/share/man/man1"

log "copying application from $APPDIR"
cp -a "$APPDIR/." "$ROOT$LIBDIR/"

# Normalise permissions: no group/world write, shared objects not executable.
chmod -R u+rwX,go+rX,go-w "$ROOT$LIBDIR"
find "$ROOT$LIBDIR" -type f -name '*.so' -exec chmod 0644 {} +

# Launcher: a tiny wrapper (not a symlink) so the app always runs from its
# real directory regardless of how /usr/bin/amaya is invoked.
cat >"$ROOT/usr/bin/amaya" <<EOF
#!/bin/sh
exec $LIBDIR/amaya "\$@"
EOF
chmod 0755 "$ROOT/usr/bin/amaya"

# Desktop entry, AppStream metadata, man page.
install -m 0644 "$SCRIPT_DIR/$APP_ID.desktop" "$ROOT/usr/share/applications/$APP_ID.desktop"
RELEASE_DATE=$(date -u -d "@$SOURCE_DATE_EPOCH" +%Y-%m-%d)
sed -e "s/@VERSION@/$UPSTREAM_VERSION/g" -e "s/@DATE@/$RELEASE_DATE/g" \
    -e "s|@HOMEPAGE@|$HOMEPAGE|g" \
    -e '/<!-- Template:.*-->/d' \
    "$SCRIPT_DIR/$APP_ID.metainfo.xml.in" >"$ROOT/usr/share/metainfo/$APP_ID.metainfo.xml"
chmod 0644 "$ROOT/usr/share/metainfo/$APP_ID.metainfo.xml"
gzip -9n <"$SCRIPT_DIR/amaya.1" >"$ROOT/usr/share/man/man1/amaya.1.gz"

# --- icons ------------------------------------------------------------------
HICOLOR=$ROOT/usr/share/icons/hicolor
BRANDING_DIR=${AMAYA_BRANDING_DIR:-$REPO_ROOT/branding/linux}
icons_installed=0
if [ -d "$BRANDING_DIR/hicolor" ]; then
    log "icons: using branding from $BRANDING_DIR"
    for png in "$BRANDING_DIR"/hicolor/*x*/apps/"$APP_ID".png; do
        [ -f "$png" ] || continue
        size=$(basename "$(dirname "$(dirname "$png")")")
        install -D -m 0644 "$png" "$HICOLOR/$size/apps/$APP_ID.png"
        icons_installed=$((icons_installed + 1))
    done
fi
if [ -f "$BRANDING_DIR/$APP_ID.svg" ]; then
    install -D -m 0644 "$BRANDING_DIR/$APP_ID.svg" "$HICOLOR/scalable/apps/$APP_ID.svg"
    icons_installed=$((icons_installed + 1))
fi
if [ -f "$BRANDING_DIR/$APP_ID-symbolic.svg" ]; then
    install -D -m 0644 "$BRANDING_DIR/$APP_ID-symbolic.svg" \
        "$HICOLOR/symbolic/apps/$APP_ID-symbolic.svg"
fi
if [ "$icons_installed" -eq 0 ]; then
    log "icons: branding not found, falling back to the app's default*.png"
    for png in "$APPDIR"/browser/chrome/icons/default/default*.png; do
        [ -f "$png" ] || continue
        n=$(basename "$png" .png)
        n=${n#default}
        [[ $n =~ ^[0-9]+$ ]] || continue
        install -D -m 0644 "$png" "$HICOLOR/${n}x${n}/apps/$APP_ID.png"
        icons_installed=$((icons_installed + 1))
    done
fi
[ "$icons_installed" -gt 0 ] || log "warning: no icons installed"

# --- docs -------------------------------------------------------------------
install -m 0644 "$SCRIPT_DIR/copyright" "$ROOT/usr/share/doc/$PKG/copyright"
CHANGELOG_DATE=$(date -u -R -d "@$SOURCE_DATE_EPOCH")
{
    echo "$PKG ($DEBVERSION) unstable; urgency=medium"
    echo
    echo "  * Amaya build of Firefox $UPSTREAM_VERSION."
    echo
    echo " -- $MAINTAINER  $CHANGELOG_DATE"
} | gzip -9n >"$ROOT/usr/share/doc/$PKG/changelog.Debian.gz"

# --- dependencies -----------------------------------------------------------
FALLBACK_DEPENDS="libc6 (>= 2.28), libgcc-s1, libstdc++6, \
libasound2t64 | libasound2, libatk1.0-0t64 | libatk1.0-0, \
libcairo-gobject2, libcairo2, libdbus-1-3, libfontconfig1, libfreetype6, \
libgdk-pixbuf-2.0-0, libglib2.0-0t64 | libglib2.0-0, libgtk-3-0t64 | libgtk-3-0, \
libpango-1.0-0, libpangocairo-1.0-0, libx11-6, libx11-xcb1, libxcb-shm0, libxcb1, \
libxcomposite1, libxcursor1, libxdamage1, libxext6, libxfixes3, libxi6, \
libxrandr2, libxrender1, libxtst6, fontconfig"
RECOMMENDS="libavcodec61 | libavcodec60 | libavcodec59 | libavcodec-extra, \
libpulse0 | pipewire-pulse, xdg-utils"

is_elf() { [ "$(head -c 4 "$1" 2>/dev/null | od -An -c | tr -d ' \n')" = '177ELF' ]; }

compute_shlibdeps() {
    command -v dpkg-shlibdeps >/dev/null 2>&1 || return 1
    local elfs=() f
    while IFS= read -r -d '' f; do
        is_elf "$f" && elfs+=("$f")
    done < <(find "$ROOT$LIBDIR" -type f -print0 | sort -z)
    [ "${#elfs[@]}" -gt 0 ] || { log "no ELF files in payload"; return 1; }
    printf 'Source: %s\n\nPackage: %s\nArchitecture: any\n' "$PKG" "$PKG" \
        >"$WORK/debian/control"
    local out
    out=$(cd "$WORK" && dpkg-shlibdeps -O --ignore-missing-info \
        -l"$ROOT$LIBDIR" "${elfs[@]}" 2>"$WORK/shlibdeps.log") \
        || { sed 's/^/  dpkg-shlibdeps: /' "$WORK/shlibdeps.log" >&2; return 1; }
    out=$(printf '%s\n' "$out" | sed -n 's/^shlibs:Depends=//p')
    [ -n "$out" ] || return 1
    printf '%s' "$out"
}

if [ -n "${AMAYA_DEB_DEPENDS:-}" ]; then
    DEPENDS=$AMAYA_DEB_DEPENDS
elif [ "${AMAYA_DEB_NO_SHLIBDEPS:-0}" != 1 ] && DEPENDS=$(compute_shlibdeps); then
    log "Depends computed by dpkg-shlibdeps"
    DEPENDS="$DEPENDS, fontconfig"
else
    log "Depends: using built-in fallback list"
    DEPENDS=$FALLBACK_DEPENDS
fi
DEPENDS=$(printf '%s' "$DEPENDS" | tr -s ' ')
rm -f "$WORK/debian/control"

# --- DEBIAN/ ----------------------------------------------------------------
install -m 0755 "$SCRIPT_DIR/postinst" "$ROOT/DEBIAN/postinst"
install -m 0755 "$SCRIPT_DIR/prerm" "$ROOT/DEBIAN/prerm"

INSTALLED_SIZE=$(du -sk --apparent-size --exclude=DEBIAN "$ROOT" | cut -f1)
control=$(<"$SCRIPT_DIR/control.in")
control=${control//@VERSION@/"$DEBVERSION"}
control=${control//@ARCH@/"$ARCH"}
control=${control//@HOMEPAGE@/"$HOMEPAGE"}
control=${control//@MAINTAINER@/"$MAINTAINER"}
control=${control//@INSTALLED_SIZE@/"$INSTALLED_SIZE"}
control=${control//@DEPENDS@/"$DEPENDS"}
control=${control//@RECOMMENDS@/"$RECOMMENDS"}
printf '%s\n' "$control" >"$ROOT/DEBIAN/control"

(cd "$ROOT" && find . -path ./DEBIAN -prune -o -type f -printf '%P\0' \
    | sort -z | xargs -0 -r md5sum) >"$ROOT/DEBIAN/md5sums"
chmod 0644 "$ROOT/DEBIAN/control" "$ROOT/DEBIAN/md5sums"

find "$ROOT" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# --- build ------------------------------------------------------------------
log "building $OUTDIR/$DEB_NAME"
dpkg-deb --root-owner-group -Z"${AMAYA_DEB_COMPRESSION:-xz}" \
    --build "$ROOT" "$OUTDIR/$DEB_NAME" >&2
(cd "$OUTDIR" && sha256sum "$DEB_NAME" >"$DEB_NAME.sha256")

log "done: $OUTDIR/$DEB_NAME"
echo "$OUTDIR/$DEB_NAME"
