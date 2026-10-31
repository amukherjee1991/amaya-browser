# Amaya privacy defaults (Phase 1 "Hardened core")

Owner: privacy. Base: Firefox 159.0. This is the "why" for everything in
`settings/` and the privacy items in `patches/` and `configs/mozconfig.privacy`.
Network effects are listed in [network-calls.md](network-calls.md).

## How settings are applied

| Layer | File | Installed to | Used for |
|---|---|---|---|
| Build flags | `configs/mozconfig.privacy` | appended to the build mozconfig | Code that should not exist: telemetry reporting, app updater (Linux). |
| Patches | `patches/0001-branding-app-vendor.patch`, `patches/0101-privacy-no-healthreport-normandy.patch` | `git apply` on the engine | Build switches that are only settable in `browser/moz.configure`. |
| Enterprise policies | `settings/policies.json` | `<appdir>/distribution/policies.json` | Features that have a policy switch (studies, Nimbus, Suggest, AI, search engines, accounts). |
| Autoconfig | `settings/autoconfig.js` + `settings/amaya.cfg` | `<appdir>/defaults/pref/autoconfig.js`, `<appdir>/amaya.cfg` | All prefs. `defaultPref` = user can change it; `lockPref` = only where justified (below); `pref` = only behind a one-time `amaya.migration.*` marker. |
| Bundled extensions | `settings/extensions.json` | `<appdir>/distribution/extensions/<id>.xpi` | uBlock Origin 1.75.0 (sha256 verified). |
| Workflow UI (autoconfig unsandboxed) | `settings/autoconfig.js` (`general.config.sandbox_enabled=false`), `amaya.cfg` §12, `ui/` | `<appdir>/amaya-ui/` | Phase 2 interface (see `ui/README.md`), loaded as privileged chrome JS by `amaya.cfg`. **Trade-off:** `amaya.cfg` now runs with full privileges instead of the pref-only sandbox. Both it and `amaya-ui/` are our own files in the install directory, writable only by whoever can already replace the browser binary, so no new attack surface; the cost is that a bug in the UI or the loader block runs privileged (the block is in `try/catch`, since an uncaught error in an unsandboxed `.cfg` quits the browser). All pref lines behave exactly as before. |

Side effect of policies: Settings shows "Your browser is being managed by your
organization". That is expected (LibreWolf does the same).

Restart note: autoconfig is read at startup; changing
`amaya.fingerprinting.mode` (or any default) takes effect after a restart.

## Build-time removals

| Item | Mechanism | Rationale |
|---|---|---|
| Telemetry upload (`MOZ_TELEMETRY_REPORTING`) | `export MOZ_TELEMETRY_REPORTING=` | Removes telemetry reporting code paths, not just the switch. |
| Health report / data-submission service (`MOZ_SERVICES_HEALTHREPORT`) | patch 0101 | `project_flag`, cannot be set from mozconfig. |
| Normandy (`MOZ_NORMANDY`) | patch 0101 | Same; removes the Normandy startup hook and about:studies. |
| `MOZ_DATA_REPORTING` | falls out of the three above + crash reporter off | Removes the data-collection policy notification and the "Firefox Data Collection" settings section. |
| Crash reporter | `--disable-crashreporter` (tooling mozconfig) | No crash report submission. |
| App updater (Linux only) | `--disable-updater` | Updates come from apt. macOS keeps the updater (Phase M). |
| Vendor = "Amaya" | patch 0001 (owner: branding) | Vendor is hard-coded in `browser/moz.configure`. **Side effect:** Linux profiles move from `~/.mozilla/…` to `~/.amaya/…`, so Amaya never shares or touches Firefox profiles. |

## Policies (`settings/policies.json`)

