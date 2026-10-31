# Idle-traffic privacy test (Gate 1)

> A CI test launches a fresh install and fails the build if it contacts
> anything outside a published allow-list.

```sh
tests/privacy/run.sh <browser-binary> [--duration 300] [--allowlist tests/privacy/allowlist.json] \
                     [--report out.json] [--scenario idle|newtab|all] [--headful]
python3 -m unittest discover -s tests/privacy     # unit tests (stdlib only, no browser needed)
```

| Exit | Meaning |
|---|---|
| 0 | every observed destination matched the allow-list |
| 1 | at least one destination outside the allow-list (or an unparseable proxy request) |
| 2 | harness error: bad allow-list, no user/net namespaces, no `/dev/net/tun`, browser exited early or never created its profile, runner timeout |

Observed traffic always wins: if the run was cut short but something was
already denied, the exit status is 1, not 2.

Other options: `--shutdown-grace S` (capture after quit, default 15),
`--quit marionette|sigterm`, `--no-proxy` (DNS stub + sinkhole only),
`--no-sinkhole` (degraded, debugging only), `--workdir DIR` / `--keep-workdir`
(keep profiles, `browser.log`, `events.jsonl`, `status.json`).
`--report out.json` also writes `out.txt` (the human-readable summary that is
printed to stdout).

## What is measured

Each scenario gets a **fresh, throwaway profile** (`-profile <tmp> -no-remote`)
and its own empty `HOME`/`XDG_*` dirs, so the browser behaves like a first
install: distribution extensions install, first-run/welcome pages open, and
Remote Settings, Safe Browsing, GMP and add-on checks start from nothing. This
also covers Amaya's `~/.amaya` profile root (from `MOZ_APP_VENDOR`): the
profile is always passed explicitly and `HOME` is a temp dir, so no existing
profile is ever touched. The browser is launched with **no URL**.

* `idle`: launch, idle for `--duration` (Gate 1: 300 s), quit cleanly, keep
  capturing for `--shutdown-grace` seconds (pingsender and similar).
* `newtab`: same, but 5 s after Marionette is ready it opens a new tab via
  `BrowserCommands.openTab()` (the code path Ctrl+T uses, so about:newtab with
  top sites and sponsored content loads), then 15 s later loads `about:blank`
  into that tab, then idles.
* `all`: every scenario in turn, each with its own fresh profile.

`MOZ_HEADLESS=1` is set unless `--headful` is given.

## How traffic is captured (and why this design)

```
          ┌──────────────── user+net+mount+pid namespace (unprivileged) ───────────────┐
          │  netns_runner.py (uid 0 *inside* the namespace only)                        │
 browser ─┼─ HTTP/HTTPS (proxy prefs) ──▶ logproxy 127.0.0.1:N   records host:port, 403 │
 (real    │─ getaddrinfo ─▶ resolv.conf ▶ dnsstub 127.0.0.1:53   records name, fake IP │
  uid, no │─ anything else (direct TCP, QUIC, DoH-by-IP, STUN, mDNS, pingsender…)       │
  caps)   │       └─▶ default route ─▶ TUN "sinkhole"  records dst ip:port/proto, drop  │
          └────────────────────────────────────────────────────────────────────────────┘
                     no route to the real network exists inside the namespace
```

1. **Logging forward proxy** (`logproxy.py`, stdlib). The fresh profile's
   `user.js` points HTTP and SSL at it. It records `CONNECT host:port` and the
   full URL of plain-HTTP requests, then answers `403` and closes. **Nothing is
   forwarded**, so runs are deterministic, work offline and leak nothing.
2. **Recording DNS stub** (`dnsstub.py`). Inside the namespace,
   `/etc/resolv.conf` → `127.0.0.1` and `/etc/nsswitch.conf` → `hosts: files dns`
   are bind-mounted. Every query is logged. `A` queries get a unique fake address
   from `198.18.0.0/16`, other types get an empty answer.
