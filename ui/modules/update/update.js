/* Amaya update module: tells you when a newer Amaya release exists and helps
 * you install it.  Owns ui/modules/update/.
 *
 * Firefox's updater is compiled out on Linux (Amaya ships as a .deb and a
 * .tar.xz) and not yet configured on macOS (no MAR signing key or update
 * manifest; see docs/PLATFORMS_PLAN.md), so this module does the minimum by
 * hand on both:
 *
 *   1. Check.  ~60 s after the app starts, then every 4 h, when a window
 *      becomes active again more than 1 h after the last check, and on demand
 *      from the command bar, GET <amaya.update.url> (a static latest.json):
 *        {"version": "159.0-3", "prerelease": true,
 *         "files": {"deb": "...deb", "tar": "...tar.xz", "dmg": "...dmg",
 *                   "sums": "SHA256SUMS"}}
 *      ("dmg" is macOS; a manifest without one just never shows an update
 *      there.)  Files are resolved relative to the manifest URL.  The request
 *      carries no cookies, no referrer, no custom headers and no identifiers;
 *      the only thing the server learns is that an Amaya asked (IP + standard
 *      headers).  Checks are shared across windows: the window that runs one
 *      claims it by writing amaya.update.lastCheck (seconds) first.
 *   2. Prompt.  A small card in the sidebar above the spaces switcher (or a
 *      notification bar when the shell is not loaded).  "Later" remembers the
 *      version in amaya.update.dismissed; the next version shows again, and
 *      "Check for updates" in the command bar always shows it.
 *   3. Update.  On Linux, a .deb install with Amaya's apt source
 *      (/etc/apt/sources.list.d/amaya.sources, shipped by the .deb, not set to
 *      "Enabled: no") gets the release through apt, so Update opens the
 *      system updater (update-manager, else GNOME Software's updates page;
 *      started with nsIProcess, no shell) or says to run `sudo apt upgrade`.
 *      Otherwise (the .tar.xz, or the .dmg on macOS) it downloads the file
 *      plus SHA256SUMS into your Downloads folder, verifies the sha256, then
 *      opens the .deb with the desktop's software installer (which asks for
 *      the admin password) or reveals the file so you can unpack/mount it by
 *      hand.  Nothing is installed by Amaya itself.
 *
 * Prefs:
 *   amaya.update.enabled        bool, default true   automatic checks
 *   amaya.update.url            string               manifest URL (https; http
 *                                                    only for loopback, tests)
 *   amaya.update.lastCheck      int (unix seconds)   last check, any window
 *   amaya.update.dismissed      string               version hidden by "Later"
 *   amaya.update.latest         string (JSON)        newest manifest seen, so
 *                                                    every window shows it
 *   amaya.update.currentVersion string  DEVELOPMENT ONLY: used only when
 *                                       <ui dir>/version.json is missing
 *   amaya.update.installType    "apt" | "deb" | "tar" | "dmg"  DEVELOPMENT/TEST
 *                                       override ("apt" = .deb with the apt
 *                                       source)
 *
 * The current version comes from <ui dir>/version.json, written by
 * `tools/amaya stage` from upstream.json.  Without it (a development run with
 * AMAYA_UI_DIR) the version is unknown and nothing is ever prompted.
 *
 * In headless runs (MOZ_HEADLESS) the downloaded file is never launched or
 * revealed and no updater is started; the state records what would have
 * happened.
 */
