"""Amaya idle-traffic privacy test (Gate 1) -- host-side entry point.

Invoked by run.sh.  Exit status: 0 = every observed destination allowed,
1 = at least one destination outside the allow-list, 2 = harness error.
See README.md for the capture design.
"""

import argparse
import datetime
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from allowlist import Allowlist, AllowlistError  # noqa: E402
from events import read_jsonl  # noqa: E402
import report as reportmod  # noqa: E402

EXIT_PASS, EXIT_FAIL, EXIT_ERROR = 0, 1, 2
SCENARIOS = ("idle", "newtab", "restart")


class HarnessError(Exception):
    pass


def parse_args(argv):
    p = argparse.ArgumentParser(
        prog="tests/privacy/run.sh",
        description="Launch a fresh browser profile in an isolated network namespace, "
                    "record every destination it tries to reach, and compare against "
                    "the allow-list.")
    p.add_argument("binary", help="path to the browser binary (amaya / firefox)")
    p.add_argument("--duration", type=int, default=300,
                   help="seconds to idle per scenario (default 300)")
    p.add_argument("--allowlist", default=os.path.join(HERE, "allowlist.json"))
    p.add_argument("--report", help="write the JSON report here (text goes next to it as .txt)")
    p.add_argument("--scenario", default="idle",
                   help="comma list of: idle, newtab, restart, all (default idle); each "
                        "scenario gets its own fresh profile; restart launches that "
                        "profile twice (2 x duration)")
    p.add_argument("--headful", action="store_true", help="show the browser window (debugging)")
    p.add_argument("--shutdown-grace", type=int, default=15,
                   help="seconds to keep capturing after SIGTERM (default 15)")
    p.add_argument("--quit", choices=("marionette", "sigterm"), default="marionette",
                   help="how to end the run: 'marionette' (default) asks the browser to "
                        "quit cleanly so shutdown traffic (pingsender...) is measured; "
                        "'sigterm' never enables Marionette but Firefox then exits "
                        "abruptly")
    p.add_argument("--no-proxy", action="store_true",
                   help="do not write proxy prefs; rely on DNS stub + sinkhole only "
                        "(profile is then 100%% pristine)")
    p.add_argument("--no-sinkhole", action="store_true",
                   help="DEGRADED: skip the TUN backstop (non-proxied traffic is then "
                        "blocked but only DNS lookups are observed)")
    p.add_argument("--workdir", help="keep profiles/logs here instead of a temp dir")
    p.add_argument("--keep-workdir", action="store_true")
    a = p.parse_args(argv)
    names = []
    for s in a.scenario.split(","):
        s = s.strip()
        if s == "all":
            names.extend(SCENARIOS)
        elif s in SCENARIOS:
            names.append(s)
        else:
            p.error("unknown scenario %r" % s)
    a.scenarios = list(dict.fromkeys(names))
    if a.duration < 5:
        p.error("--duration must be >= 5")
    return a


def browser_meta(binary):
    real = os.path.realpath(binary)
    meta = {"browser": binary, "browser_realpath": real}
    ini = os.path.join(os.path.dirname(real), "application.ini")
    try:
        with open(ini, encoding="utf-8", errors="replace") as f:
            for line in f:
                k, _, v = line.strip().partition("=")
                if k in ("Name", "Version", "BuildID", "SourceRepository"):
                    meta[{"Name": "product", "Version": "version", "BuildID": "build_id",
                          "SourceRepository": "source_repository"}[k]] = v
    except OSError:
        pass
    return meta


