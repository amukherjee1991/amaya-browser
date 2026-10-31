#!/usr/bin/env python3
"""Build (or refresh) Amaya's signed static apt repository.

usage: build-apt-repo.py --repo DIR [--deb FILE ...] [--gnupghome DIR] [--key FPR]
                         [--keep N] [--force] [--no-sign]

Copies the given .debs into pool/, keeps the newest N versions of each
package/arch (default 3), regenerates the indexes and the AppStream (DEP-11)
catalog, and signs the result:

  pool/main/a/amaya/amaya_<ver>_<arch>.deb
  dists/stable/InRelease, Release, Release.gpg
  dists/stable/main/binary-{amd64,arm64}/Packages{,.gz,.xz}
  dists/stable/main/dep11/Components-{amd64,arm64}.yml{,.gz}
  dists/stable/main/dep11/icons-{48x48,64x64,128x128}{,@2}.tar{,.gz}
  media/org.amaya.Browser/icons/<W>x<H>/amaya_org.amaya.Browser.png
  amaya-archive-keyring.gpg, amaya-archive-keyring.asc   (public key)

dists/ is built in a temporary tree under the repo and then switched over
atomically: `dists` is a symlink into .dists/<stamp>/, replaced with a single
rename, so clients never see a half-written index.  The previous generation is
kept for clients that fetched InRelease just before the switch.

Running it again with nothing new is a no-op (exit 0, "unchanged") unless
--force is given.  The AppStream data comes from this checkout:
packaging/debian/org.amaya.Browser.metainfo.xml.in, the .desktop file and the
icons in branding/linux/hicolor.

Needs: python3 (stdlib), apt-ftparchive (apt-utils), dpkg-deb, gpg.
Environment: AMAYA_APT_GNUPGHOME / GNUPGHOME, AMAYA_APT_KEY (fingerprint).
"""
import argparse
import fcntl
import functools
import gzip
import hashlib
import io
import lzma
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import xml.etree.ElementTree as ET
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEBIAN_DIR = HERE.parent
REPO_ROOT = DEBIAN_DIR.parent.parent

APP_ID = "org.amaya.Browser"
SUITE = "stable"
COMPONENT = "main"
ARCHES = ("amd64", "arm64")
ORIGIN = "amaya"  # DEP-11 origin (also names the icon cache dir on clients)
SITE = "https://amaya.arghyam.me"
BASE_URL = f"{SITE}/apt"
MEDIA_BASE_URL = f"{BASE_URL}/media"
HOMEPAGE = SITE
# DEP-11 icon tarballs: (tarball size, pixel size of the PNGs inside, scale)
ICON_SETS = [(48, 48, 1), (64, 64, 1), (128, 128, 1),
             (48, 96, 2), (64, 128, 2), (128, 256, 2)]
DEFAULT_GNUPGHOME = Path.home() / ".local/share/amaya-apt/gnupg"
SIGNATURE_FILES = ("Release", "InRelease", "Release.gpg")
GENERATIONS_KEPT = 2


def log(*a):
    print("[build-apt-repo]", *a, file=sys.stderr, flush=True)


def die(msg):
    log("error:", msg)
    sys.exit(1)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, **kw)


def write_bytes(path, data, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    os.chmod(path, mode)


# --------------------------------------------------------------------------
# Packages in the pool
# --------------------------------------------------------------------------

def deb_fields(deb):
    out = run(["dpkg-deb", "-f", str(deb), "Package", "Version", "Architecture"],
              capture_output=True, text=True).stdout
    f = dict(line.split(": ", 1) for line in out.splitlines() if ": " in line)
    for k in ("Package", "Version", "Architecture"):
        if not f.get(k):
            die(f"{deb}: no {k} field")
    return f


def version_cmp(a, b):
    if a == b:
        return 0
    lt = subprocess.run(["dpkg", "--compare-versions", a, "lt", b]).returncode == 0
    return -1 if lt else 1


def deb_member(deb, name):
    """Read one file from a .deb's data tarball (None if absent)."""
    # stderr: dpkg-deb complains about the broken pipe when we stop reading early.
    p = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(deb)], stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL)
    data = None
    try:
        with tarfile.open(fileobj=p.stdout, mode="r|") as tf:
            for m in tf:
                if m.name in (name, "./" + name.lstrip("./")) and m.isfile():
                    data = tf.extractfile(m).read()
                    break
    finally:
        p.stdout.close()
        p.wait()
    return data


