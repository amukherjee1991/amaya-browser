#!/usr/bin/env python3
"""Write branding/amaya/dsstore: the Finder layout of the macOS .dmg window.

    python3 -m venv /tmp/dsenv && /tmp/dsenv/bin/pip install ds_store mac_alias
    /tmp/dsenv/bin/python branding/tools/make_dsstore.py

Mirrors the layout of upstream's dsstore (window 680x425 at 200,895; 128 px
icons; app at (209, 190); the " " -> /Applications symlink at (472, 190);
background image /.background/background.png) but for "Amaya.app" on a volume
named "Amaya" (= MOZ_APP_DISPLAYNAME, which the build passes as
--volume-name). Deterministic: fixed timestamps, no machine-specific paths.
Kept separate from generate.py because it needs two extra pip packages and the
output rarely changes.
"""

import datetime
import os
import plistlib
import sys

import mac_alias
from ds_store import DSStore

APP = "Amaya.app"
VOLUME = "Amaya"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "amaya", "dsstore")
STAMP = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)


def background_alias():
    volume = mac_alias.VolumeInfo(
        VOLUME, STAMP, b"H+", 5, 3330, b"\0\0", posix_path=f"/Volumes/{VOLUME}"
    )
    target = mac_alias.TargetInfo(
        0, "background.png", 19, 20, STAMP, b"\0\0\0\0", b"\0\0\0\0",
        folder_name=".background",
        cnid_path=(19,),
        carbon_path=f"{VOLUME}:.background:\0background.png".encode(),
        posix_path="/.background/background.png",
    )
    return mac_alias.Alias(volume=volume, target=target).to_bytes()


def main():
    if os.path.exists(OUT):
        os.unlink(OUT)
    with DSStore.open(OUT, "w+") as d:
        d["."]["bwsp"] = {
            "ShowStatusBar": False,
            "ShowToolbar": False,
            "ShowTabView": False,
            "ContainerShowSidebar": False,
            "WindowBounds": "{{200, 895}, {680, 425}}",
            "ShowSidebar": False,
        }
        d["."]["icvp"] = {
            "backgroundColorBlue": 1.0,
            "iconSize": 128.0,
            "arrangeBy": "none",
            "textSize": 12.0,
            "backgroundColorRed": 1.0,
            "backgroundType": 2,
            "backgroundColorGreen": 1.0,
            "gridOffsetX": 0.0,
            "gridOffsetY": 0.0,
            "showItemInfo": False,
            "viewOptionsVersion": 1,
            "labelOnBottom": True,
            "backgroundImageAlias": background_alias(),
            "showIconPreview": True,
            "gridSpacing": 100.0,
        }
        d["."]["vSrn"] = ("long", 1)
        d[APP]["Iloc"] = (209, 190)
        d[" "]["Iloc"] = (472, 190)
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