| Policy | Value | Rationale |
|---|---|---|
| DisableTelemetry | true | Belt and braces with the build flag. |
| DisableFirefoxStudies | true | Disables Shield studies; Nimbus studies need it. Also locks CFR prefs off. |
| DisableRemoteImprovements | true | Disables Nimbus rollouts. |
| UserMessaging | no recommendations, no URL-bar interventions, skip onboarding, no "More from Mozilla", `FirefoxLabs: false` | Labs is the last thing that keeps Nimbus fetching. Not locked. |
| DisablePocket | true | Remove any Pocket remnants. |
| DisableAccounts | true | Mozilla accounts/Sync off until Phase 3 (self-hostable E2E sync). |
| DisableSystemAddonUpdate | true | System add-ons ship with the build; no out-of-band updates. |
| DontCheckDefaultBrowser | true | No nag. |
| OverrideFirstRunPage / OverridePostUpdatePage | "" | No mozilla.org pages on first run / after updates. |
| SkipTermsOfUse | true | Mozilla's ToU prompt does not apply to Amaya. |
| IPProtectionAvailable | false | No built-in Mozilla VPN promo/feature. |
| FirefoxHome | search + top sites only; no stories, sponsored, weather, snippets; not locked | Remote content off, local shortcuts kept. |
| FirefoxSuggest | everything false, OnlineEnabled false; not locked | No keystrokes to Merino. |
| GenerativeAI | all false, not locked | AI chatbot, smart window, link previews, smart tab groups off. |
| AIControls | Default `blocked`, Translations `available`; not locked | Translations are local, on-device, on demand only. |
| HttpsOnlyMode | `enabled` | On by default, user can turn it off. |
| SearchEngines | add "DuckDuckGo (Amaya)" (no partner code, local data: icon) as default + private default; remove Google, Bing, built-in DuckDuckGo (partner code `ffab`), eBay, Perplexity | Interim decision (plan §6) until the Phase 2 first-run chooser. Built-in engines cannot be replaced under the same name, hence the distinct name. Users can still add engines. |
| ExtensionSettings | uBO: `private_browsing: true`, `default_area: navbar`; **no** `installation_mode` | `force_installed`/`normal_installed` would make Firefox fetch the XPI from a URL/AMO; we install from `distribution/` instead. |
| ExtensionUpdate | true | Extension updates (incl. uBO) stay on: security fixes. |

Deliberately **not** used: `CaptivePortal`, `NetworkPrediction`,
`EnableTrackingProtection`, `DNSOverHTTPS`: these lock the related prefs; we
want them user-changeable, so they are set as prefs instead.

## Prefs (`settings/amaya.cfg`)

### Locked (and why)

| Pref | Value | Why locked |
|---|---|---|
| `datareporting.healthreport.uploadEnabled`, `datareporting.policy.dataSubmissionEnabled`, `datareporting.usage.uploadEnabled` | false | Upload code is compiled out; a toggle would be a lie. |
| `toolkit.telemetry.enabled`, `.unified`, `.archive.enabled`, `.newProfilePing.enabled`, `.shutdownPingSender.enabled`, `.firstShutdownPing.enabled`, `.bhrPing.enabled`, `.updatePing.enabled`, `.user_characteristics_ping.opt-out` (true) | false | Same. |
| `app.normandy.enabled`, `app.shield.optoutstudies.enabled`, `nimbus.rollouts.enabled` | false | Studies/experiments removed. |
| `xpinstall.signatures.required` | true | Security: only signed add-ons. |
| `extensions.blocklist.enabled` | true | Security: malicious add-on blocklist. |

### Telemetry leftovers (defaults)

`toolkit.telemetry.server`=`data:,`, DAP leader/helper URLs empty,
`app.normandy.api_url` empty, tab-crash reporting and unsubmitted-crash
checks off, new-tab telemetry and private ping off,
`browser.search.serpEventTelemetryCategorization.enabled` false,
`browser.places.interactions.enabled` false (local interaction metrics used
for telemetry/ML). Rationale: even with code removed, empty endpoints mean
nothing can be re-enabled silently.

### Mozilla content and promos

