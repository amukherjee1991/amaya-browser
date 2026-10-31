/* Amaya UI module "home": the new tab page and first-run setup.
 *
 * Runs in every browser window's (privileged) scope; see ui/README.md.
 *
 * New tab page
 * ------------
 * The page itself is unprivileged: newtab.html/.css/.js in this folder, shown
 * as an ordinary file:// page in a content process.  It cannot ask the browser
 * for anything, so the privileged data it shows (default search engine, your
 * sites with their cached icons, this week's tracker count) is written into
 * the page ahead of time:
 *
 *   home.js reads newtab.html (the template), fills in a <base> pointing back
 *   at this folder and a JSON block, and writes the result atomically to
 *   <profile>/amaya/home/newtab.html.  That file is the new tab page
 *   (AboutNewTab.newTabURL) and the default home page.
 *
 * Why this way: no JSWindowActor (needs a resource:/chrome: module), no frame
 * scripts, no URL parameters (the address field treats the new tab URL as
 * "empty" only when it matches exactly), and no fetch from the page (file://
 * pages are opaque origins and the page's CSP has no network sources).  The
 * file is rewritten when it can be stale: at startup, after each new tab page
 * loads (so the next one is fresh), when the theme, default engine or a
 * setting changes, and every 5 minutes.  Data can be a few minutes old; the
 * weekly count does not need to be live.
 *
 * The page talks back only by setting its own fragment
 * (#amaya-pin=..., #amaya-remove=..., #amaya-search=...).  A tabs progress
 * listener here sees that same-document navigation, acts, rewrites the file
 * and reloads the page without the fragment.  Only the page itself can set
 * its fragment (web pages cannot navigate to file: URLs), and every command is
 * validated (http/https URLs only).
 *
 * First run
 * ---------
 * A centred card over the window, four steps, shown once
 * (pref amaya.ui.home.onboarded).  Choices are applied when you press
 * Continue; Skip leaves the step's defaults alone.
 *
 * Prefs
 *   amaya.ui.home.onboarded        bool  first-run setup done
 *   amaya.ui.home.newtab.enabled   bool  new tab shows the Amaya page (else blank)
 *   amaya.ui.home.newtab.sites     bool  show your sites
 *   amaya.ui.home.newtab.tally     bool  show "N trackers blocked this week"
 *   amaya.ui.shell.layout          "sidebar" | "toolbar"  (read by shell)
 *   amaya.fingerprinting.mode      "balanced" | "uniform"  (read by amaya.cfg)
 */
