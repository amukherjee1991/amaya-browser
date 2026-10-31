#!/usr/bin/env python3
"""Compare the pinned Firefox version with Mozilla's latest release.

Prints a JSON object for the release-watch workflow:
  {"pinned": "159.0", "latest": "159.0.1", "newer": true,
   "title": "...", "body": "..."}

usage: tools/firefox_release_watch.py [--upstream upstream.json] [--versions-json FILE]
(--versions-json reads product-details from a file instead of the network; for tests.)
"""
import argparse
import json
import re
import sys
import urllib.request
from pathlib import Path

PRODUCT_DETAILS = "https://product-details.mozilla.org/1.0/firefox_versions.json"


def parse_version(v):
    """'159.0.1' -> (159, 0, 1). Ignores suffixes such as 'esr' or 'b3'."""
    nums = re.findall(r"\d+", v.split("esr")[0].split("b")[0].split("a")[0])
    return tuple(int(n) for n in nums)


def is_newer(latest, pinned):
    a, b = parse_version(latest), parse_version(pinned)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def issue_text(pinned, latest, details):
    major_bump = parse_version(latest)[0] > parse_version(pinned)[0]
    kind = "major release" if major_bump else "point release (often security fixes)"
    title = f"Firefox {latest} is out: rebase from {pinned}"
    body = f"""Mozilla released **Firefox {latest}**, a {kind}. Amaya is pinned to **{pinned}** in `upstream.json`.

- Release notes: https://www.mozilla.org/firefox/{latest}/releasenotes/
- Security advisories: https://www.mozilla.org/security/known-vulnerabilities/firefox/
- Released: {details.get("LAST_RELEASE_DATE", "unknown")}

Target: ship within 48 hours of a Firefox security release.

### Rebase

```sh
git switch -c rebase/fx-{latest} main
tools/amaya rebase {latest}      # fetches the new source and re-applies patches/ with --3way
tools/amaya build && tools/amaya package
tests/privacy/run.sh dist/stage/amaya/amaya --duration 300
```

### Checklist

- [ ] Every patch in `patches/` applies (refresh with `tools/amaya export --refresh` if needed)
- [ ] Prefs and policies in `settings/` still exist in the new version
- [ ] Sandbox, site isolation, HTTPS-only and certificate checks unchanged
- [ ] UI layer (`ui/`) loads without errors
- [ ] Idle-traffic test (Gate 1) passes
- [ ] Bump `amaya_revision` back to 1, merge, tag `v{latest}-1` to release

_Opened automatically by the Firefox release watch._
"""
    return title, body


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--upstream", default="upstream.json")
    ap.add_argument("--versions-json")
    args = ap.parse_args(argv)

    pinned = json.loads(Path(args.upstream).read_text())["version"]
    if args.versions_json:
        details = json.loads(Path(args.versions_json).read_text())
    else:
        with urllib.request.urlopen(PRODUCT_DETAILS, timeout=30) as r:
            details = json.load(r)
    latest = details["LATEST_FIREFOX_VERSION"]

    out = {"pinned": pinned, "latest": latest, "newer": is_newer(latest, pinned)}
    if out["newer"]:
        out["title"], out["body"] = issue_text(pinned, latest, details)
    json.dump(out, sys.stdout)
    print()


if __name__ == "__main__":
    main()