| Prefs | Value | Rationale |
|---|---|---|
| `browser.newtabpage.activity-stream.feeds.{section.topstories,system.topstories,discoverystreamfeed,adsfeed,weatherfeed,stocksfeed,pictureofthedayfeed,inferredpersonalizationfeed,newtabmessaging,wallpaperfeed,sectionslayoutfeed,favicon}`, `…discoverystream.enabled` | false | New tab "stories", ads, weather, widgets and remote favicons all fetch remote data. |
| `…showSponsored`, `…system.showSponsored`, `…showSponsoredTopSites`, `…showSponsoredCheckboxes`, `…unifiedAds.*` (off, endpoint empty), `browser.topsites.contile.enabled`, `browser.topsites.useRemoteSetting` | false | No sponsored tiles/stories. |
| `…showWeather`, `…system.showWeather`, `…widgets.enabled`, `…widgets.system.enabled`, `…newtabWallpapers.enabled` | false | Remote-backed widgets. |
| `…default.sites` | "" | New profiles start without default shortcuts (otherwise their icons load from third-party sites). |
| `browser.newtab.preload` | false | No hidden new-tab page at startup. |
| `browser.newtabpage.trainhopAddon.xpiBaseURL` | "" | No remote new-tab code. |
| ASRouter providers `cfr`, `message-groups`, `messaging-experiments` | `enabled:false` | No remote messaging/CFR; hourly polling stops. `useRemoteL10n` false. |
| `browser.aboutwelcome.enabled`, `browser.uitour.enabled` (url empty), `browser.discovery.enabled`, `browser.preferences.moreFromMozilla`, `browser.vpn_promo.enabled`, `browser.promo.{pin,relay}.enabled`, `browser.contentblocking.report.{monitor,lockwise,show_mobile_app}.enabled`, `browser.ipProtection.enabled`, `browser.dataFeatureRecommendations.enabled`, `messaging-system.askForFeedback` | false | Promotions and onboarding for Mozilla services. |
| `signon.firefoxRelay.feature` | "disabled" | Relay is a Mozilla account service. |
| `identity.mobilepromo.android` | "" | Promo link. |
| `browser.firefox-view.feature-tour` | completed | No Firefox View tour. |
| `extensions.getAddons.showPane`, `extensions.htmlaboutaddons.recommendations.enabled` | false | No add-on recommendations; discovery API and theme-recommendation URLs empty. |
| `browser.shell.checkDefaultBrowser` | false | No nag. |
| `browser.startup.homepage_override.mstone`=`ignore`, `startup.homepage_welcome_url(.additional)`, `startup.homepage_override_url`, `datareporting.policy.firstRunURL` | empty | No mozilla.org pages. |
| `app.support.baseURL` | unchanged (SUMO) | Only fetched when the user clicks Help/"Learn more"; SUMO documents the Gecko features we ship. Replace when Amaya has a help site. |

### URL bar / Firefox Suggest

`browser.urlbar.quicksuggest.{enabled,online.enabled,online.available,mlEnabled}`,
`browser.urlbar.suggest.{quicksuggest.all,quicksuggest.sponsored,quicksuggest.nonsponsored,weather,trending,yelp,yelpRealtime,mdn,amp,wikipedia,addons,sports,importantDates,realtimeOptIn}`,
`browser.urlbar.{sponsoredTopSites,weather.featureGate,trending.featureGate,addons.featureGate}` = false;
`browser.urlbar.merino.endpointURL` = "". Rationale: all of these send typed
text to Mozilla's Merino service or show sponsored results.

### Search

| Pref | Value | Rationale |
|---|---|---|
| `browser.search.suggest.enabled` (+ `.private`), `browser.urlbar.suggest.searches` | false | **Decision:** search suggestions send every keystroke to the engine; off until the user opts in (Settings › Search). The Phase 2 first-run will ask. |
| `browser.urlbar.showSearchSuggestionsFirst` | false | History before suggestions when enabled. |
| `browser.region.update.enabled` false, `browser.region.network.url` "" | — | No region lookup at location.services.mozilla.com. Search uses the default (non-regional) config; our policy sets the default engine anyway. |
| `browser.search.separatePrivateDefault.ui.enabled` | true | Lets users pick a different private-window engine. |
| `browser.search.visualSearch.featureGate` | false | Visual (image) search sends images to a provider. |

