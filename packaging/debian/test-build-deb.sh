#!/usr/bin/env bash
# Smoke test for packaging/debian/build-deb.sh using a fake staged app dir.
# No Firefox build needed; run it locally after touching packaging/debian/.
#
# Usage: packaging/debian/test-build-deb.sh [--keep]
#   --keep   keep the temp dir (prints its path) for manual inspection
#
# Uses, when installed: desktop-file-validate, appstreamcli, lintian.
# Set AMAYA_TEST_STRICT_TOOLS=1 to fail if any of those is missing.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BUILD_DEB=$SCRIPT_DIR/build-deb.sh
VERSION=159.0-1
APP_ID=org.amaya.Browser

KEEP=0
[ "${1:-}" = --keep ] && KEEP=1

# The path deliberately contains spaces: the real staging dir lives under
# "/home/.../Amaya Browser/dist/stage/...".
TMP=$(mktemp -d "${TMPDIR:-/tmp}/amaya deb test.XXXXXXXX")
if [ "$KEEP" = 1 ]; then
    echo "keeping $TMP"
else
    trap 'rm -rf "$TMP"' EXIT
fi

fails=0
pass() { echo "  ok   $*"; }
fail() { echo "  FAIL $*"; fails=$((fails + 1)); }
check() { local desc=$1; shift; if "$@" >/dev/null 2>&1; then pass "$desc"; else fail "$desc"; fi; }
missing_tool() {
    echo "  skip $1 not installed"
    if [ "${AMAYA_TEST_STRICT_TOOLS:-0}" = 1 ]; then fails=$((fails + 1)); fi
}

# Write a valid RGBA PNG of the given size (so lintian's icon-size checks pass).
make_png() {
    python3 - "$1" "$2" <<'PY'
import struct, sys, zlib
path, n = sys.argv[1], int(sys.argv[2])
row = b"\x00" + b"\x2b\x6c\xb0\xff" * n
def chunk(t, d):
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
data = (b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(row * n, 9))
        + chunk(b"IEND", b""))
open(path, "wb").write(data)
PY
}

# --- fake staged app dir ----------------------------------------------------
APP="$TMP/Amaya Browser/dist/stage/amaya"
mkdir -p "$APP/browser/chrome/icons/default" "$APP/distribution" "$APP/defaults/pref"
cat >"$APP/amaya" <<'EOF'
#!/bin/sh
echo "fake amaya $*"
EOF
chmod 0755 "$APP/amaya"
# A real ELF so the dpkg-shlibdeps path is exercised.
cp "$(type -P true)" "$APP/amaya-bin"
printf 'not really a shared object\n' >"$APP/libxul.so"
chmod 0755 "$APP/libxul.so"   # build-deb.sh must reset this to 0644
echo '{"policies": {"DisableTelemetry": true}}' >"$APP/distribution/policies.json"
printf '// fake autoconfig\n' >"$APP/amaya.cfg"
printf 'pref("general.config.filename", "amaya.cfg");\n' >"$APP/defaults/pref/autoconfig.js"
for n in 16 32 48 64 128; do
    make_png "$APP/browser/chrome/icons/default/default$n.png" "$n"
done

# --- fake branding dir ------------------------------------------------------
BRAND="$TMP/Amaya Browser/branding/linux"
for n in 16 24 32 48 64 128 256 512; do
    mkdir -p "$BRAND/hicolor/${n}x${n}/apps"
    make_png "$BRAND/hicolor/${n}x${n}/apps/$APP_ID.png" "$n"
done
svg='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>'
echo "$svg" >"$BRAND/$APP_ID.svg"
echo "$svg" >"$BRAND/$APP_ID-symbolic.svg"