(function () {
  "use strict";

  const NAME = "home";
  const ui = window.AmayaUI;
  const HTML_NS = "http://www.w3.org/1999/xhtml";

  const PREF_ONBOARDED = "amaya.ui.home.onboarded";
  const PREF_ENABLED = "amaya.ui.home.newtab.enabled";
  const PREF_SITES = "amaya.ui.home.newtab.sites";
  const PREF_TALLY = "amaya.ui.home.newtab.tally";
  const PREF_LAYOUT = "amaya.ui.shell.layout";
  const PREF_FP = "amaya.fingerprinting.mode";
  const PREF_HOMEPAGE = "browser.startup.homepage";

  const REFRESH_MS = 5 * 60 * 1000;
  const FADE_MS = 180;
  const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";

  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
    MigrationUtils: "moz-src:///browser/components/migration/MigrationUtils.sys.mjs",
    NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  });

  /* Search engines offered at first run.  None is pre-selected and Amaya has
   * no partner code with any of them.  Engines Amaya ships hidden (Google,
   * Bing) are added as plain user engines without Mozilla's partner codes,
   * under a "(Amaya)" name so they do not clash with the hidden built-ins
   * (same convention as the policy engine "DuckDuckGo (Amaya)").  Adding a
   * user engine makes no network request: its icon comes from the local
   * favicon cache only. */
  const ENGINES = [
    { id: "duckduckgo", label: "DuckDuckGo", host: "duckduckgo.com",
      name: "DuckDuckGo (Amaya)", url: "https://duckduckgo.com/?q={searchTerms}" },
    { id: "startpage", label: "Startpage", host: "startpage.com",
      name: "Startpage", url: "https://www.startpage.com/sp/search?query={searchTerms}" },
    { id: "brave", label: "Brave Search", host: "search.brave.com",
      name: "Brave Search", url: "https://search.brave.com/search?q={searchTerms}" },
    { id: "mojeek", label: "Mojeek", host: "mojeek.com",
      name: "Mojeek", url: "https://www.mojeek.com/search?q={searchTerms}" },
    { id: "google", label: "Google", host: "google.com",
      name: "Google (Amaya)", url: "https://www.google.com/search?q={searchTerms}" },
    { id: "bing", label: "Bing", host: "bing.com",
      name: "Bing (Amaya)", url: "https://www.bing.com/search?q={searchTerms}" },
  ];

  /* Encrypted DNS (DNS over HTTPS).  Same resolvers as doh-rollout.provider-list
   * in amaya.cfg.  Mode 2 = use the resolver, fall back to the system's DNS if
   * it cannot be reached (so a captive portal or a resolver outage does not
   * stop every page loading).  Off = mode 5 ("off by choice"). */
  const RESOLVERS = [
    { id: "off", label: "Off", uri: "" },
    { id: "mullvad", label: "Mullvad", uri: "https://dns.mullvad.net/dns-query" },
    { id: "quad9", label: "Quad9", uri: "https://dns.quad9.net/dns-query" },
    { id: "nextdns", label: "NextDNS", uri: "https://firefox.dns.nextdns.io/" },
  ];

  const ICONS = {
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  };

  const log = (...args) => (ui && ui.log ? ui.log(NAME, ...args) : console.log(`[amaya-ui:${NAME}]`, ...args));
  const prefs = Services.prefs;
  const boolPref = (name, dflt) => prefs.getBoolPref(name, dflt);

  /* ---------------------------------------------------------------- paths */

  function moduleDirURL() {
    let base = ui && ui.dirURL ? ui.dirURL : "";
    if (base && !base.endsWith("/")) {
      base += "/";
    }
    return base + "modules/home/";
  }
  const pageDir = () => PathUtils.join(PathUtils.profileDir, "amaya", "home");
  const pagePath = () => PathUtils.join(pageDir(), "newtab.html");
  const pageURL = () => PathUtils.toFileURI(pagePath());

  function isOurPage(uri) {
    try {
      return !!uri && uri.schemeIs("file") && uri.specIgnoringRef === pageURL();
    } catch (e) {
      return false;
    }
  }

  /* ----------------------------------------------------------- page data */

  function displayEngineName(name) {
    return String(name || "").replace(/ \(Amaya\)$/, "");
  }

  function shortHost(url) {
    try {
      const u = Services.io.newURI(url);
      let host = u.host.replace(/^www\./, "");
      try {
        const suffix = Services.eTLD.getPublicSuffix(u);
        if (suffix && host.endsWith("." + suffix) && host.length > suffix.length + 1) {
          host = host.slice(0, -(suffix.length + 1));
        }
      } catch (e) {}
      const label = host.split(".").pop();
      return label ? label.charAt(0).toUpperCase() + label.slice(1) : u.host;
    } catch (e) {
      return url;
    }
  }

  function isWebURL(url) {
    try {
      const u = Services.io.newURI(url);
      return (u.schemeIs("https") || u.schemeIs("http")) && !!u.host;
    } catch (e) {
      return false;
    }
  }

  async function iconFor(url) {
    try {
      const fav = await lazy.PlacesUtils.favicons.getFaviconForPage(Services.io.newURI(url));
      const spec = fav && fav.dataURI && fav.dataURI.spec;
      return spec && spec.startsWith("data:image/") ? spec : null;
    } catch (e) {
      return null;
    }
  }

  async function collectSites() {
    const out = [];
    const seen = new Set();
    const add = (url, label, title, icon) => {
      if (!isWebURL(url) || out.length >= 7) {
        return;
      }
      let key;
      try {
        key = Services.io.newURI(url).host.replace(/^www\./, "");
      } catch (e) {
        return;
      }
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push({ url, label: label || shortHost(url), title: title || url, icon: icon || null });
    };
    const NTU = lazy.NewTabUtils;
    try {
      for (const link of NTU.pinnedLinks.links) {
        if (link && link.url) {
          add(link.url, link.title, link.title, await iconFor(link.url));
        }
      }
    } catch (e) {
      log("pinned sites:", e);
    }
    try {
      const top = await NTU.activityStreamLinks.getTopSites({
        numItems: 12,
        onePerDomain: true,
        includeFavicon: true,
        hideWithSearchParam: "",
      });
      for (const link of top || []) {
        let icon = typeof link.favicon === "string" && link.favicon.startsWith("data:image/") ? link.favicon : null;
        add(link.url, null, link.title, icon || (await iconFor(link.url)));
      }
    } catch (e) {
      log("top sites:", e);
    }
    return out;
  }

  async function weeklyTally() {
    try {
      const tdb = Cc["@mozilla.org/tracking-db-service;1"].getService(Ci.nsITrackingDBService);
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() - 6);
      const rows = await tdb.getEventsByDateRange(from.getTime(), Date.now());
      let n = 0;
      for (const row of rows || []) {
        n += row.getResultByName("count") || 0;
      }
      return n;
    } catch (e) {
      log("tally:", e);
      return null;
    }
  }

  async function searchData() {
    try {
      const SS = lazy.SearchService;
      await SS.init();
      const engine = await SS.getDefault();
      const sub = engine.getSubmission("AMAYATERMS");
      const tpl = sub.uri.spec;
      return {
        name: displayEngineName(engine.name),
        // POST engines cannot be built in the page; it hands the text back.
        template: !sub.postData && tpl.includes("AMAYATERMS") ? tpl.replace("AMAYATERMS", "{searchTerms}") : null,
      };
    } catch (e) {
      log("search:", e);
      return null;
    }
  }

  async function buildData() {
    const show = { sites: boolPref(PREF_SITES, true), tally: boolPref(PREF_TALLY, true) };
    const [search, sites, tally] = await Promise.all([
      searchData(),
      show.sites ? collectSites() : [],
      show.tally ? weeklyTally() : null,
    ]);
    return {
      v: 1,
      generated: Date.now(),
      theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      tzOffset: new Date().getTimezoneOffset(),
      locale: Services.locale.appLocaleAsBCP47,
      cmdKey: AppConstants.platform === "macosx" ? "⌘ K" : "Ctrl K",
      show,
      search,
      sites,
      tally,
    };
  }

  /* ------------------------------------------------------- page writing */

  let templateText = null;
  async function template() {
    if (templateText === null) {
      const file = Services.io.newURI(moduleDirURL() + "newtab.html").QueryInterface(Ci.nsIFileURL).file;
      templateText = await IOUtils.readUTF8(file.path);
    }
    return templateText;
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  let writing = null;
  let writeAgain = false;
  /* Rewrites <profile>/amaya/home/newtab.html.  Coalesces overlapping calls. */
  function writePage() {
    if (writing) {
      writeAgain = true;
      return writing;
    }
    writing = (async () => {
      try {
        do {
          writeAgain = false;
          const [tpl, data] = await Promise.all([template(), buildData()]);
          const json = JSON.stringify(data)
            .replace(/[<\u2028\u2029]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
          const html = tpl
            .replace("<!--amaya:base-->", () => `<base href="${escapeAttr(moduleDirURL())}">`)
            .replace("<!--amaya:data-->", () => json);
          await IOUtils.makeDirectory(pageDir(), { ignoreExisting: true, createAncestors: true });
          await IOUtils.writeUTF8(pagePath(), html, { tmpPath: pagePath() + ".tmp" });
        } while (writeAgain);
      } catch (e) {
        log("could not write the new tab page:", e);
        throw e;
      } finally {
        writing = null;
      }
    })();
    return writing;
  }

  let refreshTimer = null;
  function scheduleWrite(delay = 400) {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      writePage().catch(() => {});
    }, delay);
  }

  /* Only the most recent browser window keeps the file fresh on a timer. */
  const isLeader = () => Services.wm.getMostRecentWindow("navigator:browser") === window;

  /* ------------------------------------------- new tab / home page wiring */

  let originalHomeDefault = null;
  function applyNewTabURL() {
    const enabled = boolPref(PREF_ENABLED, true);
    const defaults = prefs.getDefaultBranch("");
    if (originalHomeDefault === null) {
      const cur = defaults.getStringPref(PREF_HOMEPAGE, "about:home");
      originalHomeDefault = cur.startsWith("file:") ? "about:home" : cur;
    }
    if (enabled) {
      if (lazy.AboutNewTab.newTabURL !== pageURL()) {
        lazy.AboutNewTab.newTabURL = pageURL();
      }
      // Default branch only: never persisted, and a home page you set
      // yourself (a user value) still wins.
      defaults.setStringPref(PREF_HOMEPAGE, pageURL());
    } else {
      lazy.AboutNewTab.newTabURL = "about:blank";
      defaults.setStringPref(PREF_HOMEPAGE, "chrome://browser/content/blanktab.html");
    }
  }

  /* Startup tabs that still show Firefox Home are switched to ours. */
  function replaceStartupTabs() {
    if (!boolPref(PREF_ENABLED, true) || prefs.prefHasUserValue(PREF_HOMEPAGE)) {
      return;
    }
    for (const tab of gBrowser.tabs) {
      const b = tab.linkedBrowser;
      const spec = b.currentURI && b.currentURI.spec;
      if ((spec === "about:home" || spec === "about:newtab") && !b.canGoBack) {
        loadPage(b);
      }
    }
  }

  function loadPage(browser) {
    browser.loadURI(Services.io.newURI(pageURL()), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
    });
  }

  /* --------------------------------------------- commands from the page */

  async function handlePageCommand(browser, ref) {
    const m = /^amaya-(pin|remove|search)=(.*)$/s.exec(ref);
    if (!m) {
      return;
    }
    let value;
    try {
      value = decodeURIComponent(m[2]);
    } catch (e) {
      return;
    }
    const NTU = lazy.NewTabUtils;
    try {
      if (m[1] === "pin") {
        const { url, title } = JSON.parse(value);
        if (isWebURL(url)) {
          const link = { url: Services.io.newURI(url).spec, title: String(title || "").slice(0, 80) || shortHost(url) };
          NTU.blockedLinks.unblock(link);
          NTU.pinnedLinks.pin(link, NTU.pinnedLinks.links.length);
        }
      } else if (m[1] === "remove") {
        if (isWebURL(value)) {
          const link = { url: value };
          if (NTU.pinnedLinks.isPinned(link)) {
            NTU.pinnedLinks.unpin(link);
          } else {
            NTU.blockedLinks.block(link);
          }
        }
      } else if (m[1] === "search") {
        const text = value.trim().slice(0, 2048);
        if (text) {
          const engine = await lazy.SearchService.getDefault();
          const sub = engine.getSubmission(text);
          browser.loadURI(sub.uri, {
            triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            postData: sub.postData,
          });
          return;
        }
      }
    } catch (e) {
      log("page command failed:", e);
    }
    await writePage().catch(() => {});
    if (isOurPage(browser.currentURI)) {
      loadPage(browser);
    }
  }

  const tabsListener = {
    onLocationChange(browser, webProgress, request, location, flags) {
      if (!webProgress.isTopLevel || !isOurPage(location)) {
        return;
      }
      const ref = location.ref;
      if (ref && ref.startsWith("amaya-") &&
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT) {
        handlePageCommand(browser, ref);
      }
    },
    onStateChange(browser, webProgress, request, stateFlags) {
      const WPL = Ci.nsIWebProgressListener;
      if (webProgress.isTopLevel && stateFlags & WPL.STATE_STOP &&
          stateFlags & WPL.STATE_IS_WINDOW && isOurPage(browser.currentURI)) {
        // This one is shown; make the next one fresh.
        scheduleWrite(1500);
      }
    },
  };

  /* -------------------------------------------------------------- DOM */

  function h(tag, props, ...kids) {
    const el = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) {
        continue;
      }
      if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2), v);
      } else if (k === "class") {
        el.className = v;
      } else if (k === "text") {
        el.textContent = v;
      } else if (k === "hidden") {
        el.hidden = !!v;
      } else if (k === "checked" || k === "disabled" || k === "value") {
        el[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid !== null && kid !== undefined && kid !== false) {
        el.append(typeof kid === "string" ? document.createTextNode(kid) : kid);
      }
    }
    return el;
  }

  function icon(name, cls = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", `amaya-home-ico ${cls}`.trim());
    // Static, module-owned markup only.
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg">${ICONS[name] || ""}</svg>`, "image/svg+xml");
    for (const n of [...doc.documentElement.childNodes]) {
      svg.append(document.importNode(n, true));
    }
    return svg;
  }

  function overlayRoot() {
    if (ui && ui.overlayRoot) {
      return ui.overlayRoot;
    }
    let root = document.getElementById("amaya-home-overlay-root");
    if (!root) {
      root = h("div", { id: "amaya-home-overlay-root", class: "amaya-home-overlay-fallback" });
      (document.body || document.documentElement).append(root);
    }
    return root;
  }

  const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function fadeIn(el) {
    if (!reducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FADE_MS, easing: EASE });
    }
  }

  /* A modal card over the window: focus trap, Esc, restores focus. */
  function openDialog(id, labelId, onEscape) {
    document.getElementById(id)?.remove();
    const previous = document.activeElement;
    const card = h("div", {
      class: "amaya-home-card",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": labelId,
    });
    const scrim = h("div", { id, class: "amaya-home-scrim amaya-root" }, card);
    scrim.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      } else if (e.key === "Tab") {
        const f = [...card.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])")]
          .filter(n => !n.disabled && n.getClientRects().length && !n.closest("[hidden]"));
        if (!f.length) {
          return;
        }
        // Radio groups are one tab stop: keep only the checked (or first) one.
        const stops = f.filter(n => n.type !== "radio" || n.checked ||
          !f.some(o => o !== n && o.type === "radio" && o.name === n.name && o.checked) &&
          f.find(o => o.type === "radio" && o.name === n.name) === n);
        const i = stops.indexOf(document.activeElement);
        let next = null;
        if (e.shiftKey && (i <= 0)) {
          next = stops[stops.length - 1];
        } else if (!e.shiftKey && (i === -1 || i === stops.length - 1)) {
          next = stops[0];
        }
        if (next) {
          e.preventDefault();
          next.focus();
        }
      }
    }, true);
    overlayRoot().append(scrim);
    const close = () => {
      scrim.remove();
      try {
        if (previous && previous.isConnected) {
          previous.focus();
        } else {
          gURLBar?.focus();
        }
      } catch (e) {}
    };
    return { scrim, card, close };
  }

  function radioCard({ name, value, checked, title, desc, extra }) {
    const id = `amaya-home-${name}-${value}`;
    return h("label", { class: "amaya-home-option", for: id },
      h("input", { type: "radio", id, name, value, checked: !!checked, class: "amaya-home-radio" }),
      h("span", { class: "amaya-home-option-text" },
        h("span", { class: "amaya-home-option-title", text: title }),
        desc ? h("span", { class: "amaya-home-option-desc", text: desc }) : null,
        extra || null));
  }

  const checkedValue = (root, name) => root.querySelector(`input[name="${name}"]:checked`)?.value || null;

  /* --------------------------------------------------------- first run */

  function currentResolver() {
    const mode = prefs.getIntPref("network.trr.mode", 0);
    if (mode !== 2 && mode !== 3) {
      return "off";
    }
    const uri = prefs.getStringPref("network.trr.uri", "");
    return (RESOLVERS.find(r => r.uri && r.uri === uri) || { id: null }).id;
  }

  async function applyEngine(id) {
    const spec = ENGINES.find(e => e.id === id);
    if (!spec) {
      return;
    }
    const SS = lazy.SearchService;
    await SS.init();
    let engine = SS.getEngineByName(spec.name);
    if (!engine) {
      engine = await SS.addUserEngine({ name: spec.name, url: spec.url, method: "GET" });
    }
    if (engine.hidden) {
      engine.hidden = false;
    }
    await SS.setDefault(engine, SS.CHANGE_REASON.USER);
    try {
      await SS.setDefaultPrivate(engine, SS.CHANGE_REASON.USER);
    } catch (e) {}
  }

  function applyResolver(id) {
    const r = RESOLVERS.find(x => x.id === id);
    if (!r) {
      return;
    }
    if (r.id === "off") {
      prefs.setIntPref("network.trr.mode", 5);
    } else {
      prefs.setStringPref("network.trr.uri", r.uri);
      prefs.setStringPref("network.trr.custom_uri", r.uri);
      prefs.setIntPref("network.trr.mode", 2);
    }
  }

  function layoutPreview(kind) {
    // Flat tile composition in the palette (no imagery).
    return h("span", { class: `amaya-home-layout-pic amaya-home-layout-pic--${kind}`, "aria-hidden": "true" },
      h("span", { class: "amaya-home-layout-bar" }),
      h("span", { class: "amaya-home-layout-page" }));
  }

  const STEPS = [
    {
      id: "import",
      title: "Bring your things with you",
      lead: "Import bookmarks, history and saved passwords from another browser on this device. Nothing is sent anywhere.",
      body(state) {
        const note = h("p", { class: "amaya-home-note", hidden: !state.importOpened, role: "status",
          text: "The import window is open. Come back here when it has finished." });
        const btn = h("button", {
          class: "amaya-btn amaya-home-btn",
          type: "button",
          onclick: () => {
            try {
              // No opener: open the wizard in its own window so this card stays.
              lazy.MigrationUtils.showMigrationWizard(null, {
                entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN,
              });
              state.importOpened = true;
              note.hidden = false;
            } catch (e) {
              log("migration wizard:", e);
            }
          },
        }, "Import from a browser");
        return h("div", { class: "amaya-home-stack" }, h("div", null, btn), note);
      },
    },
    {
      id: "protection",
      title: "Choose your protection level",
      lead: "Fingerprint protection stops sites from recognising your device by its settings and hardware.",
      body() {
        const cur = prefs.getStringPref(PREF_FP, "balanced") === "uniform" ? "uniform" : "balanced";
        return h("div", { class: "amaya-home-stack" },
          h("div", { class: "amaya-home-options", role: "radiogroup", "aria-label": "Protection level" },
            radioCard({ name: "fp", value: "balanced", checked: cur === "balanced", title: "Balanced",
              desc: "Mixes the values sites use to identify your device, so sites still work. Recommended for most people." }),
            radioCard({ name: "fp", value: "uniform", checked: cur === "uniform", title: "Uniform",
              desc: "Reports the same values as everyone else using Uniform. Costs: some sites may look or behave differently, windows open at standard sizes and sites are asked for English pages." })),
          h("p", { class: "amaya-home-note", text: "A change takes effect the next time you start Amaya." }));
      },
      apply(root) {
        const v = checkedValue(root, "fp");
        if (v === "balanced" || v === "uniform") {
          prefs.setStringPref(PREF_FP, v);
        }
      },
    },
    {
      id: "search",
      title: "Choose a search engine",
      lead: "Amaya has no deal with any of these, so none is picked for you. Search suggestions stay off until you turn them on.",
      body() {
        const engines = h("div", { class: "amaya-home-grid", role: "radiogroup", "aria-label": "Search engine" },
          ENGINES.map(e => radioCard({ name: "engine", value: e.id, checked: false, title: e.label,
            extra: h("code", { class: "amaya-home-option-host", text: e.host }) })));
        const cur = currentResolver();
        const dns = h("div", { class: "amaya-home-segment", role: "radiogroup", "aria-labelledby": "amaya-home-dns-label" },
          RESOLVERS.map(r => h("label", { class: "amaya-home-seg" },
            h("input", { type: "radio", name: "dns", value: r.id, checked: r.id === cur, class: "amaya-home-radio" }),
            h("span", { text: r.label }))));
        return h("div", { class: "amaya-home-stack" },
          engines,
          h("div", { class: "amaya-home-sub" },
            h("h3", { id: "amaya-home-dns-label", class: "amaya-home-subtitle", text: "Encrypted DNS" }),
            h("p", { class: "amaya-home-desc",
              text: "Look up sites through an encrypted resolver, so your network cannot see which sites you visit. If the resolver cannot be reached, Amaya uses your system's DNS." }),
            dns));
      },
      async apply(root) {
        const engine = checkedValue(root, "engine");
        const dns = checkedValue(root, "dns");
        if (dns) {
          applyResolver(dns);
        }
        if (engine) {
          await applyEngine(engine);
        }
      },
    },
    {
      id: "layout",
      title: "Sidebar or top toolbar",
      lead: "Where the address field and the back and forward buttons live. Your tabs stay in the sidebar either way.",
      body() {
        const cur = prefs.getStringPref(PREF_LAYOUT, "sidebar") === "toolbar" ? "toolbar" : "sidebar";
        return h("div", { class: "amaya-home-grid amaya-home-grid--2", role: "radiogroup", "aria-label": "Layout" },
          radioCard({ name: "layout", value: "sidebar", checked: cur === "sidebar", title: "Sidebar",
            desc: "Everything in one column on the left. More room for the page.", extra: layoutPreview("sidebar") }),
          radioCard({ name: "layout", value: "toolbar", checked: cur === "toolbar", title: "Top toolbar",
            desc: "The address field in a bar above the page, as in most browsers.", extra: layoutPreview("toolbar") }));
      },
      apply(root) {
        const v = checkedValue(root, "layout");
        if (v === "sidebar" || v === "toolbar") {
          prefs.setStringPref(PREF_LAYOUT, v);
        }
      },
    },
  ];

  function anyWindowShows(id) {
    for (const w of Services.wm.getEnumerator("navigator:browser")) {
      if (w.document.getElementById(id)) {
        return true;
      }
    }
    return false;
  }

  function showOnboarding(startAt = 0) {
    const state = { step: Math.max(0, Math.min(STEPS.length - 1, startAt)), importOpened: false, busy: false };
    const finish = () => {
      prefs.setBoolPref(PREF_ONBOARDED, true);
      dlg.close();
      ui?.emit?.("home-onboarded", {});
    };
    const dlg = openDialog("amaya-home-onboarding", "amaya-home-step-title", finish);
    dlg.card.classList.add("amaya-home-card--onboarding");

    const progress = h("ol", { class: "amaya-home-progress", "aria-hidden": "true" },
      STEPS.map(() => h("li", null)));
    const counter = h("p", { class: "amaya-home-counter" });
    const content = h("div", { class: "amaya-home-step" });
    const skip = h("button", { class: "amaya-btn amaya-btn--quiet amaya-home-btn", type: "button" }, "Skip");
    const back = h("button", { class: "amaya-btn amaya-home-btn", type: "button" }, "Back");
    const next = h("button", { class: "amaya-btn amaya-btn--primary amaya-home-btn", type: "button" });
    const footer = h("div", { class: "amaya-home-footer" }, skip, h("span", { class: "amaya-home-spacer" }), back, next);
    dlg.card.append(h("div", { class: "amaya-home-head" }, counter, progress), content, footer);

    function render(animate) {
      const s = STEPS[state.step];
      counter.textContent = `Step ${state.step + 1} of ${STEPS.length}`;
      [...progress.children].forEach((li, i) => li.classList.toggle("is-done", i <= state.step));
      const title = h("h2", { id: "amaya-home-step-title", class: "amaya-home-title", tabindex: "-1", text: s.title });
      content.replaceChildren(title, h("p", { class: "amaya-home-lead", text: s.lead }), s.body(state));
      back.hidden = state.step === 0;
      next.textContent = state.step === STEPS.length - 1 ? "Done" : "Continue";
      skip.setAttribute("aria-label", `Skip: ${s.title}`);
      if (animate) {
        fadeIn(content);
      }
      title.focus();
    }

    async function go(delta, applyFirst) {
      if (state.busy) {
        return;
      }
      state.busy = true;
      try {
        if (applyFirst && STEPS[state.step].apply) {
          await STEPS[state.step].apply(content);
        }
      } catch (e) {
        log(`applying step ${STEPS[state.step].id}:`, e);
      } finally {
        state.busy = false;
      }
      const to = state.step + delta;
      if (to >= STEPS.length) {
        finish();
        return;
      }
      state.step = Math.max(0, to);
      render(true);
    }

    skip.addEventListener("click", () => go(1, false));
    back.addEventListener("click", () => go(-1, false));
    next.addEventListener("click", () => go(1, true));
    content.addEventListener("keydown", e => {
      // Enter on a radio choice continues, like a form.
      if (e.key === "Enter" && e.target.type === "radio") {
        e.preventDefault();
        go(1, true);
      }
    });
    render(false);
    fadeIn(dlg.card);
    return dlg;
  }

  /* ------------------------------------------------ new tab page settings */

  function toggleRow(label, desc, pref) {
    const id = `amaya-home-t-${pref.replace(/\W/g, "-")}`;
    const btn = h("button", {
      class: "amaya-toggle",
      type: "button",
      role: "switch",
      id,
      "aria-checked": String(boolPref(pref, true)),
      "aria-labelledby": `${id}-l`,
      onclick: () => {
        const v = !boolPref(pref, true);
        prefs.setBoolPref(pref, v);
        btn.setAttribute("aria-checked", String(v));
      },
    });
    return h("div", { class: "amaya-home-row" },
      h("div", { class: "amaya-home-option-text" },
        h("span", { id: `${id}-l`, class: "amaya-home-option-title", text: label }),
        h("span", { class: "amaya-home-option-desc", text: desc })),
      btn);
  }

  function showSettings() {
    const dlg = openDialog("amaya-home-settings", "amaya-home-settings-title", () => dlg.close());
    dlg.card.classList.add("amaya-home-card--settings");
    const enabled = boolPref(PREF_ENABLED, true);
    const seg = h("div", { class: "amaya-home-segment", role: "radiogroup", "aria-label": "New tabs show" },
      [["amaya", "Amaya page"], ["blank", "Blank page"]].map(([v, l]) =>
        h("label", { class: "amaya-home-seg" },
          h("input", {
            type: "radio", name: "nt", value: v, class: "amaya-home-radio",
            checked: (v === "amaya") === enabled,
            onchange: () => prefs.setBoolPref(PREF_ENABLED, v === "amaya"),
          }),
          h("span", { text: l }))));
    const done = h("button", { class: "amaya-btn amaya-btn--primary amaya-home-btn", type: "button", onclick: () => dlg.close() }, "Done");
    const title = h("h2", { id: "amaya-home-settings-title", class: "amaya-home-title amaya-home-title--sm", tabindex: "-1", text: "New tab page" });
    dlg.card.append(
      title,
      h("div", { class: "amaya-home-row" },
        h("div", { class: "amaya-home-option-text" },
          h("span", { class: "amaya-home-option-title", text: "New tabs show" }),
          h("span", { class: "amaya-home-option-desc", text: "Also used as your home page, unless you set your own." })),
        seg),
      toggleRow("Your sites", "Sites you pin and visit often. Never sponsored.", PREF_SITES),
      toggleRow("Trackers blocked this week", "Counted on this device. Nothing is sent anywhere.", PREF_TALLY),
      h("div", { class: "amaya-home-footer" }, h("span", { class: "amaya-home-spacer" }), done));
    fadeIn(dlg.card);
    title.focus();
    return dlg;
  }

  /* ------------------------------------------------------ registration */

  // Command bar actions (contract: AmayaUI.commands; the same id replaces).
  const COMMANDS = [
    { id: "home-first-run", label: "Run first-run setup again", group: "settings", icon: "arrow",
      hint: "Setup", run: () => showOnboarding(0) },
    { id: "home-newtab-settings", label: "New tab page settings", group: "settings", icon: "gear",
      hint: "Settings", run: () => showSettings() },
  ];
  function registerCommands() {
    if (!ui) {
      return;
    }
    ui.commands ||= [];
    for (const c of COMMANDS) {
      const i = ui.commands.findIndex(x => x && x.id === c.id);
      if (i >= 0) {
        ui.commands[i] = c;
      } else {
        ui.commands.push(c);
      }
    }
  }

  const prefObserver = {
    observe(subject, topic, name) {
      if (name === PREF_ENABLED) {
        applyNewTabURL();
      }
      scheduleWrite(100);
    },
  };
  const searchObserver = {
    observe(subject, topic, data) {
      if (data === "engine-default" || data === "engine-changed") {
        scheduleWrite(200);
      }
    },
  };
  const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onTheme = () => scheduleWrite(100);
  let interval = null;

  const api = {
    init(win) {
      registerCommands();
      gBrowser.addTabsProgressListener(tabsListener);
      for (const p of [PREF_ENABLED, PREF_SITES, PREF_TALLY]) {
        prefs.addObserver(p, prefObserver);
      }
      Services.obs.addObserver(searchObserver, "browser-search-engine-modified");
      themeQuery.addEventListener("change", onTheme);
      interval = setInterval(() => {
        if (isLeader()) {
          writePage().catch(() => {});
        }
      }, REFRESH_MS);

      const isPopup = !win.toolbar.visible;
      const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
      if (!boolPref(PREF_ONBOARDED, false) && !isPopup && !isPrivate &&
          !anyWindowShows("amaya-home-onboarding")) {
        showOnboarding(0);
      }

      // The page file must exist before it becomes the new tab URL.
      api.ready = writePage()
        .then(() => {
          applyNewTabURL();
          replaceStartupTabs();
          // Loading the startup tab moves focus to it; keep it in the card.
          document.querySelector("#amaya-home-onboarding .amaya-home-title")?.focus();
        })
        .catch(e => log("new tab page disabled:", e));
    },
    uninit() {
      try {
        gBrowser.removeTabsProgressListener(tabsListener);
      } catch (e) {}
      for (const p of [PREF_ENABLED, PREF_SITES, PREF_TALLY]) {
        prefs.removeObserver(p, prefObserver);
      }
      try {
        Services.obs.removeObserver(searchObserver, "browser-search-engine-modified");
      } catch (e) {}
      themeQuery.removeEventListener("change", onTheme);
      clearInterval(interval);
      clearTimeout(refreshTimer);
      if (ui && Array.isArray(ui.commands)) {
        ui.commands = ui.commands.filter(c => !COMMANDS.includes(c));
      }
      document.getElementById("amaya-home-onboarding")?.remove();
      document.getElementById("amaya-home-settings")?.remove();
      document.getElementById("amaya-home-overlay-root")?.remove();
    },
    // For other modules and tests.
    showOnboarding,
    showSettings,
    writePage,
    pageURL,
  };

  if (ui && ui.register) {
    ui.register(NAME, api);
  } else {
    window.AmayaHome = api;
  }
})();
