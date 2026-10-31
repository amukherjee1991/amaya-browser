#!/usr/bin/env python3
"""Regenerate every raster / .ico / .icns / .bmp / .jpg in branding/ from the
SVG masters in branding/source/.

    python3 branding/tools/generate.py           # regenerate everything
    python3 branding/tools/generate.py --check   # fail if anything is stale

Idempotent: the same masters always produce byte-identical outputs (given the
same resvg and Pillow versions; both are pinned/recorded in the README).

Requirements:
  * node >= 18 (rasterising is done by @resvg/resvg-js, see rasterize.mjs).
    resvg is installed on first use into a cache directory outside the
    repository ($AMAYA_BRANDING_CACHE, default ~/.cache/amaya-branding), or
    point $AMAYA_RESVG_NODE_PATH at a directory that already has it.
  * python3 with Pillow (decoding PNGs, writing BMP/JPEG). ICO and ICNS
    containers are written by this script with the standard library.

Hand-written files (configure.sh, moz.build, jar.mn, brand.ftl, prefs, CSS,
NSIS, manifests) and the macOS dsstore (tools/make_dsstore.py) are not
touched by this script.
"""

import argparse
import io
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

from PIL import Image

RESVG_VERSION = "2.6.2"

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)  # branding/
SRC = os.path.join(ROOT, "source")
BRAND = os.path.join(ROOT, "amaya")
LINUX = os.path.join(ROOT, "linux")
MACOS = os.path.join(ROOT, "macos")

APP_ID = "org.amaya.Browser"

# Palette (keep in sync with README.md)
TILE_TOP = "#1C4350"  # app-tile gradient, top-left
TILE_BOTTOM = "#0E2630"  # app-tile gradient, bottom-right
INK = "#10242E"
MIST = "#F2F6F5"
TEAL = "#0E7C70"
TEAL_ON_DARK = "#5FE0CC"


def read(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


MARK = read("amaya-mark.svg")  # bare gradient stroke, >= 32 px
MARK_SMALL = read("amaya-mark-small.svg")  # flat teal, thicker, < 32 px
APP = read("amaya-app-icon.svg")  # tile + gradient stroke, > 32 px
APP_SMALL = read("amaya-app-icon-small.svg")  # tile + flat stroke, <= 32 px
APP_PRIVATE = read("amaya-app-icon-private.svg")
APP_PRIVATE_SMALL = read("amaya-app-icon-private-small.svg")
SYMBOLIC = read("amaya-symbolic.svg")
WORDMARK = read("amaya-wordmark.svg")
DOCUMENT = read("document.svg")
DOCUMENT_PDF = read("document_pdf.svg")
NEWTAB = read("newtab.svg")
NEWWINDOW = read("newwindow.svg")

WORDMARK_PATH = re.search(r'<path fill="[^"]+" d="([^"]+)"', WORDMARK).group(1)
WORDMARK_VIEWBOX = re.search(r'viewBox="([^"]+)"', WORDMARK).group(1)
_vb = [float(v) for v in WORDMARK_VIEWBOX.split()]
WORDMARK_RATIO = _vb[3] / _vb[2]  # height / width


def mark(size):
    """Bare mark master for a render of `size` px (flat teal below 32 px)."""
    return MARK_SMALL if size < 32 else MARK


def app(size, private=False):
    """App-icon (tile) master for a render of `size` px."""
    if private:
        return APP_PRIVATE_SMALL if size <= 32 else APP_PRIVATE
    return APP_SMALL if size <= 32 else APP


# --------------------------------------------------------------------------
# SVG composition helpers
# --------------------------------------------------------------------------


def place(svg, x, y, w, h):
    """Embed a master SVG document as a nested <svg> at (x, y, w, h)."""
    svg = re.sub(r"<!--.*?-->", "", svg, flags=re.S)
    m = re.search(r"<svg\b([^>]*)>", svg)
    attrs = re.sub(r'\s(width|height|x|y)="[^"]*"', "", m.group(1))
    attrs = re.sub(r'\sxmlns="[^"]*"', "", attrs)
    body = svg[m.end() : svg.rindex("</svg>")]
    return f'<svg x="{x}" y="{y}" width="{w}" height="{h}"{attrs}>{body}</svg>'


def wordmark(x, y, w, fill):
    h = w * WORDMARK_RATIO
    return (
        f'<svg x="{x}" y="{y}" width="{w}" height="{h:.2f}" viewBox="{WORDMARK_VIEWBOX}">'
        f'<path fill="{fill}" d="{WORDMARK_PATH}"/></svg>'
    )


def doc(w, h, *parts, defs=""):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'viewBox="0 0 {w} {h}"><defs>{defs}</defs>{"".join(parts)}</svg>'
    )