def release_date(deb):
    """Date of the package's changelog entry (unix seconds), else file mtime."""
    raw = deb_member(deb, "./usr/share/doc/amaya/changelog.Debian.gz")
    if raw:
        for line in gzip.decompress(raw).decode("utf-8", "replace").splitlines():
            m = re.match(r"^ -- .+?  (.+)$", line)
            if m:
                try:
                    return int(parsedate_to_datetime(m.group(1)).timestamp())
                except (TypeError, ValueError):
                    break
    return int(deb.stat().st_mtime)


def add_debs(repo, debs):
    for deb in debs:
        deb = Path(deb)
        if not deb.is_file():
            die(f"not a file: {deb}")
        f = deb_fields(deb)
        pkg = f["Package"]
        dest = repo / "pool" / COMPONENT / pkg[0] / pkg / f"{pkg}_{f['Version']}_{f['Architecture']}.deb"
        if dest.exists() and dest.read_bytes() == deb.read_bytes():
            log(f"pool already has {dest.name}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(f".{dest.name}.tmp")
        shutil.copyfile(deb, tmp)
        os.chmod(tmp, 0o644)
        os.replace(tmp, dest)
        log(f"added {dest.relative_to(repo)}")


def pool_debs(repo):
    """{(package, arch): [(version, path), ...newest first]}"""
    groups = {}
    for deb in sorted((repo / "pool" / COMPONENT).rglob("*.deb")):
        f = deb_fields(deb)
        groups.setdefault((f["Package"], f["Architecture"]), []).append((f["Version"], deb))
    key = functools.cmp_to_key(lambda a, b: version_cmp(a[0], b[0]))
    for k in groups:
        groups[k].sort(key=key, reverse=True)
    return groups


def prune_pool(repo, groups, keep):
    """Split into (kept groups, files to delete after the switch)."""
    stale = []
    for k, items in groups.items():
        stale += [p for _, p in items[keep:]]
        groups[k] = items[:keep]
    return groups, stale


# --------------------------------------------------------------------------
# AppStream / DEP-11
# --------------------------------------------------------------------------

def q(s):
    """A YAML double-quoted scalar (JSON string syntax is valid YAML)."""
    out = ['"']
    for ch in str(s):
        if ch in '"\\':
            out.append("\\" + ch)
        elif ch == "\n":
            out.append("\\n")
        elif ord(ch) < 0x20:
            out.append(f"\\x{ord(ch):02x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def text_of(el):
    return " ".join("".join(el.itertext()).split()) if el is not None else ""


def description_markup(desc):
    """AppStream <description> -> the DEP-11 markup string (p/ul/ol/li)."""
    parts = []
    for child in desc:
        if child.tag == "p":
            parts.append(f"<p>{escape_xml(text_of(child))}</p>")
        elif child.tag in ("ul", "ol"):
            items = "".join(f"<li>{escape_xml(text_of(li))}</li>" for li in child if li.tag == "li")
            parts.append(f"<{child.tag}>{items}</{child.tag}>")
    return "\n".join(parts)


def escape_xml(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def read_desktop(path):
    entry, section = {}, None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("["):
            section = line
        elif section == "[Desktop Entry]" and "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            entry[k.strip()] = v.strip()
    split = lambda v: [x for x in v.split(";") if x]
    return {"mimetypes": split(entry.get("MimeType", "")),
            "keywords": split(entry.get("Keywords", "")),
            "categories": split(entry.get("Categories", ""))}


def find_icons(icons_dir):
    """{pixel size: path} of the square hicolor PNGs."""
    found = {}
    for png in icons_dir.glob(f"*x*/apps/{APP_ID}.png"):
        m = re.fullmatch(r"(\d+)x(\d+)", png.parent.parent.name)
        if m and m.group(1) == m.group(2):
            found[int(m.group(1))] = png
    return found


def component_yaml(pkg, releases, metainfo, desktop, icon_sets):
    """One DEP-11 component document for `pkg`.

    releases: [(version, unix time)], newest first.
    icon_sets: [(tarball size, px, scale)] that exist for this package.
    """
    root = ET.parse(metainfo).getroot()
    find = root.find
    d = read_desktop(desktop)
    icon_name = f"{pkg}_{APP_ID}.png"

    keywords = []
    for k in [text_of(k) for k in root.iter("keyword")] + d["keywords"]:
        if k and k.lower() not in (x.lower() for x in keywords):
            keywords.append(k)
    categories = [text_of(c) for c in root.iter("category")] or d["categories"]
    binaries = [text_of(b) for b in root.iter("binary")]
    developer = find("developer")
    dev_name = text_of(developer.find("name")) if developer is not None else ""
    launchable = find("launchable")

    y = ["---",
         f"Type: {root.get('type', 'desktop-application')}",
         f"ID: {text_of(find('id'))}",
         f"Package: {pkg}",
         "Name:", f"  C: {q(text_of(find('name')))}",
         "Summary:", f"  C: {q(text_of(find('summary')))}",
         "Description:", f"  C: {q(description_markup(find('description')))}"]
    if dev_name:
        y += ["Developer:"]
        if developer.get("id"):
            y += [f"  id: {developer.get('id')}"]
        y += ["  name:", f"    C: {q(dev_name)}",
              "DeveloperName:", f"  C: {q(dev_name)}"]
    y += [f"ProjectLicense: {text_of(find('project_license'))}",
          "Url:", f"  homepage: {q(HOMEPAGE)}",
          "Categories:"] + [f"- {c}" for c in categories]
    y += ["Keywords:", "  C:"] + [f"  - {q(k)}" for k in keywords]
    y += ["Icon:", f"  stock: {APP_ID}", "  cached:"]
    for _, px, scale in icon_sets:
        y += [f"  - name: {icon_name}", f"    width: {px // scale}", f"    height: {px // scale}"]
        if scale != 1:
            y += [f"    scale: {scale}"]
    y += ["  remote:"]
    for _, px, scale in icon_sets:
        if scale == 1:
            y += [f"  - url: {APP_ID}/icons/{px}x{px}/{icon_name}",
                  f"    width: {px}", f"    height: {px}"]
    if launchable is not None:
        y += ["Launchable:", f"  {launchable.get('type', 'desktop-id')}:", f"  - {text_of(launchable)}"]
    if d["mimetypes"] or binaries:
        y += ["Provides:"]
        if d["mimetypes"]:
            y += ["  mediatypes:"] + [f"  - {m}" for m in d["mimetypes"]]
        if binaries:
            y += ["  binaries:"] + [f"  - {b}" for b in binaries]
    if root.find("content_rating") is not None:
        y += ["ContentRating:", f"  {root.find('content_rating').get('type', 'oars-1.1')}: {{}}"]
    y += ["Releases:"]
    for version, ts in releases:
        y += [f"- version: {q(version)}", "  type: stable", f"  unix-timestamp: {ts}"]
    return "\n".join(y) + "\n"


def dep11_header(arch):
    return ("---\nFile: DEP-11\nVersion: '1.0'\n"
            f"Origin: {ORIGIN}\nMediaBaseUrl: {MEDIA_BASE_URL}\n"
            f"Architecture: {arch}\n")


def icon_tarball(members):
    """Deterministic (uncompressed) tar of {name: bytes}."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.GNU_FORMAT) as tf:
        for name, data in sorted(members.items()):
            ti = tarfile.TarInfo(name)
            ti.size, ti.mode, ti.mtime = len(data), 0o644, 0
            ti.uname = ti.gname = "root"
            tf.addfile(ti, io.BytesIO(data))
    return raw.getvalue()


# --------------------------------------------------------------------------
# Indexes, Release, signing
# --------------------------------------------------------------------------

def packages_index(repo, arch, files):
    """apt-ftparchive over a scratch dir of symlinks to the kept pool files."""
    if not files:
        return b""
    with tempfile.TemporaryDirectory(dir=repo, prefix=".pkgs-") as tmp:
        tmp = Path(tmp)
        for f in files:
            rel = f.relative_to(repo)
            link = tmp / rel
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(f)
        out = run(["apt-ftparchive", "--arch", arch, "packages", f"pool/{COMPONENT}"],
                  cwd=tmp, capture_output=True).stdout
    return out


def top_level_sig(dist_dir, p):
    return p.parent == dist_dir and p.name in SIGNATURE_FILES


def release_file(dist_dir):
    files = sorted(p for p in dist_dir.rglob("*") if p.is_file() and not top_level_sig(dist_dir, p))
    lines = ["Origin: Amaya", "Label: Amaya", f"Suite: {SUITE}", f"Codename: {SUITE}",
             f"Date: {formatdate(time.time(), usegmt=True)}",
             f"Architectures: {' '.join(ARCHES)}", f"Components: {COMPONENT}",
             "Description: Amaya Browser - privacy-first web browser built on Gecko",
             "Acquire-By-Hash: no"]
    for label, algo in (("MD5Sum", "md5"), ("SHA256", "sha256"), ("SHA512", "sha512")):
        lines.append(f"{label}:")
        for p in files:
            data = p.read_bytes()
            lines.append(f" {hashlib.new(algo, data).hexdigest()} {len(data):>16} "
                         f"{p.relative_to(dist_dir).as_posix()}")
    return ("\n".join(lines) + "\n").encode()


def gpg(gnupghome, *args, **kw):
    env = dict(os.environ, GNUPGHOME=str(gnupghome))
    return run(["gpg", "--batch", "--yes", "--no-tty", "--pinentry-mode", "loopback",
                "--passphrase", "", *args], env=env, **kw)


def pick_key(gnupghome, key):
    out = gpg(gnupghome, "--with-colons", "--list-secret-keys", capture_output=True, text=True).stdout
    fprs, sec = [], False
    for line in out.splitlines():
        f = line.split(":")
        if f[0] == "sec":
            sec = f[1] not in ("e", "r")
        elif f[0] == "fpr" and sec:
            fprs.append(f[9])
            sec = False
    if key:
        key = key.replace(" ", "").upper()
        match = [f for f in fprs if f.endswith(key)]
        if not match:
            die(f"no usable secret key {key} in {gnupghome}")
        return match[0]
    if len(fprs) != 1:
        die(f"{len(fprs)} usable secret keys in {gnupghome}; pass --key")
    return fprs[0]


def sign(gnupghome, key, dist_dir):
    rel = dist_dir / "Release"
    common = ["--local-user", key, "--digest-algo", "SHA512"]
    gpg(gnupghome, *common, "--clearsign", "-o", str(dist_dir / "InRelease"), str(rel))
    gpg(gnupghome, *common, "--armor", "--detach-sign", "-o", str(dist_dir / "Release.gpg"), str(rel))
    for n in ("InRelease", "Release.gpg"):
        os.chmod(dist_dir / n, 0o644)


def content_digest(dist_dir):
    """Hash of everything in a dists tree except Release and its signatures."""
    h = hashlib.sha256()
    if not dist_dir.is_dir():
        return None
    for p in sorted(dist_dir.rglob("*")):
        if p.is_file() and not top_level_sig(dist_dir, p):
            h.update(p.relative_to(dist_dir).as_posix().encode() + b"\0" + p.read_bytes())
    return h.hexdigest()


def signed_by(gnupghome, dist_dir, key):
    """True if dist_dir/InRelease carries a good signature from `key`."""
    try:
        r = subprocess.run(["gpg", "--batch", "--status-fd", "1", "--verify", str(dist_dir / "InRelease")],
                           env=dict(os.environ, GNUPGHOME=str(gnupghome)), capture_output=True, text=True)
    except OSError:
        return False
    return r.returncode == 0 and any(l.startswith("[GNUPG:] VALIDSIG ") and key in l
                                     for l in r.stdout.splitlines())


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def build_dists(repo, stage, groups, args):
    """Write the complete dists/ tree into `stage`; return the media files."""
    dist_dir = stage / SUITE
    comp_dir = dist_dir / COMPONENT
    icons = find_icons(args.icons)
    media = {}
    icon_members = {size_scale: {} for size_scale in ICON_SETS}
    for arch in ARCHES:
        files = [p for (pkg, a), items in groups.items() if a in (arch, "all") for _, p in items]
        pk = packages_index(repo, arch, files)
        bdir = comp_dir / f"binary-{arch}"
        write_bytes(bdir / "Packages", pk)
        write_bytes(bdir / "Packages.gz", gzip.compress(pk, 9, mtime=0))
        write_bytes(bdir / "Packages.xz", lzma.compress(pk))
        write_bytes(bdir / "Release", (f"Archive: {SUITE}\nOrigin: Amaya\nLabel: Amaya\n"
                                       f"Component: {COMPONENT}\nArchitecture: {arch}\n").encode())

        docs = [dep11_header(arch)]
        for (pkg, a), items in sorted(groups.items()):
            if a not in (arch, "all") or pkg != "amaya":
                continue
            available = [s for s in ICON_SETS if s[1] in icons]
            releases = [(v, release_date(p)) for v, p in items]
            docs.append(component_yaml(pkg, releases, args.metainfo, args.desktop, available))
            for s in available:
                icon_members[s][f"{pkg}_{APP_ID}.png"] = icons[s[1]].read_bytes()
                if s[2] == 1:
                    media[f"{APP_ID}/icons/{s[1]}x{s[1]}/{pkg}_{APP_ID}.png"] = icons[s[1]]
        yml = "".join(docs).encode()
        # apt verifies the decompressed file against the Release entry of the
        # uncompressed name, so both are published (as Debian does).
        write_bytes(comp_dir / "dep11" / f"Components-{arch}.yml", yml)
        write_bytes(comp_dir / "dep11" / f"Components-{arch}.yml.gz", gzip.compress(yml, 9, mtime=0))

    for (size, px, scale), members in icon_members.items():
        if members:
            suffix = "@2" if scale == 2 else ""
            tar = icon_tarball(members)
            write_bytes(comp_dir / "dep11" / f"icons-{size}x{size}{suffix}.tar", tar)
            write_bytes(comp_dir / "dep11" / f"icons-{size}x{size}{suffix}.tar.gz", gzip.compress(tar, 9, mtime=0))
    return media


def switch_dists(repo, new_dists):
    """Point repo/dists at new_dists (a dir under repo/.dists/) atomically."""
    link = repo / "dists"
    if link.exists() and not link.is_symlink():
        # First run over an old-style real directory: move it aside.
        legacy = repo / ".dists" / f"legacy-{int(time.time())}"
        legacy.mkdir(parents=True)
        os.rename(link, legacy / "dists")
    tmp_link = repo / f".dists-link-{os.getpid()}"
    if tmp_link.is_symlink() or tmp_link.exists():
        tmp_link.unlink()
    tmp_link.symlink_to(new_dists.relative_to(repo))
    os.replace(tmp_link, link)


def gc_generations(repo):
    gens = sorted((p for p in (repo / ".dists").iterdir() if p.is_dir()), key=lambda p: p.name)
    current = (repo / "dists").resolve()
    keep = []
    for g in reversed(gens):
        if current.is_relative_to(g) or len(keep) < GENERATIONS_KEPT:
            keep.append(g)
    for g in gens:
        if g not in keep:
            shutil.rmtree(g)


def export_public_key(repo, gnupghome, key):
    pub = gpg(gnupghome, "--export", key, capture_output=True).stdout
    asc = gpg(gnupghome, "--armor", "--export", key, capture_output=True).stdout
    for name, data in (("amaya-archive-keyring.gpg", pub), ("amaya-archive-keyring.asc", asc)):
        dest = repo / name
        if not dest.exists() or dest.read_bytes() != data:
            write_bytes(dest, data)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--repo", required=True, type=Path, help="repository root (served as /apt/)")
    ap.add_argument("--deb", nargs="*", default=[], type=Path, help=".deb files to add")
    ap.add_argument("--gnupghome", type=Path,
                    default=Path(os.environ.get("AMAYA_APT_GNUPGHOME") or DEFAULT_GNUPGHOME))
    ap.add_argument("--key", default=os.environ.get("AMAYA_APT_KEY", ""), help="signing key fingerprint")
    ap.add_argument("--keep", type=int, default=3, help="versions kept per package/arch (default 3)")
    ap.add_argument("--force", action="store_true", help="re-sign even if nothing changed")
    ap.add_argument("--no-sign", action="store_true", help="skip signing (tests only)")
    ap.add_argument("--metainfo", type=Path, default=DEBIAN_DIR / f"{APP_ID}.metainfo.xml.in")
    ap.add_argument("--desktop", type=Path, default=DEBIAN_DIR / f"{APP_ID}.desktop")
    ap.add_argument("--icons", type=Path, default=REPO_ROOT / "branding/linux/hicolor")
    args = ap.parse_args(argv)

    for tool in ("dpkg-deb", "apt-ftparchive") + (() if args.no_sign else ("gpg",)):
        if not shutil.which(tool):
            die(f"{tool} not found")
    repo = args.repo.expanduser()
    repo.mkdir(parents=True, exist_ok=True)
    os.chmod(repo, 0o755)
    repo = repo.resolve()
    key = None if args.no_sign else pick_key(args.gnupghome, args.key)

    # One builder at a time (the sync timer and a manual publish may overlap).
    with open(repo / ".lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return build(repo, args, key)


def build(repo, args, key):
    add_debs(repo, args.deb)
    groups, stale = prune_pool(repo, pool_debs(repo), max(1, args.keep))
    if not groups:
        die(f"no packages in {repo}/pool")

    gens = repo / ".dists"
    gens.mkdir(exist_ok=True)
    os.chmod(gens, 0o755)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    work = Path(tempfile.mkdtemp(dir=gens, prefix=f".build-{stamp}-"))
    try:
        stage = work / "dists"
        media = build_dists(repo, stage, groups, args)
        current = repo / "dists" / SUITE
        unchanged = (not args.force and not stale and content_digest(stage / SUITE) == content_digest(current)
                     and (args.no_sign or signed_by(args.gnupghome, current, key)))
        if unchanged:
            log("unchanged; nothing to do (use --force to re-sign)")
            return 0
        write_bytes(stage / SUITE / "Release", release_file(stage / SUITE))
        if not args.no_sign:
            sign(args.gnupghome, key, stage / SUITE)
        for d in [work, *(p for p in work.rglob("*") if p.is_dir())]:
            os.chmod(d, 0o755)
        final = gens / work.name.removeprefix(".build-")  # unique (mkdtemp suffix)
        os.rename(work, final)
        work = None
        switch_dists(repo, final / "dists")
    finally:
        if work is not None and work.exists():
            shutil.rmtree(work)

    for rel, src in media.items():
        dest = repo / "media" / rel
        if not dest.exists() or dest.read_bytes() != src.read_bytes():
            write_bytes(dest, src.read_bytes())
    for d in [repo / "media", repo / "pool", *(repo / "media").rglob("*"), *(repo / "pool").rglob("*")]:
        if d.is_dir():
            os.chmod(d, 0o755)
    if key:
        export_public_key(repo, args.gnupghome, key)
    for p in stale:
        p.unlink()
        log(f"removed old {p.name}")
    gc_generations(repo)
    versions = ", ".join(f"{pkg}/{arch} {' '.join(v for v, _ in items)}" for (pkg, arch), items in sorted(groups.items()))
    log(f"repository ready in {repo} ({versions}){'' if key is None else ', signed by ' + key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