def preflight(args):
    if platform.system() != "Linux":
        raise HarnessError("only Linux is implemented; see README.md 'macOS' for the plan")
    if not (os.path.isfile(args.binary) and os.access(args.binary, os.X_OK)):
        raise HarnessError("browser binary not found or not executable: %s" % args.binary)
    if "/snap/" in os.path.realpath(args.binary):
        raise HarnessError("snap-packaged browsers are confined by snapd and cannot be "
                           "measured; use an unpacked tarball build")
    for tool in ("unshare", "ip", "mount"):
        if not shutil.which(tool):
            raise HarnessError("required tool %r not found (apt install util-linux iproute2 mount)" % tool)
    if os.geteuid() == 0:
        raise HarnessError("run as an unprivileged user (the browser must not run as root)")
    r = subprocess.run(["unshare", "--user", "--map-root-user", "--net", "true"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise HarnessError(
            "cannot create an unprivileged user+network namespace (%s). On Ubuntu >= 23.10 "
            "set sysctl kernel.apparmor_restrict_unprivileged_userns=0 (or install an "
            "AppArmor profile for unshare); on Debian check kernel.unprivileged_userns_clone=1"
            % r.stderr.strip())
    if not args.no_sinkhole and not os.access("/dev/net/tun", os.R_OK | os.W_OK):
        raise HarnessError("/dev/net/tun not accessible (needed for the sinkhole); "
                           "use --no-sinkhole only for local debugging")


def run(args):
    allow = Allowlist.load(args.allowlist)
    preflight(args)
    binary = os.path.abspath(args.binary)
    if args.workdir:
        os.makedirs(args.workdir, exist_ok=False)
        workdir = os.path.abspath(args.workdir)
    else:
        workdir = tempfile.mkdtemp(prefix="amaya-privacy-")
    os.chmod(workdir, 0o755)
    cfg = {
        "binary": binary, "workdir": workdir, "scenarios": args.scenarios,
        "duration": args.duration, "headful": args.headful,
        "proxy": not args.no_proxy, "sinkhole": not args.no_sinkhole,
        "shutdown_grace": args.shutdown_grace, "quit": args.quit,
        "uid": os.getuid(), "gid": os.getgid(),
        "lang": os.environ.get("LANG"),
        "host_env": {k: os.environ.get(k) for k in
                     ("DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR")},
    }
    cfg_path = os.path.join(workdir, "config.json")
    with open(cfg_path, "w") as f:
        json.dump(cfg, f, indent=2)
    started = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    cmd = ["unshare", "--user", "--map-root-user", "--net", "--mount", "--pid",
           "--fork", "--mount-proc", "--kill-child", "--",
           sys.executable, os.path.join(HERE, "netns_runner.py"), cfg_path]
    sessions = len(args.scenarios) + args.scenarios.count("restart")
    budget = sessions * (args.duration + 2 * args.shutdown_grace + 150)
    sys.stderr.write("[harness] workdir %s; scenarios %s x %ss\n"
                     % (workdir, ",".join(args.scenarios), args.duration))
    try:
        rc = subprocess.run(cmd, timeout=budget).returncode
    except subprocess.TimeoutExpired:
        rc = None
    errors = []
    if rc is None:
        errors.append("runner exceeded its time budget (%ss)" % budget)
    status = {}
    try:
        with open(os.path.join(workdir, "status.json")) as f:
            status = json.load(f)
    except (OSError, ValueError) as e:
        errors.append("runner left no status: %s" % e)
    errors.extend(status.get("errors", []))
    if rc not in (0, None) and not errors:
        errors.append("runner exited with %s" % rc)
    warnings = []
    for sc in status.get("scenarios", []):
        if not sc.get("alive_at_end"):
            errors.append("scenario %s: browser exited after %ss (code %s) -- see %s"
                          % (sc["name"], sc.get("exited_after_s"), sc.get("exit_code"),
                             os.path.join(workdir, sc["name"], "browser.log")))
        if args.quit == "marionette" and sc.get("alive_at_end") and not sc.get("clean_exit"):
            warnings.append("scenario %s: browser did not quit cleanly via Marionette "
                            "(shutdown traffic may be missing)" % sc["name"])
        if not sc.get("profile_created"):
            errors.append("scenario %s: profile was never initialised" % sc["name"])
        if sc.get("error"):
            errors.append("scenario %s: %s" % (sc["name"], sc["error"]))
        sb = sc.get("sandbox")
        if sb and sb.get("content_processes") and \
                sb["content_seccomp_filtered"] < sb["content_processes"]:
            warnings.append("scenario %s: only %d/%d content processes are seccomp-sandboxed"
                            % (sc["name"], sb["content_seccomp_filtered"], sb["content_processes"]))
    if len(status.get("scenarios", [])) < len(args.scenarios) and not errors:
        errors.append("not every scenario ran")

    events_path = os.path.join(workdir, "events.jsonl")
    events = read_jsonl(events_path) if os.path.exists(events_path) else []
    meta = browser_meta(binary)
    meta.update({
        "started_at": started, "host": platform.node(), "kernel": platform.release(),
        "scenarios": args.scenarios, "duration_s": args.duration, "headful": args.headful,
        "shutdown_grace_s": args.shutdown_grace, "quit": args.quit, "layers": status.get("layers", []),
        "proxy_prefs": not args.no_proxy, "degraded": args.no_sinkhole,
        "hidden_dirs": status.get("hidden_dirs", []),
        "scenario_status": status.get("scenarios", []),
        "harness_errors": errors, "harness_warnings": warnings,
        "workdir": workdir if (args.keep_workdir or args.workdir) else None,
    })
    rep = reportmod.build_report(events, allow, meta)
    text = reportmod.render_text(rep)
    for w in warnings:
        text += "warning: %s\n" % w
    for e in errors:
        text += "HARNESS ERROR: %s\n" % e
    if args.report:
        with open(args.report, "w") as f:
            json.dump(rep, f, indent=2)
            f.write("\n")
        with open(os.path.splitext(args.report)[0] + ".txt", "w") as f:
            f.write(text)
    sys.stdout.write(text)
    if not (args.keep_workdir or args.workdir):
        shutil.rmtree(workdir, ignore_errors=True)
    if rep["result"] == "fail":
        return EXIT_FAIL  # observed traffic is real evidence even if the run was cut short
    return EXIT_ERROR if errors else EXIT_PASS


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return run(args)
    except (HarnessError, AllowlistError, OSError) as e:
        sys.stderr.write("harness error: %s\n" % e)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