def night_bg(w, h, gid="night"):
    """Dark teal-navy backdrop (same gradient as the app tile)."""
    defs = (
        f'<linearGradient id="{gid}" x1="0" y1="0" x2="1" y2="1">'
        f'<stop offset="0" stop-color="{TILE_TOP}"/>'
        f'<stop offset="1" stop-color="{TILE_BOTTOM}"/></linearGradient>'
    )
    return defs, f'<rect width="{w}" height="{h}" fill="url(#{gid})"/>'


def centered(svg, canvas, size, dy=0):
    off = (canvas - size) / 2
    return place(svg, off, off + dy, size, size)


def mac_tile(size, private=False):
    """macOS app icon: the app tile on Apple's grid (824/1024 tile, 100 px
    margins). The tile masters draw the tile at 8..248 of 256."""
    s = size / 1024
    box = 824 * 256 / 240 * s
    off = 100 * s - 8 * box / 256
    return doc(size, size, place(app(size, private), f"{off:.3f}", f"{off:.3f}", f"{box:.3f}", f"{box:.3f}"))


def full(svg, size):
    return doc(size, size, place(svg, 0, 0, size, size))


# --------------------------------------------------------------------------
# Rendering
# --------------------------------------------------------------------------


def resvg_node_path():
    path = os.environ.get("AMAYA_RESVG_NODE_PATH")
    if path:
        return path
    cache = os.environ.get(
        "AMAYA_BRANDING_CACHE", os.path.expanduser("~/.cache/amaya-branding")
    )
    path = os.path.join(cache, f"resvg-{RESVG_VERSION}")
    if not os.path.isdir(os.path.join(path, "node_modules", "@resvg", "resvg-js")):
        os.makedirs(path, exist_ok=True)
        with open(os.path.join(path, "package.json"), "w") as f:
            f.write('{"name": "amaya-branding-cache", "private": true}\n')
        subprocess.run(
            ["npm", "install", "--no-audit", "--no-fund", "--silent",
             f"@resvg/resvg-js@{RESVG_VERSION}"],
            cwd=path,
            check=True,
        )
    return path


def render_all(jobs, tmp):
    """jobs: {key: (svg, w, h)} -> {key: PNG bytes}"""
    payload = []
    for i, (key, (svg, w, h)) in enumerate(sorted(jobs.items())):
        payload.append({"svg": svg, "width": w, "height": h, "out": os.path.join(tmp, f"{i}.png"), "key": key})
    jobfile = os.path.join(tmp, "jobs.json")
    with open(jobfile, "w") as f:
        json.dump(payload, f)
    env = dict(os.environ, AMAYA_RESVG_NODE_PATH=resvg_node_path())
    subprocess.run(["node", os.path.join(TOOLS, "rasterize.mjs"), jobfile], check=True, env=env)
    out = {}
    for job in payload:
        with open(job["out"], "rb") as f:
            out[job["key"]] = f.read()
    return out


# --------------------------------------------------------------------------
# Container writers
# --------------------------------------------------------------------------


