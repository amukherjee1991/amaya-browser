# Network calls made by Amaya on its own

Scope: a **fresh Amaya install** (Firefox 159.0 + Amaya settings from
`settings/` and `patches/`), started and left alone. "On its own" means the
browser opens the connection without the user loading a page, clicking a link
or turning a feature on. Pages the user visits, and everything those pages
load, are out of scope.

Owner: privacy. The privacy-test agent mirrors the machine-readable block at
the end into `tests/privacy/allowlist.json` (Gate 1: fresh profile, 5 min idle,
zero connections outside the allow-list).

Legend for **Sure?**: ✔ verified in the 159 source; **?** = not yet confirmed
by a packet capture. Gate 1 should confirm or remove these.

## 1. Expected while idle (allow-listed)

| Host | What it is for | When | Can it be turned off? | Sure? |
|---|---|---|---|---|
| `firefox.settings.services.mozilla.com` | Remote Settings. Keeps the **security** collections current: add-on blocklist, CRLite filters and intermediate certificates, certificate revocations, tracking-protection lists (`moz-sbrs://antitracking`), fingerprinting-protection webcompat overrides, password rules. Also the search config and translation model lists (only downloaded when used). | At startup when a collection has no local data, then at most once a day (`services.settings.poll_interval` = 86400; Web Push is off, so there are no push-triggered syncs). | Policy `DisableRemoteSettingsAndAcceptSecurityConsequences`. **Not recommended**: blocklist and revocation data stop updating. Kept on (plan §6). | ✔ |
| `firefox-settings-attachments.cdn.mozilla.net` | Remote Settings attachments (CRLite filters, intermediates). | Same as above, when a collection has new attachments. | Only with Remote Settings (see above). | ✔ |
| `content-signature-2.cdn.mozilla.net` | Certificate chain used to verify the signature of Remote Settings data. | Together with a Remote Settings sync. | Only with Remote Settings. | ✔ |
| `safebrowsing.googleapis.com` | Safe Browsing phishing/malware list updates (v4/v5). Downloads hash-prefix lists; no URLs are sent. When a visited URL matches a prefix, a full-hash lookup sends the 32-bit prefix (not the URL). | Shortly after startup, then about every 30 min (server-controlled back-off). | Settings › Privacy › "Block dangerous and deceptive content" (`browser.safebrowsing.malware.enabled`, `…phishing.enabled`). Kept on: security. **Needs a Google API key at build time** (see Open questions); without it these requests fail. | ✔ (host) / ? (timing) |
| `shavar.services.mozilla.com` | Safe Browsing protocol fallback for Mozilla-hosted lists (`gethash`) and some list updates. Tracking-protection lists now come via Remote Settings, so this may never be contacted. | Rare. | With Safe Browsing / ETP. | ? |
| `aus5.mozilla.org` | GMP (media plug-in) update check: finds the Cisco OpenH264 codec used by WebRTC video calls. | After startup, then daily. | `media.gmp-gmpopenh264.enabled` = false (breaks H.264 WebRTC calls on some sites). Widevine (DRM) is not fetched while `media.eme.enabled` = false. | ? |
| `ciscobinary.openh264.org` | Download of the OpenH264 plug-in announced by the check above. | Once, after the first GMP check; then on codec updates. | As above. | ? |
| `versioncheck.addons.mozilla.org`, `versioncheck-bg.addons.mozilla.org`, `services.addons.mozilla.org`, `addons.mozilla.org`, `addons.cdn.mozilla.net` | Update check for user extensions, including the bundled **uBlock Origin**; downloads the new XPI when there is one. Sends add-on IDs/versions, app version, locale. | Daily (`extensions.update.interval`); the first check is 24 h after the first start. | Policy `ExtensionUpdate: false` or per add-on in about:addons. Kept on: extension updates carry security fixes. | ✔ (host) / ? (first-check timing) |
| uBlock Origin filter lists: `ublockorigin.github.io`, `ublockorigin.pages.dev`, `cdn.jsdelivr.net`, `cdn.statically.io`, `easylist.to`, `secure.fanboy.co.nz`, `pgl.yoyo.org`, `malware-filter.gitlab.io`, `malware-filter.pages.dev`, `curbengh.github.io`, `publicsuffix.org`, `raw.githubusercontent.com` | uBO refreshes its enabled filter lists (it ships packaged copies). Plain GET requests, no identifiers. | ~37 s after launch (`autoUpdateDelayAfterLaunch`) if any list is stale, then every few days per list. | uBO dashboard › Filter lists › "Auto-update filter lists". Kept on: stale lists = worse blocking. | ? (exact host set depends on which lists uBO considers stale) |
| `amaya.arghyam.me` | **Amaya update check** (`ui/modules/update/`). A plain GET of the static `/downloads/latest.json` (version number and file names). Chrome `fetch` with `credentials: "omit"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"` and no custom headers: no cookies, no IDs, no installed version in the request. Only when you press **Update** does it download the `.deb` or `.tar.xz` and `SHA256SUMS` from the same folder (user-initiated). | ~60 s after the app starts, then every 12 h while it runs (one check per session across windows, `amaya.update.lastCheck`); also from the command bar "Check for updates". Skipped while offline and in development runs without `amaya-ui/version.json`. | `amaya.update.enabled` = false (automatic checks off; "Check for updates" still works on demand). | ✔ |