export DEBFULLNAME="Amaya CI" DEBEMAIL="ci@amaya.invalid"
export AMAYA_HOMEPAGE=${AMAYA_HOMEPAGE:-https://amaya.invalid/}
# build-deb.sh's own work dir then also has a space in it.
mkdir -p "$TMP/build tmp"
export TMPDIR="$TMP/build tmp"

inspect_deb() {
    local deb=$1 label=$2
    local x=$TMP/x-$label
    echo "== inspecting $label: $(basename "$deb")"
    check "deb exists" test -f "$deb"
    check "sha256 verifies" bash -c "cd '$(dirname "$deb")' && sha256sum -c '$(basename "$deb").sha256'"
    local f
    f=$(dpkg-deb -f "$deb" Package Version Architecture Provides)
    check "Package: amaya" grep -qx 'Package: amaya' <<<"$f"
    check "Version: $VERSION" grep -qx "Version: $VERSION" <<<"$f"
    check "Architecture matches file name" grep -qx "Architecture: $(dpkg --print-architecture)" <<<"$f"
    check "Provides www-browser" grep -q 'gnome-www-browser, www-browser' <<<"$f"
    check "Depends non-empty" test -n "$(dpkg-deb -f "$deb" Depends)"
    check "Maintainer from DEBFULLNAME/DEBEMAIL" \
        grep -qx 'Amaya CI <ci@amaya.invalid>' <<<"$(dpkg-deb -f "$deb" Maintainer)"

    local contents
    contents=$(dpkg-deb -c "$deb")
    for p in ./usr/bin/amaya ./usr/lib/amaya/amaya ./usr/lib/amaya/amaya-bin \
        ./usr/lib/amaya/libxul.so ./usr/lib/amaya/distribution/policies.json \
        ./usr/lib/amaya/amaya.cfg \
        "./usr/share/applications/$APP_ID.desktop" \
        "./usr/share/metainfo/$APP_ID.metainfo.xml" \
        ./usr/share/doc/amaya/copyright ./usr/share/doc/amaya/changelog.Debian.gz \
        ./usr/share/man/man1/amaya.1.gz \
        "./usr/share/icons/hicolor/48x48/apps/$APP_ID.png"; do
        check "contains $p" grep -q " $p\$" <<<"$contents"
    done
    check "owned by root/root" bash -c "! grep -v ' root/root ' <<<\"\$1\"" _ "$contents"
    check "libxul.so is 0644" grep -q -- '-rw-r--r-- .* ./usr/lib/amaya/libxul.so$' <<<"$contents"
    check "/usr/bin/amaya is 0755" grep -q -- '-rwxr-xr-x .* ./usr/bin/amaya$' <<<"$contents"

    mkdir -p "$x" && dpkg-deb -R "$deb" "$x"
    check "launcher execs /usr/lib/amaya/amaya" grep -q 'exec /usr/lib/amaya/amaya "\$@"' "$x/usr/bin/amaya"
    check "postinst syntax" sh -n "$x/DEBIAN/postinst"
    check "prerm syntax" sh -n "$x/DEBIAN/prerm"
    check "postinst is executable" test -x "$x/DEBIAN/postinst"
    check "postinst registers x-www-browser" grep -q 'x-www-browser /usr/bin/amaya 40' "$x/DEBIAN/postinst"
    check "changelog mentions version" bash -c "gzip -dc '$x/usr/share/doc/amaya/changelog.Debian.gz' | grep -q '($VERSION)'"
    check "metainfo has release 159.0" grep -q 'release version="159.0"' "$x/usr/share/metainfo/$APP_ID.metainfo.xml"
    check "md5sums verify" bash -c "cd '$x' && md5sum --quiet -c DEBIAN/md5sums"

    if command -v desktop-file-validate >/dev/null; then
        check "desktop-file-validate" desktop-file-validate "$x/usr/share/applications/$APP_ID.desktop"
    else missing_tool desktop-file-validate; fi
    if command -v appstreamcli >/dev/null; then
        if appstreamcli validate --no-net --explain "$x/usr/share/metainfo/$APP_ID.metainfo.xml" >"$TMP/as.log" 2>&1; then
            pass "appstreamcli validate"
        else
            fail "appstreamcli validate"; sed 's/^/       /' "$TMP/as.log"
        fi
    else missing_tool appstreamcli; fi
    if command -v lintian >/dev/null; then
        # Errors fail the test; warnings are printed for review (the fake
        # payload triggers some that cannot occur with a real build).
        # initial-upload-closes-no-bugs only matters for uploads to Debian.
        # AMAYA_LINTIAN_ARGS (e.g. "-I --pedantic") adds extra lintian flags.
        local -a extra
        read -r -a extra <<<"${AMAYA_LINTIAN_ARGS:-}"
        if lintian --fail-on error --tag-display-limit 0 "${extra[@]}" \
            --suppress-tags initial-upload-closes-no-bugs \
            "$deb" >"$TMP/lintian.log" 2>&1; then
            pass "lintian (no errors)"
        else
            fail "lintian reported errors"
        fi
        sed 's/^/       /' "$TMP/lintian.log"
    else missing_tool lintian; fi
}

echo "== build 1: icon fallback from the app's default*.png"
out1=$TMP/out1
AMAYA_BRANDING_DIR=$TMP/no-branding "$BUILD_DEB" "$APP" "$VERSION" "$out1" >/dev/null
arch=$(dpkg --print-architecture)
inspect_deb "$out1/amaya_${VERSION}_${arch}.deb" fallback
check "fallback installs 128x128 icon" bash -c \
    "dpkg-deb -c '$out1/amaya_${VERSION}_${arch}.deb' | grep -q 'hicolor/128x128/apps/$APP_ID.png'"

echo "== build 2: icons from branding dir"
out2=$TMP/out2
AMAYA_BRANDING_DIR=$BRAND "$BUILD_DEB" "$APP" "$VERSION" "$out2" >/dev/null
inspect_deb "$out2/amaya_${VERSION}_${arch}.deb" branding
c2=$(dpkg-deb -c "$out2/amaya_${VERSION}_${arch}.deb")
check "branding installs 512x512 icon" grep -q "hicolor/512x512/apps/$APP_ID.png" <<<"$c2"
check "branding installs scalable svg" grep -q "hicolor/scalable/apps/$APP_ID.svg" <<<"$c2"
check "branding installs symbolic svg" grep -q "hicolor/symbolic/apps/$APP_ID-symbolic.svg" <<<"$c2"

echo "== build 3: arch override + fallback Depends"
out3=$TMP/out3
AMAYA_DEB_ARCH=arm64 AMAYA_DEB_NO_SHLIBDEPS=1 AMAYA_BRANDING_DIR=$BRAND \
    "$BUILD_DEB" "$APP" "$VERSION" "$out3" >/dev/null
check "arm64 file name" test -f "$out3/amaya_${VERSION}_arm64.deb"
check "fallback Depends has libgtk-3" bash -c \
    "dpkg-deb -f '$out3/amaya_${VERSION}_arm64.deb' Depends | grep -q 'libgtk-3-0t64 | libgtk-3-0'"

echo "== build 4: bad input is rejected"
check "rejects version without revision" bash -c "! '$BUILD_DEB' '$APP' 159.0 '$TMP/out4' 2>/dev/null"
check "rejects missing app dir" bash -c "! '$BUILD_DEB' '$TMP/nope' '$VERSION' '$TMP/out4' 2>/dev/null"

echo
if [ "$fails" -eq 0 ]; then
    echo "test-build-deb: all checks passed"
else
    echo "test-build-deb: $fails check(s) failed"
    exit 1
fi