def ico(pngs):
    """Write a Windows .ico. Entries < 256 px are stored as 32-bit BMP/DIB
    (maximum compatibility: NSIS, rc.exe, old shells); 256 px as PNG."""
    entries = []
    for png in pngs:
        im = Image.open(io.BytesIO(png)).convert("RGBA")
        w, h = im.size
        if w >= 256:
            data = png
        else:
            px = im.tobytes("raw", "BGRA")
            rows = [px[y * w * 4 : (y + 1) * w * 4] for y in range(h)]
            xor = b"".join(reversed(rows))
            mask_stride = ((w + 31) // 32) * 4
            andmask = b"\0" * (mask_stride * h)
            header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, len(xor) + len(andmask), 0, 0, 0, 0)
            data = header + xor + andmask
        entries.append((w, h, data))
    out = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    blobs = b""
    for w, h, data in entries:
        out += struct.pack("<BBBBHHII", w % 256, h % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    return out + blobs


# (OSType, pixel size) -- PNG payloads, supported since OS X 10.7.
ICNS_TYPES = [
    (b"icp4", 16), (b"ic11", 32), (b"icp5", 32), (b"ic12", 64),
    (b"ic07", 128), (b"ic13", 256), (b"ic08", 256), (b"ic14", 512),
    (b"ic09", 512), (b"ic10", 1024),
]


def icns(png_by_size):
    body = b""
    for ostype, size in ICNS_TYPES:
        data = png_by_size[size]
        body += ostype + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def to_bmp(png):
    im = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "BMP")
    return buf.getvalue()


def to_jpg(png):
    im = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90, optimize=True)
    return buf.getvalue()


# --------------------------------------------------------------------------
# What to build
# --------------------------------------------------------------------------


def build_jobs():
    j = {}

    # Bare mark (about dialog, Windows tiles) and app tile at every size used.
    for s in (192, 384):
        j[f"mark{s}"] = (full(mark(s), s), s, s)
    for s in (16, 22, 24, 32, 48, 64, 88, 100, 128, 256, 512):
        j[f"app{s}"] = (full(app(s), s), s, s)
    for s in (16, 32, 48, 192, 256, 384):
        j[f"private{s}"] = (full(app(s, private=True), s), s, s)
    for s in (16, 32, 44, 48, 64, 128, 256, 512, 1024):
        j[f"doc{s}"] = (full(DOCUMENT, s), s, s)
    j["docpdf256"] = (full(DOCUMENT_PDF, 256), 256, 256)
    for s in (16, 32):
        j[f"newtab{s}"] = (full(NEWTAB, s), s, s)
        j[f"newwindow{s}"] = (full(NEWWINDOW, s), s, s)
    for s in (16, 32, 64, 128, 256, 512, 1024):
        j[f"tile{s}"] = (mac_tile(s), s, s)

    # Windows start-menu tiles: bare mark on transparent; the manifests
    # supply the tile colour (#0e2630, private #7d5291).
    def tile(svg, w, h, size, dy=0):
        return (doc(w, h, place(svg, (w - size) / 2, (h - size) / 2 + dy, size, size)), w, h)

    j["ve150"] = tile(MARK, 300, 300, 150, -20)
    j["ve70"] = tile(MARK, 142, 142, 96)
    j["pb150"] = tile(MARK, 300, 300, 150, -20)
    j["pb70"] = tile(MARK, 142, 142, 96)
    j["msix_large"] = tile(MARK, 620, 620, 300, -30)
    j["msix_wide"] = tile(MARK, 620, 300, 160, -20)

    # Legacy about.png (300x236, opaque).
    defs, bg = night_bg(300, 236)
    j["about"] = (doc(300, 236, bg, place(MARK, 100, 26, 100, 100), wordmark(85, 150, 130, MIST), defs=defs), 300, 236)

    # NSIS installer bitmaps.
    defs, bg = night_bg(164, 314)
    j["wizWatermark"] = (
        doc(164, 314, bg, place(MARK, 42, 86, 80, 80), wordmark(37, 190, 90, MIST), defs=defs),
        164, 314,
    )
    white = '<rect width="150" height="57" fill="#FFFFFF"/>'
    j["wizHeader"] = (doc(150, 57, white, place(APP, 99, 6, 45, 45)), 150, 57)
    j["wizHeaderRTL"] = (doc(150, 57, white, place(APP, 6, 6, 45, 45)), 150, 57)

    # Stub installer background (text is drawn on top in white): faint
    # oversized strokes rising from the bottom edge.
    defs, bg = night_bg(1344, 822)
    ghost = SYMBOLIC.replace("#2e3436", "#FFFFFF")
    hills = (
        '<g opacity="0.05">'
        + place(ghost, 960, 420, 520, 520)
        + place(ghost, -120, 560, 340, 340)
        + "</g>"
    )
    j["bgstub"] = (doc(1344, 822, bg, hills, defs=defs), 1344, 822)

    # macOS dmg window background (720x440 pt @2x). Icon positions come from
    # dsstore: app at (209, 190), Applications link at (472, 190).
    defs, bg = night_bg(1440, 880)
    defs += (
        f'<radialGradient id="glow"><stop offset="0" stop-color="{TEAL_ON_DARK}" stop-opacity="0.35"/>'
        f'<stop offset="1" stop-color="{TEAL_ON_DARK}" stop-opacity="0"/></radialGradient>'
    )
    dmg = doc(
        1440, 880, bg,
        '<circle cx="418" cy="380" r="200" fill="url(#glow)"/>',
        f'<rect x="330" y="524" width="176" height="42" rx="21" fill="{MIST}"/>',
        '<path d="M600 380H830M790 340L834 380L790 420" fill="none" stroke="#FFFFFF" '
        'stroke-opacity="0.85" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>',
        f'<g opacity="0.35">{wordmark(580, 720, 280, MIST)}</g>',
        defs=defs,
    )
    j["dmg_background"] = (dmg, 1440, 880)
    return j