## 2. User-initiated or opt-in only (must NOT appear while idle)

| Host | Purpose | Trigger |
|---|---|---|
| DuckDuckGo `duckduckgo.com` | Default search engine (no partner code). | User searches. |
| `ac.duckduckgo.com` | Search suggestions. | Only after the user enables search suggestions (off by default). |
| `dns.mullvad.net`, `base.dns.mullvad.net`, `dns.quad9.net`, `firefox.dns.nextdns.io`, `mozilla.cloudflare-dns.com` | DNS over HTTPS resolvers offered in Settings. | Only after the user enables DoH (`network.trr.mode` = 5 by default). |
| `support.mozilla.org` (`app.support.baseURL`) | Help / "Learn more" links. Left pointing at Mozilla's SUMO because it documents the Gecko features we ship. | User clicks a help link. |
| `addons.mozilla.org` (browsing) | Installing extensions/themes. | User opens AMO. |
| `location.services.mozilla.com` / GeoClue | Geolocation. Amaya uses the system GeoClue provider and clears `geo.provider.network.url`. | Site asks + user grants permission. |
| `redirector.gvt1.com` / Google CDN | Widevine DRM download. | User enables DRM (`media.eme.enabled`). |
| Translation model attachments (`firefox-settings-attachments.cdn.mozilla.net`) | Local, on-device translation models. | User translates a page. |
| `push.services.mozilla.com` | Web Push (WebSocket). | Off by default (`dom.push.connection.enabled` = false); only if the user turns it back on. |
| `detectportal.firefox.com`, DNS lookups of `example.org` | Captive-portal and connectivity detection. | Off by default; only if re-enabled. Without it, open hotel/airport login pages manually (HTTPS-Only shows a "continue to HTTP" option). |
| `safebrowsing.google.com` `/safebrowsing/diagnostic` | "Report deceptive site". | User reports. |

## 3. Removed or disabled (must NEVER appear)