3. **TUN sinkhole** (`sinkhole.py`). The namespace has only `lo` and a TUN
   device that is the IPv4 and IPv6 default route. Every packet the browser
   sends anywhere non-loopback lands there and is parsed (IPv4/IPv6, TCP/UDP,
   DNS QNAME for direct port-53/5353 packets), recorded and dropped. Connections
   to a fake IP are attributed back to the hostname the stub handed it out for,
   so traffic that bypasses the proxy is still reported **by name and port**.
4. **Hidden host sockets.** tmpfs is mounted over `/run/nscd`,
   `/run/systemd/resolve`, `/run/avahi-daemon`, `/run/dbus`, and (headless)
   `/run/user/$UID`, and `DBUS_SESSION_BUS_ADDRESS` is not passed. That way no
   host daemon can resolve names or connect on the browser's behalf through a
   Unix socket, which a network namespace alone would not stop.

The browser runs as the **real user** in a nested user namespace
(`dropuser.py`), so it holds no capabilities. Its own sandbox is left
completely alone: no `MOZ_DISABLE_*SANDBOX`, no ptrace, and the environment is
rebuilt from scratch so nothing leaks in from the caller. The runner records
evidence: in every validation run, all content, socket, RDD and utility
processes were in seccomp mode 2 and in their own user namespace.

**Why not strace?** `strace -f -e connect,sendto,sendmsg` was considered and
rejected as the backstop:

* ptrace interacts badly with Firefox's seccomp-bpf sandbox (SIGSYS-trapped
  syscalls) and is blocked outright where `kernel.yama.ptrace_scope` ≥ 2.
* It only observes. A missed syscall (`sendmmsg`, io_uring, a process outside
  the traced tree) leaks silently.
* It can't see a host daemon doing work on the browser's behalf.

The namespace design is *enforcing*: with no route out, anything a capture
layer failed to label still can't leave. The sinkhole sees it at packet level
whatever syscall produced it.

The proxy layer is kept because it gives the richest data (full URLs for HTTP,
exact CONNECT targets with no DNS step). The sinkhole is what makes the result
complete. `--no-proxy` runs with a 100% pristine profile and relies on layers
2–3 alone. Validation shows both modes catch the same hosts (below).

### Caveats

* **Proxy prefs.** In the default mode `user.js` sets only
  `network.proxy.*` (type 1, http/ssl → stub proxy, empty `no_proxies_on`,
  `allow_hijacking_localhost`, `failover_direct=false`, `allow_bypass=false`,
  `socks_remote_dns`). Nothing else in the browser's privacy defaults changes.
  A proxy can still alter behaviour, though (e.g. TRR/DoH or HTTP/3 may stand
  down when a proxy is configured). Gate 1 should therefore also be run once
  with `--no-proxy`.
* **Marionette.** Unless `--quit sigterm` is given, the browser is started
  with `-marionette` and `remote.prefs.recommended=false`. Without that pref the
  remote agent would switch off updates, telemetry, Safe Browsing and Remote
  Settings, which are exactly what we measure. For `idle`, the harness connects
  only when the idle period is over, to request a normal quit. This matters
  because **Firefox exits abruptly on SIGTERM**: shutdown code never runs (an
  `aborted-session-ping` is left behind), so shutdown traffic would be missed.
  The `newtab` scenario also sets `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` so
  Marionette can run chrome JS. Marionette makes `navigator.webdriver` true,
  which has no effect on the browser's own background traffic.
* **First-session telemetry.** Stock Firefox did not upload telemetry in a
  first session of up to 90 s: pings are archived until the data-submission
  policy has been shown. A single-launch test can therefore miss telemetry
  that would go out on the *second* launch. A two-launch `restart` scenario is
  being added for this (see the integrator notes in the agent report).
* Loopback destinations are ignored (listed in the JSON under
  `ignored_loopback`).
* **Snap/Flatpak builds can't be measured** (their confinement replaces the
  namespaces). Use an unpacked tarball or the build output directory.

## Allow-list format (`allowlist.json`)