def outputs(r):
    """Map output path (relative to branding/) -> bytes."""
    o = {}
    a = "amaya/"
    for s in (16, 22, 24, 32, 48, 64, 128, 256):
        o[f"{a}default{s}.png"] = r[f"app{s}"]

    c = a + "content/"
    o[c + "about-logo.png"] = r["mark192"]
    o[c + "about-logo@2x.png"] = r["mark384"]
    o[c + "about-logo-private.png"] = r["private192"]
    o[c + "about-logo-private@2x.png"] = r["private384"]
    o[c + "about.png"] = to_png_rgb(r["about"])

    o[a + "firefox.ico"] = ico([r["app16"], r["app32"], r["app48"], r["app256"]])
    o[a + "firefox64.ico"] = ico([r["app16"], r["app32"], r["app48"], r["app64"]])
    o[a + "document.ico"] = ico([r["doc16"], r["doc32"], r["doc48"], r["doc256"]])
    o[a + "document_pdf.ico"] = ico([r["docpdf256"]])
    o[a + "pbmode.ico"] = ico([r["private16"], r["private32"], r["private48"], r["private256"]])
    o[a + "newtab.ico"] = ico([r["newtab16"], r["newtab32"]])
    o[a + "newwindow.ico"] = ico([r["newwindow16"], r["newwindow32"]])

    o[a + "firefox.icns"] = icns({s: r[f"tile{s}"] for s in (16, 32, 64, 128, 256, 512, 1024)})
    o[a + "disk.icns"] = o[a + "firefox.icns"]
    o[a + "document.icns"] = icns({s: r[f"doc{s}"] for s in (16, 32, 64, 128, 256, 512, 1024)})

    o[a + "VisualElements_150.png"] = r["ve150"]
    o[a + "VisualElements_70.png"] = r["ve70"]
    o[a + "PrivateBrowsing_150.png"] = r["pb150"]
    o[a + "PrivateBrowsing_70.png"] = r["pb70"]

    m = a + "msix/Assets/"
    o[m + "Document44x44.png"] = r["doc44"]
    o[m + "LargeTile.scale-200.png"] = r["msix_large"]
    o[m + "MedTile.scale-200.png"] = r["ve150"]
    o[m + "SmallTile.scale-200.png"] = r["ve70"]
    o[m + "Square150x150Logo.scale-200.png"] = r["ve150"]
    o[m + "Square44x44Logo.altform-lightunplated_targetsize-256.png"] = r["app256"]
    o[m + "Square44x44Logo.altform-unplated_targetsize-256.png"] = r["app256"]
    o[m + "Square44x44Logo.scale-200.png"] = r["app88"]
    o[m + "Square44x44Logo.targetsize-256.png"] = r["app256"]
    o[m + "StoreLogo.scale-200.png"] = r["app100"]
    o[m + "Wide310x150Logo.scale-200.png"] = r["msix_wide"]

    o[a + "wizHeader.bmp"] = to_bmp(r["wizHeader"])
    o[a + "wizHeaderRTL.bmp"] = to_bmp(r["wizHeaderRTL"])
    o[a + "wizWatermark.bmp"] = to_bmp(r["wizWatermark"])
    o[a + "stubinstaller/bgstub.jpg"] = to_jpg(r["bgstub"])
    o[a + "background.png"] = r["dmg_background"]

    # Vector copies used directly by the browser chrome.
    o[c + "about-logo.svg"] = strip_comments(MARK).encode()
    o[c + "document_pdf.svg"] = strip_comments(DOCUMENT_PDF).encode()
    o[c + "about-wordmark.svg"] = chrome_wordmark('fill="context-fill"').encode()
    o[c + "firefox-wordmark.svg"] = chrome_wordmark(
        f'fill="context-fill light-dark({INK}, {MIST})"',
        style="<style>:root { color-scheme: light dark }</style>",
    ).encode()

    # Linux desktop integration (consumed by packaging/).
    o[f"linux/{APP_ID}.svg"] = strip_comments(APP).encode()
    o[f"linux/{APP_ID}-symbolic.svg"] = strip_comments(SYMBOLIC).encode()
    for s in (16, 22, 24, 32, 48, 64, 128, 256, 512):
        o[f"linux/hicolor/{s}x{s}/apps/{APP_ID}.png"] = r[f"app{s}"]

    # macOS asset-catalog input for Assets.car (compiled with actool on a Mac).
    iconset = "macos/AppIcon.xcassets/AppIcon.appiconset/"
    images = []
    for pt in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = pt * scale
            name = f"icon_{pt}x{pt}{'@2x' if scale == 2 else ''}.png"
            o[iconset + name] = r[f"tile{px}"]
            images.append({"filename": name, "idiom": "mac", "scale": f"{scale}x", "size": f"{pt}x{pt}"})
    o[iconset + "Contents.json"] = (json.dumps({"images": images, "info": {"author": "xcode", "version": 1}}, indent=2) + "\n").encode()
    o["macos/AppIcon.xcassets/Contents.json"] = b'{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n'
    return o