| Host | What it was | How it is removed |
|---|---|---|
| `incoming.telemetry.mozilla.org` | Telemetry / Glean pings | Built with `MOZ_TELEMETRY_REPORTING` unset, health report compiled out (patch 0101), `DisableTelemetry` policy, upload prefs locked off. |
| `dap-09-3.api.divviup.org`, `dap.services.mozilla.com` | Distributed Aggregation Protocol telemetry | Telemetry off; endpoints cleared. |
| `normandy.cdn.mozilla.net`, `classify-client.services.mozilla.com` | Normandy studies | Normandy compiled out (patch 0101) + policy `DisableFirefoxStudies`. |
| Nimbus experiments (via `firefox.settings.services.mozilla.com/…/nimbus-desktop-experiments`) | Experiments, rollouts, Firefox Labs | Policies `DisableFirefoxStudies`, `DisableRemoteImprovements`, `UserMessaging.FirefoxLabs=false`; `nimbus.rollouts.enabled` locked off. With all three off Nimbus does not fetch. |
| `crash-reports.mozilla.com`, `crash-stats.mozilla.org` | Crash report submission | `--disable-crashreporter` (tooling mozconfig). |
| `merino.services.mozilla.com`, `ohttp-merino.mozilla.fastly-edge.com`, `ohttp-gateway-merino.services.mozilla.com` | Firefox Suggest online, weather, new-tab stories | Prefs + `FirefoxSuggest`/`FirefoxHome` policies; endpoints cleared. |
| `ads.mozilla.org`, `mozilla-ohttp.fastly-edge.com`, `prod.ohttp-gateway.prod.webservices.mozgcp.net`, `contile.services.mozilla.com` | Sponsored tiles / stories (unified ads) | Prefs + `FirefoxHome` policy; endpoints cleared. |
| `getpocket.com`, `img-getpocket.cdn.mozilla.net` | Pocket / stories / image proxy | Pocket was retired upstream; stories and image proxy off; `DisablePocket` policy. |
| `location.services.mozilla.com` (region) | Region detection for search defaults | `browser.region.update.enabled` = false, `browser.region.network.url` = "". |
| `use-application-dns.net` and other DoH heuristic canaries | DoH rollout heuristics | `doh-rollout.disable-heuristics` = true, TRR mode 5, enterprise policies present (heuristics stand down). |
| `push.services.mozilla.com` | Web Push / Remote Settings broadcast channel | `dom.push.connection.enabled` = false. |
| `detectportal.firefox.com`, `firefox-portal-detection.com` | Captive portal / connectivity | Prefs off (see §2). |
| `update.googleapis.com` | Widevine DRM plugin download (Google component updater) | `media.gmp-widevinecdm.enabled` follows `media.eme.enabled` (off until the person enables DRM). Found by the Gate 1 test on 2026-10-30. |
| `archive.mozilla.org/pub/system-addons/` | New-tab "train-hop" add-on updates (Nimbus-driven) | Nimbus off; `browser.newtabpage.trainhopAddon.xpiBaseURL` = "". |
| `aus5.mozilla.org` (system add-ons) | System add-on updates | `DisableSystemAddonUpdate` policy; `extensions.systemAddon.update.enabled` = false. |
| `aus5.mozilla.org` (app update) | Application updates (Linux) | Updater compiled out on Linux (`--disable-updater`). Amaya's own check of `amaya.arghyam.me` (§1) offers new releases instead. macOS (Phase M) will contact an Amaya update manifest instead. |
| `accounts.firefox.com`, `token.services.mozilla.com`, `sync-*.services.mozilla.com` | Mozilla accounts / Sync | `identity.fxaccounts.enabled` = false + `DisableAccounts` policy (until Phase 3). |
| `discovery.addons.mozilla.org` | about:addons recommendations | `extensions.getAddons.showPane` = false, recommendations off. |
| `fpn.firefox.com` / IP Protection | Built-in VPN | Policy `IPProtectionAvailable: false`. |
| `relay.firefox.com` | Firefox Relay integration | `signon.firefoxRelay.feature` = "disabled". |
| `sb-ssl.google.com` (`appRepURL`) | Remote lookup of downloaded files | `browser.safebrowsing.downloads.remote.enabled` = false (local list check still runs). |
| `www.mozilla.org` first-run / what's-new pages | Onboarding pages | `OverrideFirstRunPage`/`OverridePostUpdatePage` = "", `browser.startup.homepage_override.mstone` = "ignore". |
| `tiles.services.mozilla.com`, `snippets.cdn.mozilla.net` | Legacy tiles/snippets | Already removed upstream. |
| Favicons of default Top Sites | New-tab default shortcuts | `browser.newtabpage.activity-stream.default.sites` = "" (empty until the user visits sites). |

## 4. Profile directory note (Linux)

`patches/0001-branding-app-vendor.patch` sets `MOZ_APP_VENDOR` to "Amaya".
On Linux the profile root is derived from the vendor, so Amaya profiles live
under `~/.amaya/…` (or the XDG equivalent) instead of `~/.mozilla/…`. This is
local-only, but it means Amaya never touches existing Firefox profiles and
the privacy test must create its fresh profile in the Amaya location (or pass
`-profile <dir>` explicitly).

## 5. Open questions

* **Safe Browsing API key.** Firefox's Google Safe Browsing v4/v5 requests
  need a key (`--with-google-safebrowsing-api-keyfile`). Without one, list
  updates fail and Safe Browsing protection is effectively off. Options:
  obtain a Google key for Amaya, or ship with Safe Browsing off and document
  it (LibreWolf/Mullvad choice). Decision needed before Gate 1.
