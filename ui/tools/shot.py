#!/usr/bin/env python3
"""Screenshot the whole Amaya browser window (chrome + page), headless.

  ui/tools/shot.py --out /tmp/x.png [--size 1440x900] [--url URL]
                   [--js CHROME_JS] [--wait SECONDS] [--dark]

Runs the built app with AMAYA_UI_DIR = this checkout's ui/, a fresh profile and
-marionette on a free port.  Waits until window.AmayaUI.ready has resolved,
optionally loads URL in the selected tab, runs CHROME_JS (inline or a file
path) in the browser window's chrome scope, waits --wait seconds, saves a PNG
of the whole window and quits.

CHROME_JS is the body of an async function: `window`, `gBrowser`, `AmayaUI`
etc. are in scope, `await` works, and a `return`ed value is printed as JSON.

Prints every console line tagged [amaya-ui and every console error coming from
a ui/ file, so module errors are visible.  Exit status 1 if the UI did not
initialise or CHROME_JS threw.  Safe to run in parallel.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(TOOLS.parent.parent / "tests" / "privacy"))

import devapp  # noqa: E402
from marionette import Marionette, MarionetteError  # noqa: E402

WAIT_UI_JS = """
const deadline = Date.now() + arguments[0];
while (Date.now() < deadline) {
  if (window.AmayaUI && window.AmayaUI.ready) {
    await window.AmayaUI.ready;
    return { ok: true, modules: window.AmayaUI.modules };
  }
  await new Promise(r => setTimeout(r, 100));
}
return { ok: false, delayed: !!(window.gBrowserInit && gBrowserInit.delayedStartupFinished) };
"""

LOAD_URL_JS = """
const url = arguments[0];
const browser = gBrowser.selectedBrowser;
const loaded = new Promise(resolve => {
  const listener = {
    onStateChange(b, wp, req, flags) {
      if (b === browser && wp.isTopLevel &&
          (flags & Ci.nsIWebProgressListener.STATE_STOP) &&
          (flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW)) {
        gBrowser.removeTabsProgressListener(listener);
        resolve();
      }
    },
  };
  gBrowser.addTabsProgressListener(listener);
});
openTrustedLinkIn(url, "current", {
  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
});
await Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]);
"""

CONSOLE_JS = """
const dir = window.AmayaUI ? AmayaUI.dirURL : arguments[0];
const out = [];
for (const m of Services.console.getMessageArray() || []) {
  if (m instanceof Ci.nsIScriptError) {
    if ((m.sourceName || "").startsWith(dir) || m.errorMessage.includes("[amaya-ui")) {
      const kind = m.flags & Ci.nsIScriptError.warningFlag ? "warning" : "error";
      out.push(`${kind}: ${m.errorMessage} (${m.sourceName}:${m.lineNumber})`);
    }
  }
}
return out;
"""


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def chrome_js_arg(value: str | None) -> str | None:
    if value is None:
        return None
    try:
        if "\n" not in value and Path(value).is_file():
            return Path(value).read_text()
    except OSError:
        pass  # too long for a path: it's inline JS
    return value


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="PNG path to write")
    ap.add_argument("--size", default="1440x900", help="window size WxH (default 1440x900)")
    ap.add_argument("--url", help="load this URL in the selected tab first")
    ap.add_argument("--js", help="chrome JS to run (inline, or a path to a .js file)")
    ap.add_argument("--wait", type=float, default=1.0,
                    help="seconds to wait before the screenshot (default 1)")
    ap.add_argument("--dark", action="store_true", help="force the dark system theme")
    ap.add_argument("--timeout", type=float, default=60, help="startup timeout (s)")
    ap.add_argument("--ui-dir", default=str(devapp.UI_DIR), help="AMAYA_UI_DIR (default: ./ui)")
    ap.add_argument("--as-staged", action="store_true",
                    help="run $AMAYA_APP as is (no cached copy, no AMAYA_UI_DIR): "
                         "tests what `tools/amaya stage` installed into it")
    ap.add_argument("--keep-profile", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="print the whole browser log")
    args = ap.parse_args(argv)

    w, _, hgt = args.size.lower().partition("x")
    width, height = int(w), int(hgt)
    js = chrome_js_arg(args.js)

    app = devapp.source_app() if args.as_staged else devapp.prepare_app()
    port = free_port()
    profile = devapp.make_profile({"marionette.port": port}, dark=args.dark)
    logpath = profile.parent / f"{profile.name}.log"
    env = dict(os.environ)
    env.pop("AMAYA_UI_DIR", None)
    if not args.as_staged:
        env["AMAYA_UI_DIR"] = str(Path(args.ui_dir).resolve())
    env.update({
        "MOZ_HEADLESS": "1",
        "MOZ_HEADLESS_WIDTH": str(width),
        "MOZ_HEADLESS_HEIGHT": str(height),
        "MOZ_REMOTE_ALLOW_SYSTEM_ACCESS": "1",
    })
    cmd = [str(app / "amaya"), "-headless", "-no-remote", "-marionette",
           "-profile", str(profile)]
    logf = open(logpath, "wb")
    proc = subprocess.Popen(cmd, env=env, stdout=logf, stderr=subprocess.STDOUT,
                            start_new_session=True)
    status = 0
    m = None
    try:
        m = Marionette(port=port, timeout=args.timeout)
        m.sock.settimeout(args.timeout + 120)
        m.command("WebDriver:NewSession", {"capabilities": {}})
        m.command("Marionette:SetContext", {"value": "chrome"})
        m.command("WebDriver:SetTimeouts", {"script": int(args.timeout * 1000) + 30000})

        def run(script, *a):
            # Arrow functions see the outer `arguments`; Marionette awaits
            # the returned promise.
            body = f"return (async () => {{\n{script}\n}})();"
            return m.command("WebDriver:ExecuteScript",
                             {"script": body, "args": list(a)})["value"]

        try:
            m.command("WebDriver:SetWindowRect", {"width": width, "height": height})
        except MarionetteError as e:
            print(f"shot: cannot resize window: {e}", file=sys.stderr)
        ready = run(WAIT_UI_JS, int(args.timeout * 1000))
        if ready.get("ok"):
            print(f"shot: Amaya UI ready, modules: {', '.join(ready['modules']) or '(none)'}")
        else:
            status = 1
            print("shot: WARNING window.AmayaUI never became ready "
                  f"(delayed startup finished: {ready.get('delayed')}). "
                  "Is the loader block in amaya.cfg running?", file=sys.stderr)
        if args.url:
            run(LOAD_URL_JS, args.url)
        if js:
            try:
                result = run(js)
                if result is not None:
                    print("shot: js result:", json.dumps(result, indent=2, default=str))
            except MarionetteError as e:
                status = 1
                print(f"shot: CHROME_JS threw: {e}", file=sys.stderr)
        time.sleep(args.wait)
        shot = m.command("WebDriver:TakeScreenshot", {"full": False, "hash": False})["value"]
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(shot))
        print(f"shot: wrote {out}")
        try:
            for line in run(CONSOLE_JS, devapp.UI_DIR.as_uri() + "/"):
                print(f"shot: console {line}")
        except MarionetteError:
            pass
        try:
            m.command("Marionette:Quit", {"flags": ["eForceQuit"]})
        except MarionetteError:
            pass
    except (MarionetteError, OSError) as e:
        status = 1
        print(f"shot: marionette error: {e}", file=sys.stderr)
    finally:
        if m:
            m.close()
        try:
            proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
        logf.close()
        log = logpath.read_text(errors="replace")
        for line in log.splitlines():
            if args.verbose or "[amaya-ui" in line or "amaya.cfg" in line:
                print(f"log: {line}")
        if args.keep_profile:
            print(f"shot: profile kept at {profile}, log {logpath}")
        else:
            shutil.rmtree(profile, ignore_errors=True)
            logpath.unlink(missing_ok=True)
    return status


if __name__ == "__main__":
    sys.exit(main())