def to_png_rgb(png):
    im = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def strip_comments(svg):
    return re.sub(r"\n?\s*<!--.*?-->", "", svg, flags=re.S)


MPL = (
    "<!-- This Source Code Form is subject to the terms of the Mozilla Public\n"
    "   - License, v. 2.0. If a copy of the MPL was not distributed with this\n"
    "   - file, You can obtain one at http://mozilla.org/MPL/2.0/. -->\n"
)


def chrome_wordmark(fill, style=""):
    return (
        MPL
        + "<!-- Generated from branding/source/amaya-wordmark.svg by branding/tools/generate.py -->\n"
        + f'<svg xmlns="http://www.w3.org/2000/svg" {fill} viewBox="{WORDMARK_VIEWBOX}">\n'
        + (f"  {style}\n" if style else "")
        + f'  <path d="{WORDMARK_PATH}"/>\n</svg>\n'
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--check", action="store_true", help="only verify outputs are up to date")
    args = ap.parse_args()

    with tempfile.TemporaryDirectory(prefix="amaya-branding-") as tmp:
        rendered = render_all(build_jobs(), tmp)
    files = outputs(rendered)

    stale = []
    for rel, data in sorted(files.items()):
        path = os.path.join(ROOT, rel)
        try:
            with open(path, "rb") as f:
                if f.read() == data:
                    continue
        except FileNotFoundError:
            pass
        stale.append(rel)
        if not args.check:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(data)

    if args.check:
        if stale:
            print("stale branding outputs:\n  " + "\n  ".join(stale), file=sys.stderr)
            return 1
        print(f"all {len(files)} generated branding files are up to date")
        return 0
    print(f"{len(files)} files generated, {len(stale)} changed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