* **OpenH264 timing.** Not yet captured whether the first GMP check happens
  within the 5-minute idle window. If it does, it is allow-listed above.
* **uBO first-run refresh.** Exact set of list hosts depends on the packaged
  list ages at install time; confirm with a capture.
* **OCSP.** `security.OCSP.enabled` = 1 means visiting an HTTPS site can
  trigger an OCSP request to the CA (user-initiated, not idle). CRLite covers
  most certificates first.

## 6. Machine-readable allow-list

Hosts the idle test must tolerate. `optional: true` = may or may not appear.
`?`-marked entries in §1 are `optional`.

```json
{
  "version": 1,
  "source": "docs/network-calls.md",
  "allow": [
    {"host": "firefox.settings.services.mozilla.com", "purpose": "remote-settings (security collections)", "optional": false},
    {"host": "firefox-settings-attachments.cdn.mozilla.net", "purpose": "remote-settings attachments", "optional": true},
    {"host": "content-signature-2.cdn.mozilla.net", "purpose": "remote-settings signature chain", "optional": true},
    {"host": "safebrowsing.googleapis.com", "purpose": "safe browsing list updates", "optional": true},
    {"host": "shavar.services.mozilla.com", "purpose": "safe browsing (mozilla lists)", "optional": true},
    {"host": "aus5.mozilla.org", "purpose": "GMP OpenH264 update check", "optional": true},
    {"host": "ciscobinary.openh264.org", "purpose": "OpenH264 download", "optional": true},
    {"host": "versioncheck.addons.mozilla.org", "purpose": "extension update check", "optional": true},
    {"host": "versioncheck-bg.addons.mozilla.org", "purpose": "extension background update check", "optional": true},
    {"host": "services.addons.mozilla.org", "purpose": "extension update check", "optional": true},
    {"host": "addons.mozilla.org", "purpose": "extension update download", "optional": true},
    {"host": "addons.cdn.mozilla.net", "purpose": "extension update download", "optional": true},
    {"host": "ublockorigin.github.io", "purpose": "uBO filter lists", "optional": true},
    {"host": "ublockorigin.pages.dev", "purpose": "uBO filter lists", "optional": true},
    {"host": "cdn.jsdelivr.net", "purpose": "uBO filter lists", "optional": true},
    {"host": "cdn.statically.io", "purpose": "uBO filter lists", "optional": true},
    {"host": "easylist.to", "purpose": "uBO filter lists", "optional": true},
    {"host": "secure.fanboy.co.nz", "purpose": "uBO filter lists", "optional": true},
    {"host": "pgl.yoyo.org", "purpose": "uBO filter lists", "optional": true},
    {"host": "malware-filter.gitlab.io", "purpose": "uBO filter lists", "optional": true},
    {"host": "malware-filter.pages.dev", "purpose": "uBO filter lists", "optional": true},
    {"host": "curbengh.github.io", "purpose": "uBO filter lists", "optional": true},
    {"host": "publicsuffix.org", "purpose": "uBO public suffix list", "optional": true},
    {"host": "raw.githubusercontent.com", "purpose": "uBO filter lists", "optional": true},
    {"host": "amaya.arghyam.me", "purpose": "Amaya update check: static latest.json, no identifiers", "optional": true}
  ],
  "deny": [
    "incoming.telemetry.mozilla.org", "dap-09-3.api.divviup.org", "dap.services.mozilla.com",
    "normandy.cdn.mozilla.net", "classify-client.services.mozilla.com",
    "crash-reports.mozilla.com", "merino.services.mozilla.com",
    "ohttp-merino.mozilla.fastly-edge.com", "ohttp-gateway-merino.services.mozilla.com",
    "ads.mozilla.org", "mozilla-ohttp.fastly-edge.com", "contile.services.mozilla.com",
    "getpocket.com", "img-getpocket.cdn.mozilla.net", "location.services.mozilla.com",
    "push.services.mozilla.com", "detectportal.firefox.com", "firefox-portal-detection.com", "update.googleapis.com", "ipv4only.arpa", "use-application-dns.net",
    "accounts.firefox.com", "token.services.mozilla.com", "discovery.addons.mozilla.org",
    "sb-ssl.google.com", "www.mozilla.org", "support.mozilla.org",
    "mozilla.cloudflare-dns.com", "dns.mullvad.net", "dns.quad9.net"
  ]
}
```