```json
{ "version": 1,
  "entries": [ {"host": "firefox.settings.services.mozilla.com", "port": 443,
                "purpose": "...", "phase": "first-run|idle", "optional": false,
                "source": "docs/network-calls.md", "provisional": true} ],
  "deny": ["incoming.telemetry.mozilla.org", "..."] }
```

* `host`: exact name (case-insensitive) or IP literal. `*.example.com` = exactly
  one extra label. `**.example.com` = any depth. A bare `*` or `*.com` is rejected.
* `port` (int) or `ports` (list). Omitting both allows any port and produces a
  warning. DNS-only observations match on host alone.
* `deny` labels known phone-home hosts as `known_bad` in the report. It doesn't
  change the verdict, since everything not allowed already fails. A host that
  is both allowed and denied is rejected as a contradiction.
* The current list mirrors the machine-readable block in `docs/network-calls.md`
  (22 hosts, all `provisional: true`, plus 27 deny hosts).

## Report

The JSON report (`--report`) contains, per destination: `host`, `port`,
`transport` (`tcp`/`udp`/`dns`), `observed_via` (`proxy`/`dns`/`sinkhole`),
`first_seen` (`t` seconds after launch, scenario, `run`/`shutdown` stage),
`count`, `allowed`, `matched_entry` (the allow-list entry and its index) and
`known_bad`. It also records sample URLs, DNS query types, IPs, browser
version/build ID, capture layers, sandbox evidence and harness warnings and
errors.

## Evidence: stock Firefox 159.0 (build 20261022150525)

Official tarball from archive.mozilla.org (SHA-512 checked against
`SHA512SUMS`), Zorin 18 / kernel 7.0, headless, run as an ordinary user.

**Idle, 90 s, shipped allow-list** (exit 1):

```
Amaya idle-traffic privacy test: FAIL
scenarios  : idle; 90s each; headless=True
capture    : sinkhole, dns, proxy
allow-list : tests/privacy/allowlist.json (22 entries)
result     : 14 destinations, 5 allowed, 9 DENIED

FIRST SEEN  VIA    DESTINATION                                    VERDICT  RULE
idle+0.9s   proxy  location.services.mozilla.com:443/tcp          DENY     known phone-home (deny list)
idle+1.1s   proxy  firefox.settings.services.mozilla.com:443/tcp  allow    #0 firefox.settings.services.mozilla.com
idle+1.6s   proxy  firefox-portal-detection.com:80/tcp            DENY
idle+2.1s   proxy  normandy.cdn.mozilla.net:443/tcp               DENY     known phone-home (deny list)
idle+2.2s   proxy  accounts.firefox.com:443/tcp                   DENY     known phone-home (deny list)
idle+2.3s   dns    cloudflare-dns.com (lookup)                    DENY
idle+2.3s   dns    example.org (lookup)                           DENY
idle+2.3s   dns    ipv4only.arpa (lookup)                         DENY
idle+2.5s   proxy  push.services.mozilla.com:443/tcp              DENY     known phone-home (deny list)
idle+11.8s  proxy  safebrowsing.googleapis.com:443/tcp            allow    #3 safebrowsing.googleapis.com
idle+20.3s  proxy  aus5.mozilla.org:443/tcp                       allow    #5 aus5.mozilla.org
idle+20.3s  proxy  update.googleapis.com:443/tcp                  DENY
idle+20.3s  proxy  ciscobinary.openh264.org:443/tcp               allow    #6 ciscobinary.openh264.org
idle+31.1s  proxy  services.addons.mozilla.org:443/tcp            allow    #8 services.addons.mozilla.org
```

Plain-HTTP URLs captured by the proxy (captive-portal / connectivity checks):
`http://firefox-portal-detection.com/generate_204`, `/success.txt?ipv4`, `/success.txt?ipv6`.
`cloudflare-dns.com` was an `HTTPS`-record lookup (TRR). `example.org` and
`ipv4only.arpa` were `A`/`AAAA` lookups from the connectivity service (NAT64
detection).

**Same idle run with `--no-proxy`, 60 s, empty allow-list** (exit 1). The
profile is untouched, and only the DNS stub and sinkhole see traffic. The
backstop independently finds the same hosts as direct connections, with ports:

```
capture    : sinkhole, dns
FIRST SEEN             VIA       DESTINATION
idle+0.6s              sinkhole  location.services.mozilla.com:443/tcp
idle+0.9s              sinkhole  firefox.settings.services.mozilla.com:443/tcp
idle+1.2s              sinkhole  firefox-portal-detection.com:80/tcp
idle+1.9s              dns       example.org / cloudflare-dns.com / ipv4only.arpa (lookups)
idle+2.1s              sinkhole  push.services.mozilla.com:443/tcp
idle+9.5s              sinkhole  accounts.firefox.com:443/tcp
idle+20.2s             sinkhole  aus5.mozilla.org:443/tcp
idle+30.5s             sinkhole  services.addons.mozilla.org:443/tcp
idle+40.2s             sinkhole  update.googleapis.com:443/tcp
idle+60.3s (shutdown)  sinkhole  normandy.cdn.mozilla.net:443/tcp
(each also seen as a dns lookup just before)
```

**idle + newtab, 90 s each, empty allow-list**: the same 14 hosts in both
scenarios. Opening about:newtab on a fresh profile added no extra host within
the window (stock 159 fetches sponsored and top-sites data later, or via Remote
Settings). Content processes were seccomp-filtered: 5/5 (idle) and 5/5 (newtab).

## Running in CI (Linux host runner)

Needs, all in stock Debian 12/13:

* `python3` (≥ 3.8; 3.12+ uses `os.unshare`, older versions use ctypes)
* `util-linux` (`unshare`, `mount`) and `iproute2` (`ip`)
* `/dev/net/tun` readable and writable by the runner user (default `0666`)
* unprivileged user namespaces: Debian has them on by default
  (`kernel.unprivileged_userns_clone=1`). Ubuntu ≥ 23.10 needs
  `kernel.apparmor_restrict_unprivileged_userns=0` or an AppArmor profile, and
  Firefox's own sandbox needs that too.
* the browser's runtime libraries (headless still links GTK: `libgtk-3-0`,
  `libasound2`, `libx11-xcb1`, `libdbus-glib-1-2`, …)

No root and no network access are required, and the run never reaches the
internet. Running in an unprivileged Docker container usually fails (no
nested user namespaces or TUN); use a host executor or a VM.

## macOS (Phase M), what differs

There are no network namespaces or `unshare` on macOS. The plan:

* Keep the proxy and DNS-stub layers as they are. `report.py`, `allowlist.py`
  and the unit tests are portable.
* Replace the namespace and sinkhole with a **pf** anchor
  (`pass out quick on lo0`, `block return out log all user <test-uid>`), with the
  browser running as a dedicated test user, plus `pflog0` capture
  (`tcpdump -n -i pflog0`) parsed by the same packet parser. This needs sudo
  once to load the anchor, which is fine on the self-hosted Mac runner.
* An alternative needing no root: the Network Extension content filter used by
  LuLu-style tools, which needs signing.
* DNS: point the test user's resolver at the stub with `scutil` / a
  `/etc/resolver/` drop-in, or rely on pf to log port-53 packets.
* The sandbox stays on (Seatbelt). Marionette quit and newtab driving work
  unchanged.

`harness.py` currently exits 2 on non-Linux hosts.

## Files

| File | Role |
|---|---|
| `run.sh` | entry point (wraps `harness.py`) |
| `harness.py` | CLI, preflight checks, launches the namespace, verdict, report, exit code |
| `netns_runner.py` | inside the namespace: network and filesystem isolation, scenarios, sandbox evidence |
| `dropuser.py` | exec the browser as the real uid in a nested user namespace |
| `logproxy.py`, `dnsstub.py`, `sinkhole.py` | the three capture layers |
| `marionette.py` | minimal Marionette client (newtab scenario, clean quit) |
| `allowlist.py`, `allowlist.json` | allow/deny list and matcher |
| `report.py`, `events.py` | aggregation, JSON/text report, event log |
| `test_*.py` | unit tests (`python3 -m unittest discover -s tests/privacy`) |