(function () {
  "use strict";

  const NAME = "update";
  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs"
  );
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const IS_MAC = AppConstants.platform == "macosx";

  const PREF = {
    enabled: "amaya.update.enabled",
    url: "amaya.update.url",
    lastCheck: "amaya.update.lastCheck",
    dismissed: "amaya.update.dismissed",
    latest: "amaya.update.latest",
    current: "amaya.update.currentVersion",
    installType: "amaya.update.installType",
  };
  const DEFAULT_URL = "https://amaya.arghyam.me/downloads/latest.json";
  const NOTES_URL = "https://github.com/amukherjee1991/amaya-browser/releases/tag/v";
  const DEB_PREFIX = "/usr/lib/amaya";
  const FIRST_DELAY_MS = 60 * 1000;
  const INTERVAL_MS = 4 * 60 * 60 * 1000;
  // A window becoming active re-checks when the last check is this old.
  const FOCUS_STALE_MS = 60 * 60 * 1000;
  const APT_SOURCES = "/etc/apt/sources.list.d/amaya.sources";
  // apt's downloaded copy of our package index (apt refreshes it on its own
  // schedule); apt installs read it instead of asking the server themselves.
  const APT_LISTS = "/var/lib/apt/lists";
  const APT_INDEX_RE = /^amaya\.arghyam\.me_apt_dists_stable_.*_Packages$/;
  // System updaters for apt installs, in order of preference.
  const UPDATERS = [
    ["/usr/bin/update-manager", []],
    ["/usr/bin/gnome-software", ["--mode=updates"]],
  ];
  const TICK_MS = 60 * 1000;
  const TOPIC = "amaya-update-state";
  const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,200}$/;
  const SVG_NS = "http://www.w3.org/2000/svg";

  const prefs = Services.prefs;
  const doc = document;
  const h = ui.h;
  const log = (...a) => ui.log(NAME, ...a);

  /* ---------------------------------------------------------------- *
   * Versions and manifests
   * ---------------------------------------------------------------- */

  // "159.0-3" -> { parts: [159, 0], rev: 3 }; anything else -> null.
  function parseVersion(v) {
    const m = /^(\d+(?:\.\d+)*)-(\d+)$/.exec(String(v ?? "").trim());
    if (!m) {
      return null;
    }
    return { parts: m[1].split(".").map(Number), rev: Number(m[2]) };
  }

  // <0 if a is older than b, 0 if equal, >0 if newer.  Unparsable = oldest.
  function compareVersions(a, b) {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (!pa || !pb) {
      return (pa ? 1 : 0) - (pb ? 1 : 0);
    }
    const n = Math.max(pa.parts.length, pb.parts.length);
    for (let i = 0; i < n; i++) {
      const d = (pa.parts[i] || 0) - (pb.parts[i] || 0);
      if (d) {
        return d;
      }
    }
    return pa.rev - pb.rev;
  }

  function validName(n) {
    return typeof n == "string" && FILE_NAME_RE.test(n) ? n : null;
  }

  // Checks a parsed latest.json and keeps only what we use.
  function cleanManifest(data, base) {
    if (!data || typeof data != "object" || !parseVersion(data.version)) {
      return null;
    }
    const f = data.files && typeof data.files == "object" ? data.files : {};
    return {
      version: String(data.version).trim(),
      prerelease: !!data.prerelease,
      published_at: typeof data.published_at == "string" ? data.published_at : "",
      files: { deb: validName(f.deb), tar: validName(f.tar), dmg: validName(f.dmg), sums: validName(f.sums) },
      base,
    };
  }

  function storedManifest() {
    try {
      const raw = prefs.getStringPref(PREF.latest, "");
      if (!raw) {
        return null;
      }
      const data = JSON.parse(raw);
      return cleanManifest(data, typeof data.base == "string" ? data.base : updateURL());
    } catch (e) {
      return null;
    }
  }

  // `sha256sum` output: "<hex>  <name>" or "<hex> *<name>" per line.
  function parseSums(text, name) {
    for (const line of String(text).split(/\r?\n/)) {
      const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
      if (m && (m[2] === name || m[2] === `./${name}`)) {
        return m[1].toLowerCase();
      }
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Environment
   * ---------------------------------------------------------------- */

  function updateURL() {
    return prefs.getStringPref(PREF.url, "") || DEFAULT_URL;
  }

  // https anywhere; plain http only to this machine (local testing).
  function allowedURL(spec) {
    try {
      const u = new URL(spec);
      if (u.protocol === "https:") {
        return true;
      }
      return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    } catch (e) {
      return false;
    }
  }

  function enabled() {
    return prefs.getBoolPref(PREF.enabled, true);
  }

  let currentVersionPromise = null;
  function currentVersion() {
    currentVersionPromise ||= (async () => {
      try {
        const dir = Services.io.newURI(ui.dirURL).QueryInterface(Ci.nsIFileURL).file.path;
        const data = await IOUtils.readJSON(PathUtils.join(dir, "version.json"));
        if (parseVersion(data?.version)) {
          return String(data.version).trim();
        }
        log("version.json has no valid version; update checks are off");
        return null;
      } catch (e) {
        // Development run (no staged version.json): only the explicit dev
        // override can enable checks.
        const dev = prefs.getStringPref(PREF.current, "");
        return parseVersion(dev) ? dev.trim() : null;
      }
    })();
    return currentVersionPromise;
  }

  // "apt" (a .deb with Amaya's apt source), "deb" or "tar".  The apt part
  // is read from disk by refreshApt(); this stays synchronous for rendering.
  let aptSource = false;
  function installType() {
    const o = prefs.getStringPref(PREF.installType, "");
    if (o === "apt" || o === "deb" || o === "tar" || o === "dmg") {
      return o;
    }
    const type = packagedType();
    return type === "deb" && aptSource ? "apt" : type;
  }

  // Is /etc/apt/sources.list.d/amaya.sources there and not disabled?
  async function refreshApt() {
    let on = false;
    if (packagedType() === "deb") {
      try {
        const text = await IOUtils.readUTF8(APT_SOURCES);
        on = !/^\s*Enabled:\s*no\s*$/im.test(text);
      } catch (e) {
        // No source (an older .deb, or removed by hand): download instead.
      }
    }
    if (on !== aptSource) {
      aptSource = on;
      render();
    }
    return on;
  }

  function packagedType() {
    if (IS_MAC) {
      return "dmg";
    }
    let dir = "";
    try {
      dir = Services.dirsvc.get("GreD", Ci.nsIFile).path;
    } catch (e) {}
    return dir === DEB_PREFIX || dir.startsWith(DEB_PREFIX + "/") ? "deb" : "tar";
  }

  // Debian version "159.0.0.6-1" -> Amaya version "159.0-6".
  function fromDebVersion(v) {
    const m = /^(\d+(?:\.\d+)*)\.(\d+)-\d+$/.exec(String(v ?? "").trim());
    if (!m) {
      return null;
    }
    const parts = m[1].split(".");
    while (parts.length > 2 && parts[parts.length - 1] === "0") {
      parts.pop();
    }
    return `${parts.join(".")}-${m[2]}`;
  }

  // Newest Amaya version in apt's local copy of our index, "" if the index
  // is there but lists no amaya, null if there is no (uncompressed) index.
  async function aptIndexVersion() {
    let names;
    try {
      names = (await IOUtils.getChildren(APT_LISTS)).map(p => PathUtils.filename(p));
    } catch (e) {
      return null;
    }
    const files = names.filter(n => APT_INDEX_RE.test(n));
    if (!files.length) {
      return null;
    }
    let best = "";
    for (const name of files) {
      const text = await IOUtils.readUTF8(PathUtils.join(APT_LISTS, name));
      for (const stanza of text.split(/\n\s*\n/)) {
        if (!/^Package:\s*amaya\s*$/m.test(stanza)) {
          continue;
        }
        const v = fromDebVersion(/^Version:\s*(\S+)\s*$/m.exec(stanza)?.[1]);
        if (v && (!best || compareVersions(v, best) > 0)) {
          best = v;
        }
      }
    }
    return best;
  }

  function headless() {
    try {
      return Services.env.exists("MOZ_HEADLESS") && Services.env.get("MOZ_HEADLESS") !== "0";
    } catch (e) {
      return false;
    }
  }

  async function fetchOk(spec, extra = {}) {
    const res = await fetch(spec, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      redirect: "follow",
      ...extra,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${spec}`);
    }
    if (res.url && !allowedURL(res.url)) {
      throw new Error(`redirected to a disallowed URL: ${res.url}`);
    }
    return res;
  }

  /* ---------------------------------------------------------------- *
   * State
   *
   * `latest` (pref, shared) says what is available.  `state` (per window,
   * broadcast to other windows for downloads) says what is happening:
   *   null | {phase: "info", text} | {phase: "downloading", received, total}
   *   | {phase: "verifying"} | {phase: "failed", reason} | {phase: "ready", ...}
   * ---------------------------------------------------------------- */

  let state = null;
  let current = null; // resolved current version (or null)
  let forceShow = false; // set by an on-demand check: ignore "Later"
  let checking = false;
  let downloadAbort = null; // AbortController while this window downloads
  let lastNotes = null;

  function setState(next, { broadcast = false } = {}) {
    state = next;
    if (broadcast) {
      Services.obs.notifyObservers(null, TOPIC, JSON.stringify({ from: windowId, state: next }));
    }
    render();
  }

  const windowId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function available() {
    const m = storedManifest();
    if (!m || !current || compareVersions(m.version, current) <= 0) {
      return null;
    }
    return m;
  }

  function showAvailable() {
    const m = available();
    if (!m || (!enabled() && !forceShow)) {
      return null;
    }
    if (!forceShow && prefs.getStringPref(PREF.dismissed, "") === m.version) {
      return null;
    }
    return m;
  }

  function busy() {
    return state && (state.phase === "downloading" || state.phase === "verifying");
  }

  /* ---------------------------------------------------------------- *
   * Checking
   * ---------------------------------------------------------------- */

  async function check({ manual = false } = {}) {
    if (checking) {
      return { result: "busy" };
    }
    checking = true;
    try {
      current = await currentVersion();
      if (!current) {
        if (manual) {
          setState({ phase: "info", text: "Amaya can't tell which version this is, so it can't check for updates." });
        }
        return { result: "unknown-version" };
      }
      if (Services.io.offline) {
        if (manual) {
          setState({ phase: "info", text: "You're offline. Check again when you're connected." });
        }
        return { result: "offline" };
      }
      const url = updateURL();
      if (!allowedURL(url)) {
        log(`amaya.update.url is not https: ${url}`);
        if (manual) {
          setState({ phase: "info", text: "Couldn't check for updates. Try again later." });
        }
        return { result: "bad-url" };
      }
      prefs.setIntPref(PREF.lastCheck, Math.floor(Date.now() / 1000));
      await refreshApt();
      let manifest;
      // apt installs: apt already fetches our index, so read its copy and
      // make no request of our own. An explicit check still asks the server.
      if (!manual && installType() === "apt") {
        try {
          const v = await aptIndexVersion();
          if (v !== null) {
            manifest = cleanManifest({ version: v || current }, url);
          }
        } catch (e) {
          log(`apt index: ${e}`);
        }
      }
      if (!manifest) {
        try {
          const res = await fetchOk(url);
          manifest = cleanManifest(await res.json(), res.url || url);
        } catch (e) {
          log(`update check failed: ${e}`);
        }
      }
      if (!manifest) {
        if (manual) {
          setState({ phase: "info", text: "Couldn't check for updates. Try again later." });
        }
        return { result: "error" };
      }
      if (compareVersions(manifest.version, current) > 0) {
        if (manual) {
          forceShow = true;
          if (state?.phase === "info") {
            state = null;
          }
        }
        // The pref observer renders the card in every window.
        prefs.setStringPref(PREF.latest, JSON.stringify(manifest));
        render();
        return { result: "available", version: manifest.version };
      }
      if (prefs.prefHasUserValue(PREF.latest)) {
        prefs.clearUserPref(PREF.latest);
      }
      if (manual) {
        setState({ phase: "info", text: `You're on the latest version (${current}).` });
      }
      return { result: "latest", version: current };
    } finally {
      checking = false;
    }
  }

  // Scheduled checks: ~60 s after the app starts, then every 4 h.  Every
  // window ticks; the first one that finds a check due claims it by writing
  // amaya.update.lastCheck before it fetches (same thread, so no race).
  function processStart() {
    try {
      const t = Services.startup.getStartupInfo().process;
      if (t) {
        return t.getTime();
      }
    } catch (e) {}
    return loadTime;
  }
  const loadTime = Date.now();

  function checkDue(now = Date.now()) {
    if (!enabled()) {
      return false;
    }
    const start = processStart();
    if (now - start < FIRST_DELAY_MS) {
      return false;
    }
    const last = prefs.getIntPref(PREF.lastCheck, 0) * 1000;
    return last < start || now - last >= INTERVAL_MS || last > now + INTERVAL_MS;
  }

  // When a window becomes active: check if the last one is over an hour old.
  function focusDue(now = Date.now()) {
    if (!enabled() || now - processStart() < FIRST_DELAY_MS) {
      return false;
    }
    const last = prefs.getIntPref(PREF.lastCheck, 0) * 1000;
    return now - last >= FOCUS_STALE_MS || last > now + FOCUS_STALE_MS;
  }

  function tick() {
    if (!checking && checkDue()) {
      check().catch(e => log(`check: ${e}`));
    }
  }

  function onActivate() {
    if (!checking && focusDue()) {
      check().catch(e => log(`check: ${e}`));
    }
  }

  /* ---------------------------------------------------------------- *
   * Downloading
   * ---------------------------------------------------------------- */

  function hex(bin) {
    let out = "";
    for (let i = 0; i < bin.length; i++) {
      out += bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return out;
  }

  async function startUpdate() {
    const m = available();
    if (!m || busy()) {
      return { result: busy() ? "busy" : "none" };
    }
    await refreshApt();
    const type = installType();
    if (type === "apt") {
      return openSystemUpdater(m);
    }
    const name = m.files[type];
    if (!name || !m.files.sums) {
      openNotes(m.version);
      return { result: "no-file", type };
    }
    const ac = new AbortController();
    downloadAbort = ac;
    const progress = { phase: "downloading", version: m.version, type, name, received: 0, total: 0 };
    setState({ ...progress }, { broadcast: true });
    let part = null;
    try {
      const sumsRes = await fetchOk(new URL(m.files.sums, m.base).href, { signal: ac.signal });
      const expected = parseSums(await sumsRes.text(), name);
      if (!expected) {
        setState({ phase: "failed", reason: "nosum", version: m.version }, { broadcast: true });
        return { result: "nosum" };
      }
      const dir = await Downloads.getPreferredDownloadsDirectory();
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const dest = PathUtils.join(dir, name);
      part = `${dest}.part`;

      const res = await fetchOk(new URL(name, m.base).href, { signal: ac.signal });
      progress.total = Number(res.headers.get("content-length")) || 0;
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(Ci.nsICryptoHash.SHA256);
      await IOUtils.write(part, new Uint8Array(0), { mode: "overwrite" });
      const reader = res.body.getReader();
      let pending = [];
      let pendingBytes = 0;
      let lastPaint = 0;
      const flush = async () => {
        if (!pendingBytes) {
          return;
        }
        const buf = new Uint8Array(pendingBytes);
        let off = 0;
        for (const c of pending) {
          buf.set(c, off);
          off += c.length;
        }
        pending = [];
        pendingBytes = 0;
        await IOUtils.write(part, buf, { mode: "append" });
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        hash.update(value, value.length);
        pending.push(value);
        pendingBytes += value.length;
        progress.received += value.length;
        if (pendingBytes >= 1 << 20) {
          await flush();
        }
        if (Date.now() - lastPaint > 200) {
          lastPaint = Date.now();
          setState({ ...progress }, { broadcast: true });
        }
      }
      await flush();
      setState({ phase: "verifying", version: m.version, type, name }, { broadcast: true });
      const actual = hex(hash.finish(false));
      if (actual !== expected) {
        await IOUtils.remove(part, { ignoreAbsent: true });
        part = null;
        log(`checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
        setState({ phase: "failed", reason: "checksum", version: m.version }, { broadcast: true });
        return { result: "checksum" };
      }
      await IOUtils.move(part, dest);
      part = null;
      return finish(m, type, dest);
    } catch (e) {
      if (part) {
        await IOUtils.remove(part, { ignoreAbsent: true }).catch(() => {});
      }
      if (ac.signal.aborted) {
        setState(null, { broadcast: true });
        return { result: "cancelled" };
      }
      log(`download failed: ${e}`);
      setState({ phase: "failed", reason: "network", version: m.version }, { broadcast: true });
      return { result: "failed", error: String(e) };
    } finally {
      if (downloadAbort === ac) {
        downloadAbort = null;
      }
    }
  }

  function localFile(path) {
    const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    f.initWithPath(path);
    return f;
  }

  // Hand the verified file to the desktop.  Headless runs never launch.
  function finish(m, type, path) {
    let opened = false;
    const skipped = headless();
    if (!skipped) {
      const file = localFile(path);
      if (type === "deb") {
        try {
          file.launch();
          opened = true;
        } catch (e) {
          log(`no handler for .deb files: ${e}`);
          try {
            file.reveal();
          } catch (e2) {}
        }
      } else {
        try {
          file.reveal();
        } catch (e) {
          log(`cannot reveal ${path}: ${e}`);
        }
      }
    }
    const next = { phase: "ready", version: m.version, type, path, name: PathUtils.filename(path), opened, skipped };
    setState(next, { broadcast: true });
    return { result: "ready", type, path, opened, launchSkipped: skipped };
  }

  // apt installs: hand over to the system updater, which installs from
  // Amaya's apt repository with the admin password.  nsIProcess runs the
  // program directly (no shell) and does not wait for it.
  function openSystemUpdater(m) {
    const skipped = headless();
    for (const [path, args] of UPDATERS) {
      let file;
      try {
        file = localFile(path);
        if (!file.exists() || !file.isExecutable()) {
          continue;
        }
      } catch (e) {
        continue;
      }
      if (!skipped) {
        try {
          const proc = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
          proc.init(file);
          proc.runAsync(args, args.length);
        } catch (e) {
          log(`cannot start ${path}: ${e}`);
          continue;
        }
      }
      const app = path.endsWith("/update-manager") ? "Software Updater" : "Software";
      setState({ phase: "handed-off", version: m.version, app, path, skipped }, { broadcast: true });
      return { result: "updater", path, launchSkipped: skipped };
    }
    setState({ phase: "handed-off", version: m.version, app: null, path: null, skipped }, { broadcast: true });
    return { result: "no-updater" };
  }

  function revealFile(path) {
    if (headless()) {
      return;
    }
    try {
      localFile(path).reveal();
    } catch (e) {
      log(`cannot reveal ${path}: ${e}`);
    }
  }

  function cancelDownload() {
    if (downloadAbort) {
      downloadAbort.abort();
    } else {
      setState(null, { broadcast: true });
    }
  }

  function restart() {
    const cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(Ci.nsISupportsPRBool);
    Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
    if (cancel.data) {
      return;
    }
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
  }

  function openNotes(version) {
    lastNotes = NOTES_URL + encodeURIComponent(version);
    window.openTrustedLinkIn(lastNotes, "tab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  function later(version) {
    forceShow = false;
    prefs.setStringPref(PREF.dismissed, version);
    if (state && state.phase !== "downloading" && state.phase !== "verifying") {
      setState(null);
    } else {
      render();
    }
  }

  function close() {
    forceShow = false;
    setState(null);
  }

  /* ---------------------------------------------------------------- *
   * View model: what to show, shared by the card and the bar
   * ---------------------------------------------------------------- */

  function mb(bytes) {
    const v = bytes / (1024 * 1024);
    return v >= 10 ? Math.round(v).toString() : v.toFixed(1);
  }

  function viewModel() {
    const s = state;
    if (s?.phase === "info") {
      return { kind: "info", text: s.text, actions: [], closable: true };
    }
    if (s?.phase === "downloading") {
      const pct = s.total ? Math.min(100, Math.round((s.received / s.total) * 100)) : null;
      return {
        kind: "progress",
        title: `Downloading Amaya ${s.version}`,
        text: s.total ? `${mb(s.received)} of ${mb(s.total)} MB` : `${mb(s.received)} MB`,
        progress: pct,
        actions: [{ label: "Cancel", kind: "quiet", run: cancelDownload }],
      };
    }
    if (s?.phase === "verifying") {
      return { kind: "progress", title: "Checking the download", text: "Comparing it with the published checksum.", progress: null, actions: [] };
    }
    if (s?.phase === "failed") {
      const text = {
        checksum: "The download didn't match its checksum. Nothing was installed.",
        nosum: "The release has no checksum for this file. Nothing was installed.",
        network: "The download stopped. Nothing was installed.",
      }[s.reason] || "Nothing was installed.";
      return {
        kind: "failed",
        title: "Update not installed",
        text,
        actions: [
          { label: "Try again", kind: "primary", run: startUpdate },
          { label: "Close", kind: "quiet", run: close },
        ],
      };
    }
    if (s?.phase === "handed-off") {
      return {
        kind: "ready",
        title: s.app ? `Finish in ${s.app}` : `Install Amaya ${s.version}`,
        text: s.app
          ? `Install Amaya ${s.version} there, then restart Amaya.`
          : "Run \u201Csudo apt upgrade\u201D in a terminal, then restart Amaya.",
        actions: [{ label: "Restart Amaya", kind: "primary", run: restart }],
        closable: true,
      };
    }
    if (s?.phase === "ready") {
      let text;
      if (s.type === "deb") {
        text = s.opened || s.skipped
          ? "Finish in your software installer, then restart Amaya."
          : `Open ${s.name} in your Downloads folder with your software installer, then restart Amaya.`;
      } else if (s.type === "dmg") {
        text = `Open ${s.name}, drag Amaya to Applications to replace the old one, then restart Amaya.`;
      } else {
        text = `Unpack ${s.name} over your current Amaya folder, then restart.`;
      }
      return {
        kind: "ready",
        title: `Amaya ${s.version} is downloaded`,
        text,
        actions: [
          { label: "Restart Amaya", kind: "primary", run: restart },
          { label: "Show file", kind: "quiet", run: () => revealFile(s.path) },
        ],
        closable: true,
      };
    }
    const m = showAvailable();
    if (m) {
      return {
        kind: "available",
        title: `Amaya ${m.version} is ready`,
        text: installType() === "apt" ? "Install it with Software Updater." : `You have ${current}.`,
        actions: [
          { label: "Update", kind: "primary", run: startUpdate },
          { label: "Later", kind: "quiet", run: () => later(m.version) },
        ],
        notes: m.version,
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------- *
   * Rendering: card in the sidebar, or a notification bar
   * ---------------------------------------------------------------- */

  let card = null;
  let shellChecked = false;
  let barShown = false;
  let collapseBtn = null;

  function svgIcon(body) {
    const src =
      `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" width="16" height="16" fill="none" ` +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true" class="amaya-ico">${body}</svg>`;
    return doc.importNode(new DOMParser().parseFromString(src, "image/svg+xml").documentElement, true);
  }
  const ICON_UPDATE = '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>';

  function button(action) {
    return h(
      "button",
      {
        type: "button",
        class: ["amaya-update__btn", `amaya-update__btn--${action.kind}`],
        onclick: e => {
          e.stopPropagation();
          Promise.resolve(action.run()).catch(err => log(`${action.label}: ${err}`));
        },
      },
      action.label
    );
  }

  function buildCard(vm) {
    const body = [];
    const head = h("div", { class: "amaya-update__head" });
    if (vm.kind !== "info") {
      head.append(h("span", { class: "amaya-update__icon" }, svgIcon(ICON_UPDATE)));
      head.append(h("span", { class: "amaya-update__title", id: "amaya-update-title" }, vm.title));
    } else {
      head.append(h("span", { class: "amaya-update__text amaya-update__text--info", id: "amaya-update-title" }, vm.text));
    }
    if (vm.closable) {
      const x = h(
        "button",
        { type: "button", class: "amaya-update__close", "aria-label": "Close", title: "Close", onclick: () => close() },
        ui.icon("close", 14)
      );
      head.append(x);
    }
    body.push(head);
    if (vm.kind !== "info" && vm.text) {
      body.push(h("p", { class: "amaya-update__text" }, vm.text));
    }
    if (vm.kind === "progress") {
      const bar = h("div", {
        class: ["amaya-update__bar", vm.progress == null && "is-indeterminate"],
        role: "progressbar",
        "aria-labelledby": "amaya-update-title",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": vm.progress == null ? null : String(vm.progress),
      });
      bar.append(h("span", { class: "amaya-update__fill", style: vm.progress == null ? null : { width: `${vm.progress}%` } }));
      body.push(bar);
    }
    if (vm.actions.length || vm.notes) {
      const row = h("div", { class: "amaya-update__actions" });
      vm.actions.forEach(a => row.append(button(a)));
      if (vm.notes) {
        row.append(
          h(
            "button",
            { type: "button", class: "amaya-update__link", onclick: () => openNotes(vm.notes) },
            "Release notes"
          )
        );
      }
      body.push(row);
    }
    return body;
  }

  function sidebarHost() {
    const footer = ui.anchor("amaya-sidebar-footer");
    const sidebar = ui.anchor("amaya-sidebar");
    return footer && sidebar && footer.parentNode === sidebar ? { sidebar, footer } : null;
  }

  function setDot(on) {
    doc.documentElement.toggleAttribute("amaya-update-dot", on);
    collapseBtn ||= doc.getElementById("amaya-collapse-button");
    if (collapseBtn) {
      if (on) {
        collapseBtn.setAttribute("aria-description", "Amaya update available");
      } else {
        collapseBtn.removeAttribute("aria-description");
      }
    }
  }

  let destroyed = false;

  function render() {
    if (destroyed) {
      return;
    }
    const vm = viewModel();
    const host = sidebarHost();
    if (!vm) {
      card?.remove();
      card = null;
      removeBar();
      setDot(false);
      return;
    }
    if (host) {
      removeBar();
      const live = vm.kind === "info" || vm.kind === "failed" || vm.kind === "ready";
      if (!card) {
        card = h("section", {
          id: "amaya-update-card",
          class: "amaya-update",
          "aria-labelledby": "amaya-update-title",
        });
      }
      card.dataset.kind = vm.kind;
      card.setAttribute("role", live ? "status" : "region");
      const focused = card.contains(doc.activeElement);
      card.replaceChildren(...buildCard(vm));
      if (card.parentNode !== host.sidebar || card.nextSibling !== host.footer) {
        host.sidebar.insertBefore(card, host.footer);
      }
      if (focused) {
        card.querySelector("button")?.focus();
      }
      setDot(vm.kind === "available" || vm.kind === "ready" || vm.kind === "progress");
      return;
    }
    card?.remove();
    card = null;
    setDot(false);
    if (shellChecked) {
      renderBar(vm);
    }
  }

  /* Fallback without the shell: Firefox's top-of-window notification bar. */
  let barKey = "";
  function renderBar(vm) {
    const box = window.gNotificationBox;
    if (!box) {
      return;
    }
    const label = vm.kind === "info" ? vm.text : `${vm.title}. ${vm.text}`;
    const key = `${vm.kind}|${label}`;
    if (barShown && key === barKey) {
      return;
    }
    removeBar();
    barKey = key;
    const buttons = vm.actions.map(a => ({
      label: a.label,
      callback: () => {
        Promise.resolve(a.run()).catch(err => log(`${a.label}: ${err}`));
        return true; // keep open; render() replaces or removes it
      },
    }));
    if (vm.notes) {
      buttons.push({ label: "Release notes", callback: () => (openNotes(vm.notes), true) });
    }
    try {
      const p = box.appendNotification(
        "amaya-update",
        { label, priority: box.PRIORITY_INFO_MEDIUM, eventCallback: ev => {
          if (ev === "dismissed") {
            barShown = false;
            if (vm.kind === "available") {
              later(vm.notes);
            } else if (!busy()) {
              close();
            }
          }
        } },
        buttons
      );
      barShown = true;
      Promise.resolve(p).catch(e => log(`notification: ${e}`));
    } catch (e) {
      log(`notification: ${e}`);
    }
  }

  function removeBar() {
    if (!barShown) {
      return;
    }
    barShown = false;
    barKey = "";
    try {
      const box = window.gNotificationBox;
      const n = box?.getNotificationWithValue("amaya-update");
      if (n) {
        box.removeNotification(n, true);
      }
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * Command bar
   * ---------------------------------------------------------------- */

  const commands = [
    {
      id: "update.check",
      label: "Check for updates",
      icon: svgIcon(ICON_UPDATE),
      keywords: ["update", "upgrade", "version", "new version", "about amaya"],
      run: () => check({ manual: true }),
    },
    {
      id: "update.install",
      label: "Update Amaya",
      icon: svgIcon(ICON_UPDATE),
      hint: () => available()?.version || "",
      keywords: ["upgrade", "install update", "new version"],
      when: () => !!available() && !busy(),
      run: () => {
        forceShow = true;
        return startUpdate();
      },
    },
  ];

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  const timers = [];
  const prefObserver = { observe: () => render() };
  const stateObserver = {
    observe(subject, topic, data) {
      try {
        const msg = JSON.parse(data);
        if (msg.from !== windowId) {
          state = msg.state;
          render();
        }
      } catch (e) {}
    },
  };
  let cancelAnchor = null;

  ui.register(NAME, {
    init() {
      for (const p of [PREF.latest, PREF.dismissed, PREF.enabled]) {
        prefs.addObserver(p, prefObserver);
      }
      Services.obs.addObserver(stateObserver, TOPIC);

      (ui.commands ||= []).push(...commands);

      currentVersion().then(v => {
        current = v;
        // A stored manifest that is not newer (we were updated): forget it.
        const m = storedManifest();
        if (m && v && compareVersions(m.version, v) <= 0 && prefs.prefHasUserValue(PREF.latest)) {
          prefs.clearUserPref(PREF.latest);
        }
        render();
      });

      // The shell may build the sidebar after us; without the shell, fall
      // back to the notification bar once every module has loaded.
      cancelAnchor = ui.whenAnchor("amaya-sidebar-footer", () => render());
      Promise.resolve(ui.ready).then(() => {
        shellChecked = true;
        render();
      });

      const start = processStart();
      const firstIn = Math.max(1000, start + FIRST_DELAY_MS + 1000 - Date.now());
      timers.push(setTimeout(tick, firstIn));
      timers.push(setInterval(tick, TICK_MS));
      window.addEventListener("activate", onActivate);
      refreshApt().catch(e => log(`apt source: ${e}`));
    },

    uninit() {
      destroyed = true;
      window.removeEventListener("activate", onActivate);
      for (const t of timers.splice(0)) {
        clearTimeout(t);
        clearInterval(t);
      }
      for (const p of [PREF.latest, PREF.dismissed, PREF.enabled]) {
        prefs.removeObserver(p, prefObserver);
      }
      try {
        Services.obs.removeObserver(stateObserver, TOPIC);
      } catch (e) {}
      cancelAnchor?.();
      if (downloadAbort) {
        downloadAbort.abort();
      }
      if (ui.commands) {
        for (const c of commands) {
          const i = ui.commands.indexOf(c);
          if (i >= 0) {
            ui.commands.splice(i, 1);
          }
          ui.emit("unregister-command", { id: c.id });
        }
      }
      card?.remove();
      card = null;
      removeBar();
      setDot(false);
      delete ui.update;
    },
  });

  // For the command bar, tests and other modules.
  ui.update = {
    check: opts => check(opts),
    update: () => startUpdate(),
    cancel: () => cancelDownload(),
    later: () => {
      const m = available();
      if (m) {
        later(m.version);
      }
    },
    get state() {
      return { state, available: available()?.version || null, current, shown: viewModel()?.kind || null, installType: installType(), lastNotes };
    },
    checkDue: now => checkDue(now),
    focusDue: now => focusDue(now),
    compareVersions,
    parseSums,
  };
})();