### AI / ML

`browser.ml.enable`, `browser.ml.chat.{enabled,sidebar,menu,page,shortcuts}`,
`browser.ml.linkPreview.enabled`, `browser.ml.pageAssist.enabled`,
`browser.smartwindow.enabled`, `browser.tabs.groups.smart.{enabled,userEnabled}`,
`extensions.ml.enabled`, `pdfjs.enableAltText`, `places.semanticHistory.featureGate`
= false. Rationale: chatbot sends page content to third parties; local ML
features download models. All user-enableable (AIControls is not locked).
Translations remain available (local, on demand).

### Accounts / Sync

`identity.fxaccounts.enabled`, `.toolbar.enabled`, `.pairing.enabled` = false
(plus `DisableAccounts` policy). Until Phase 3 self-hostable E2E sync.

### Tracking protection

| Pref | Value | Rationale |
|---|---|---|
| `browser.contentblocking.category` | `strict`, written once as a user value (marker `amaya.migration.etpStrict`) | Firefox only honours the category if it is a user value; a default would be overwritten with "standard". Afterwards the user's choice is kept. Strict = TCP, social/crypto/fingerprinter blocking, level-2 lists, query stripping, referrer restrictions, FPP, bounce tracking protection, local-network-access prompts. |
| `network.cookie.cookieBehavior` (+ `.pbmode`) | 5 | Total Cookie Protection. |
| `privacy.query_stripping.enabled` (+ `.pbmode`), `privacy.query_stripping.strip_on_share.enabled` | true | Strip known tracking parameters, also on "Copy clean link". |
| `privacy.query_stripping.strip_list` | 207 parameters | Local list so stripping works from the first click (Firefox's own list only arrives later via Remote Settings): Mozilla's strip-on-share global list minus the generic `var`/`adid`, plus `igshid`, `ysclid`, Olytics, Marketo and others. Covers the whole `utm_*` family. |
| `privacy.bounceTrackingProtection.mode` | 1 | Purge bounce trackers. |
| `network.http.referer.XOriginTrimmingPolicy` | 2 | Cross-origin referrer = origin only. |
| `privacy.globalprivacycontrol.enabled` | true | Send GPC (legally meaningful in several jurisdictions). |
| `privacy.donottrackheader.enabled` | false | DNT is deprecated and adds entropy. |
| `dom.security.https_only_mode` | true | HTTPS-Only everywhere; per-site exceptions possible. |
| `dom.security.https_only_mode_send_http_background_request` | false | Don't send a plain-HTTP probe to the site. |
| `browser.send_pings` | false | No `<a ping>` auditing. |
| `media.peerconnection.ice.default_address_only` | true | WebRTC does not reveal all local IPs. |

### Network

| Pref | Value | Rationale |
|---|---|---|
| `network.prefetch-next`, `network.dns.disablePrefetch` (true), `network.dns.disablePrefetchFromHTTPS` (true), `network.http.speculative-parallel-limit` (0), `browser.urlbar.speculativeConnect.enabled`, `browser.places.speculativeConnect.enabled`, `network.early-hints.preconnect.enabled` | off | No connections to sites the user did not open. `network.predictor.*` no longer exists in 159. |
| `network.trr.mode` | 5 | DoH is user-chosen; mode 5 = "off by choice", which also blocks Mozilla's DoH rollout. `network.trr.uri`/`custom_uri` empty. |
| `network.trr.default_provider_uri` | Mullvad DNS | No Cloudflare default; preselected only when the user enables DoH. |
| `doh-rollout.provider-list` | Mullvad, Mullvad (ad-blocking), Quad9, NextDNS, Cloudflare | Resolver list shown in Settings. |
| `doh-rollout.disable-heuristics` true, `doh-rollout.enabled` false | — | No canary-domain lookups. |
| `network.dns.echconfig.enabled`, `network.dns.http3_echconfig.enabled`, `network.dns.use_https_rr_as_altsvc` | true | Encrypted Client Hello wherever the resolver returns HTTPS records (most effective with DoH). |
| `network.captive-portal-service.enabled`, `network.connectivity-service.enabled` | false | **Decision:** no pings to detectportal.firefox.com on every network change. Trade-off: captive portals are not detected automatically; open the portal page manually. |
| `dom.push.connection.enabled`, `dom.push.enabled` | false | **Decision:** no permanent WebSocket to Mozilla's push service. Trade-off: no web push notifications; Remote Settings uses its daily poll instead. |
| `geo.provider.use_geoclue` true, `geo.provider.network.url` "" | — | Use the OS location service instead of Google's; only after permission. |

### Update check

| Pref | Default | Why |
|---|---|---|
| `amaya.update.enabled` | true (read by `ui/modules/update/`; unset = true) | Linux has no built-in updater (`--disable-updater`), so without this nobody learns about security fixes. The check is a GET of the static `https://amaya.arghyam.me/downloads/latest.json` ~60 s after start, every 4 h and when a window becomes active more than 1 h after the last check, with no cookies, referrer, custom headers or identifiers (see [network-calls.md](network-calls.md) §1). Set to false to stop automatic checks; "Check for updates" in the command bar still works. Nothing is installed without you pressing **Update**, and downloads are sha256-verified against `SHA256SUMS`. A `.deb` install with Amaya's apt source (`/etc/apt/sources.list.d/amaya.sources`) is updated by apt instead: **Update** opens Software Updater. |

### Fingerprinting modes

`amaya.fingerprinting.mode` (string, default `"balanced"`; unknown values fall
back to balanced). Read in `amaya.cfg` with `getPref`; **takes effect after
restart**. All values are defaults, so individual prefs can still be tuned.

| Pref | balanced (default) | uniform |
|---|---|---|
| `privacy.resistFingerprinting` (+ `.pbmode`) | false | true |
| `privacy.fingerprintingProtection` (+ `.pbmode`) | true | false (RFP supersedes it) |
| `privacy.fingerprintingProtection.overrides` | `+CanvasRandomization,+EfficientCanvasRandomization,+WebGLRandomization,+WebGLRendererConstant,+WebGLVendorSanitize,+FontVisibilityLangPack,+NavigatorHWConcurrencyTiered,+MaxTouchPointsCollapse,+ScreenAvailToResolution,+JSMathFdlibm,+IMEStyle,+AudioSampleRate,+NavigatorOscpu,+NetworkConnection,+CSSColorInfo` | — |
| `privacy.resistFingerprinting.letterboxing` | — | true |
| `privacy.resistFingerprinting.block_mozAddonManager` | — | true |
| `privacy.spoof_english` | — | 2 (always request English) |
| `intl.regional_prefs.use_os_locales` | — | false |
| `webgl.enable-debug-renderer-info` | — | false |
| `media.peerconnection.ice.no_host` | — | true |
| `widget.non-native-theme.use-theme-accent` | — | false |

* **Balanced**: canvas/WebGL readback randomised per site and session,
  GPU/CPU/touch/screen-availability details reduced; real locale, timezone,
  window and screen size kept, so site breakage stays low. You are less
  *trackable* but not *uniform*.
* **Uniform** (Tor/Mullvad style): every uniform user reports the same UTC
  timezone, English locale, rounded (letterboxed) window, generic UA etc.
  Stronger, but more breakage (time zones, dark mode, some sites' layout).

### Updates and add-ons

| Pref | Value | Rationale |
|---|---|---|
| `extensions.systemAddon.update.enabled` false, `.update.url` "" | — | System add-ons update with the app. |
| `extensions.update.enabled`, `extensions.update.autoUpdateDefault` | true | User extensions (incl. uBO) get security updates from AMO, daily. |
| `extensions.installDistroAddons` | true | Copy `distribution/extensions/*.xpi` into the profile on first run, **no network fetch**. Distribution installs are not "foreign", so they start enabled. |
| `extensions.autoDisableScopes` | 15 | Sideloaded add-ons in any scope start disabled (security). Does not affect distribution installs. |
| `extensions.enabledScopes` | 5 | Load add-ons only from the profile and the app dir; ignore `~/.mozilla/extensions` and `/usr/lib/mozilla/extensions`. |
| `extensions.startupScanScopes` | 0 | Firefox default, explicit. |
| `media.eme.enabled` | false | DRM opt-in: Firefox shows an "enable DRM" bar on sites that need it; Widevine is not downloaded until then. OpenH264 (WebRTC) remains. |
| `media.gmp-widevinecdm.enabled` | follows `media.eme.enabled` | Stops the Widevine download until DRM is turned on. |
| `media.gmp-widevinecdm.allow-chromium-update` | false | Otherwise every plugin update check asks update.googleapis.com about Widevine, even with DRM off (found by Gate 1). |

### Security (kept on — never weakened)

| Pref | Value | Trade-off |
|---|---|---|
| `browser.safebrowsing.{malware,phishing,downloads}.enabled` | true | Local list checks; lists updated from Google (no URLs sent). Requires a build-time Safe Browsing key (open question). |
| `browser.safebrowsing.downloads.remote.enabled` | false (url "") | Remote "application reputation" lookups send file name, hash and source URL of downloads to Google. Local download checks still run. |
| `security.remote_settings.crlite_filters.enabled`, `security.remote_settings.intermediates.enabled` | true | Revocation checking without OCSP leaks. |
| `security.OCSP.enabled` | 1 | OCSP fallback for certificates CRLite does not cover. |
| `security.ssl.require_safe_negotiation` | true (default, not locked) | Refuse unsafe TLS renegotiation; a few ancient servers break. |
| `services.settings.poll_interval` | 86400 | Remote Settings (blocklists, CRLite, ETP lists) polled once a day; directly against Mozilla in Phase 1 (plan §6). |
| Sandbox, Fission, certificate checks, HTTPS-Only | untouched / on | Per plan §1: nothing may weaken them. |

## Validation (Firefox 159.0)

* Every pref name in `amaya.cfg`/`autoconfig.js` was found in the 159 tree
  (`StaticPrefList.yaml`, `all.js`, `firefox.js`, or the module that reads it,
  e.g. `ActivityStream.sys.mjs` for `browser.newtabpage.activity-stream.*`).
* Prefs removed from the plan because they **do not exist in 159**:
  `network.predictor.enabled`, `network.predictor.enable-prefetch`,
  `extensions.pocket.enabled`, `browser.ping-centre.telemetry`,
  `toolkit.telemetry.coverage.opt-out`, `toolkit.coverage.opt-out`,
  `toolkit.coverage.endpoint.base`, `browser.contentblocking.report.vpn.enabled`,
  `browser.privatebrowsing.vpnpromourl`, `browser.shopping.experience2023.enabled`,
  `browser.attribution.enabled`, `dom.private-attribution.submission.enabled`,
  `identity.fxaccounts.commands.enabled`, `network.trr.confirmation_telemetry_enabled`,
  `privacy.partition.network_state.ocsp_cache`, `privacy.partition.serviceWorkers`,
  `browser.display.use_system_colors`.
* Every policy in `policies.json` exists in
  `browser/components/enterprisepolicies/schemas/policies-schema.json` and
  matches its types/enums.
* `amaya.cfg` is valid JavaScript (`node --check`), and was executed with
  stub `pref/defaultPref/lockPref/getPref` for modes balanced, uniform, unset
  and an invalid value, plus a second-start run (ETP choice preserved).
* Patches pass `git apply --check` individually and in order against tag
  `upstream-159.0`.
