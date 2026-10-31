/* Amaya command bar (Ctrl+K / Cmd+K).
 *
 * Runs in the browser window scope (privileged), loaded by ui/loader.js.
 * See README.md in this folder for the command registry other modules use.
 *
 * Privacy: nothing here touches the network while typing. Results come from
 * open tabs, registered commands, the local Places database and a fixed list
 * of settings. The web search row only builds a URL when it is chosen.
 */
(function () {
  "use strict";

  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const NAME = "cmdbar";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const SVGNS = "http://www.w3.org/2000/svg";
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const IS_MAC = AppConstants.platform == "macosx";

  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    ContextualIdentityService:
      "resource://gre/modules/ContextualIdentityService.sys.mjs",
    PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
    PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
    ShortcutUtils: "resource://gre/modules/ShortcutUtils.sys.mjs",
  });
  // Firefox 159 moved the search service out of Services.search.
  ChromeUtils.defineLazyGetter(lazy, "search", () => {
    try {
      return ChromeUtils.importESModule(
        "moz-src:///toolkit/components/search/SearchService.sys.mjs"
      ).SearchService;
    } catch (e) {
      return Services.search;
    }
  });

  const log = (...args) =>
    ui.log ? ui.log(NAME, ...args) : console.log(`[amaya-ui:${NAME}]`, ...args);

  const emit = (type, detail) => {
    if (typeof ui.emit == "function") {
      ui.emit(type, detail);
    } else {
      window.dispatchEvent(new CustomEvent("amaya:" + type, { detail }));
    }
  };

  /* ------------------------------------------------------------------ *
   * Command registry (public: AmayaUI.commands)
   *
   * A plain array, so modules that load before this one can already do
   *   (AmayaUI.commands ||= []).push({ id, label, run, ... })
   * and it is read fresh every time the bar opens. Same id = replace.
   * ------------------------------------------------------------------ */
  if (!Array.isArray(ui.commands)) {
    ui.commands = [];
  }
  const registry = ui.commands;

  function registerCommand(cmd) {
    if (!cmd || !cmd.id || !cmd.label || typeof cmd.run != "function") {
      log("ignored invalid command", cmd && cmd.id);
      return;
    }
    const i = registry.findIndex(c => c && c.id == cmd.id);
    if (i >= 0) {
      registry[i] = cmd;
    } else {
      registry.push(cmd);
    }
    if (bar && bar.isOpen) {
      bar.commands = allCommands();
      bar.refresh();
    }
  }

  function unregisterCommand(id) {
    for (let i = registry.length - 1; i >= 0; i--) {
      if (registry[i] && registry[i].id == id) {
        registry.splice(i, 1);
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Icons (16px, 24px grid, 1.5 stroke, same style as the design set)
   * ------------------------------------------------------------------ */
  const ICONS = {
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    window: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M4 9h16"/>',
    private:
      '<path d="M4 10c2.5-1.5 5-2 8-2s5.5.5 8 2"/><circle cx="8" cy="14" r="2.5"/><circle cx="16" cy="14" r="2.5"/><path d="M10.5 14h3"/>',
    undo: '<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 010 10h-2"/>',
    sidebar: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 5v14"/>',
    bookmark: '<path d="M7 4h10v16l-5-4-5 4z"/>',
    print:
      '<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="1.5"/><path d="M7 14h10v6H7z"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    find: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M9 11h4"/>',
    reader: '<path d="M4 6c3-1 5-1 8 1 3-2 5-2 8-1v12c-3-1-5-1-8 1-3-2-5-2-8-1z"/><path d="M12 7v12"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4"/>',
    reload: '<path d="M19 12a7 7 0 11-2.05-4.95"/><path d="M19 5v4h-4"/>',
    copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/>',
    sound: '<path d="M5 10v4h3l4 3V7L8 10z"/><path d="M15.5 9.5a3.5 3.5 0 010 5"/>',
    expand: '<path d="M5 9V5h4M19 9V5h-4M5 15v4h4M19 15v4h-4"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l2 2"/>',
    puzzle:
      '<path d="M5 8h3a2 2 0 114 0h3v3a2 2 0 110 4v4h-4a2 2 0 10-4 0H5v-4a2 2 0 100-4z"/>',
    home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
    globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    split: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12 5v14"/>',
    folder: '<path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z"/>',
    fingerprint:
      '<path d="M7 18c1-2 1.5-4 1.5-6a3.5 3.5 0 017 0c0 3-.5 5.5-1.5 8"/><path d="M12 12c0 3-.7 5.5-2 7.5"/><path d="M5 14c.3-1 .5-1.5.5-2.5a6.5 6.5 0 0113 0c0 1.5-.1 3-.4 4.5"/>',
  };

  function svgIcon(name) {
    let markup = ICONS[name];
    if (!markup && typeof ui.icon == "function") {
      try {
        const el = ui.icon(name);
        if (el && el.nodeType == 1) {
          el.classList.add("amaya-ico");
          el.setAttribute("aria-hidden", "true");
          return el;
        }
      } catch (e) {
        /* fall through */
      }
    }
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("class", "amaya-ico");
    svg.setAttribute("aria-hidden", "true");
    const doc = new DOMParser().parseFromString(
      `<svg xmlns="${SVGNS}">${markup || ICONS.arrow}</svg>`,
      "image/svg+xml"
    );
    for (const child of [...doc.documentElement.childNodes]) {
      svg.appendChild(document.importNode(child, true));
    }
    return svg;
  }

  function h(tag, props, ...kids) {
    const el = document.createElementNS(XHTML, tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) {
        continue;
      }
      if (k == "class") {
        el.className = v;
      } else if (k.startsWith("on")) {
        el.addEventListener(k.slice(2), v);
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) {
        el.append(kid.nodeType ? kid : String(kid));
      }
    }
    return el;
  }

  /* ------------------------------------------------------------------ *
   * Shortcut hints
   * ------------------------------------------------------------------ */
  // "Accel+Shift+S" -> ["Ctrl","Shift","S"] / ["⇧","⌘","S"]
  function shortcutParts(spec) {
    if (!spec) {
      return [];
    }
    if (Array.isArray(spec)) {
      return spec;
    }
    const parts = String(spec).split("+").filter(Boolean);
    const key = parts.pop();
    const mods = parts.map(m => m.toLowerCase());
    if (IS_MAC) {
      const order = [
        ["ctrl", "⌃"],
        ["control", "⌃"],
        ["alt", "⌥"],
        ["shift", "⇧"],
        ["accel", "⌘"],
        ["cmd", "⌘"],
        ["meta", "⌘"],
      ];
      const out = [];
      for (const [m, sym] of order) {
        if (mods.includes(m) && !out.includes(sym)) {
          out.push(sym);
        }
      }
      return [...out, key];
    }
    const names = { accel: "Ctrl", ctrl: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift", meta: "Super", cmd: "Ctrl" };
    return [...mods.map(m => names[m] || m), key];
  }

  // Shortcut of the <key> bound to a <command> id, as kbd parts.
  function shortcutForCommand(commandId) {
    try {
      const key = document.querySelector(`key[command="${commandId}"]`);
      return shortcutForKey(key);
    } catch (e) {
      return [];
    }
  }

  function shortcutForKey(key) {
    if (!key || (!key.getAttribute("key") && !key.getAttribute("keycode"))) {
      return [];
    }
    const pretty = lazy.ShortcutUtils.prettifyShortcut(key);
    if (!pretty) {
      return [];
    }
    if (IS_MAC) {
      // "⇧⌘P": one symbol per modifier, then the key (may be a word: "F12").
      const m = pretty.match(/^([⌃⌥⇧⌘]*)(.+)$/u);
      return m ? [...m[1], m[2]] : [pretty];
    }
    return pretty.endsWith("++")
      ? [...pretty.slice(0, -2).split("+"), "+"]
      : pretty.split("+");
  }

  /* ------------------------------------------------------------------ *
   * Fuzzy matching: prefix > word prefix > substring > subsequence
   * ------------------------------------------------------------------ */
  function scoreText(q, text, fuzzy = true) {
    if (!text) {
      return 0;
    }
    const t = text.toLowerCase();
    if (t.startsWith(q)) {
      return 100 - Math.min(t.length - q.length, 30) * 0.1;
    }
    const idx = t.indexOf(q);
    if (idx > 0) {
      const boundary = /[\s\-_./:·|(]/.test(t[idx - 1]);
      return (boundary ? 80 : 60) - Math.min(idx, 30) * 0.2;
    }
    if (!fuzzy) {
      return 0;
    }
    // Subsequence: every char in order. Reward runs and word starts.
    let ti = 0;
    let score = 0;
    let prev = -2;
    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found < 0) {
        return 0;
      }
      if (found == prev + 1) {
        score += 3;
      } else if (found == 0 || /[\s\-_./:·|(]/.test(t[found - 1])) {
        score += 2;
      } else {
        score += 0.5;
      }
      prev = found;
      ti = found + 1;
    }
    const max = q.length * 3;
    return 10 + 25 * (score / max);
  }

  // Score a query (possibly several words) against a list of fields.
  // Every word must match some field; the score is the mean of best matches.
  // Only the first field (the label) matches as a subsequence; the others
  // (keywords, host, URL) need a prefix or substring, to keep noise down.
  function matchFields(query, fields) {
    const q = query.trim().toLowerCase();
    if (!q) {
      return 1;
    }
    const best = text =>
      Math.max(0, ...fields.map((f, i) => (f ? scoreText(text, f, i == 0) : 0)));
    const whole = best(q);
    const words = q.split(/\s+/);
    if (words.length == 1) {
      return whole;
    }
    let sum = 0;
    for (const w of words) {
      const s = best(w);
      if (!s) {
        return whole;
      }
      sum += s;
    }
    return Math.max(whole, sum / words.length);
  }

  /* ------------------------------------------------------------------ *
   * URL detection (local only, no DNS / keyword lookups)
   * ------------------------------------------------------------------ */
  const URL_SCHEMES = /^(https?|ftp|file|about|view-source|moz-extension|chrome|resource|data):/i;
  const HOSTLIKE =
    /^(localhost|\[[0-9a-f:.]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9¡-￿]([a-z0-9¡-￿-]*[a-z0-9¡-￿])?\.)+[a-z¡-￿]{2,}|[a-z0-9-]+\.(onion|local|test|lan|internal))(:\d{1,5})?([/?#].*)?$/i;

  function urlFromInput(text) {
    const s = text.trim();
    if (!s || /\s/.test(s)) {
      return null;
    }
    if (!URL_SCHEMES.test(s) && !HOSTLIKE.test(s)) {
      return null;
    }
    try {
      const info = Services.uriFixup.getFixupURIInfo(
        s,
        Ci.nsIURIFixup.FIXUP_FLAG_NONE
      );
      const uri = info.preferredURI;
      if (!uri || info.keywordProviderName) {
        return null;
      }
      return uri.spec;
    } catch (e) {
      return null;
    }
  }

  function hostOf(url) {
    try {
      const u = Services.io.newURI(url);
      return u.host || u.spec;
    } catch (e) {
      return url;
    }
  }

  /* ------------------------------------------------------------------ *
   * Sources
   * ------------------------------------------------------------------ */
  function where(newTab) {
    return newTab ? "tab" : "current";
  }

  function openURL(url, newTab, extra) {
    openTrustedLinkIn(url, where(newTab), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      ...(extra || {}),
    });
  }

  function doCommand(id) {
    const el = document.getElementById(id);
    if (el && typeof el.doCommand == "function") {
      el.doCommand();
      return true;
    }
    if (typeof goDoCommand == "function") {
      goDoCommand(id);
      return true;
    }
    return false;
  }

  function commandEnabled(id) {
    const el = document.getElementById(id);
    return !!el && el.getAttribute("disabled") != "true";
  }

  // --- Tabs -----------------------------------------------------------
  function spaceForTab(tab) {
    const spaces = ui.spaces;
    try {
      const sp = spaces && typeof spaces.spaceForTab == "function" && spaces.spaceForTab(tab);
      if (sp && sp.name) {
        return sp;
      }
    } catch (e) {
      /* spaces module not ready */
    }
    const attr = tab.getAttribute("amaya-space-name");
    if (attr) {
      return { id: tab.getAttribute("amaya-space-id") || attr, name: attr };
    }
    if (tab.userContextId) {
      try {
        const name = lazy.ContextualIdentityService.getUserContextLabel(
          tab.userContextId
        );
        if (name) {
          return { id: null, userContextId: tab.userContextId, name };
        }
      } catch (e) {
        /* ignore */
      }
    }
    return null;
  }

  function selectTab(tab) {
    const sp = spaceForTab(tab);
    const spaces = ui.spaces;
    if (sp && sp.id != null && spaces) {
      try {
        const active = spaces.activeId ?? (spaces.active && spaces.active.id);
        if (active != sp.id) {
          for (const fn of ["switchTo", "activate", "select"]) {
            if (typeof spaces[fn] == "function") {
              spaces[fn](sp.id);
              break;
            }
          }
        }
      } catch (e) {
        log("space switch failed", e);
      }
    }
    if (tab.isConnected) {
      gBrowser.selectedTab = tab;
    }
  }

  // Favicons only ever come from local data: the tab's own image when it is
  // already a local URL, else the Places favicon DB. Never an http(s) fetch.
  const LOCAL_IMG = /^(data|chrome|moz-icon|moz-remote-image|cached-favicon|resource):/;
  function tabIcon(tab, url) {
    const img = tab && tab.image;
    if (img && LOCAL_IMG.test(img)) {
      return { src: img };
    }
    return { page: url && /^https?:/.test(url) ? url : null };
  }

  const favCache = new Map();
  async function pageFavicon(url) {
    if (favCache.has(url)) {
      return favCache.get(url);
    }
    let src = null;
    try {
      const fav = await lazy.PlacesUtils.favicons.getFaviconForPage(
        Services.io.newURI(url),
        16 * Math.ceil(window.devicePixelRatio || 1)
      );
      src = fav && fav.dataURI ? fav.dataURI.spec : null;
    } catch (e) {
      /* no icon */
    }
    if (favCache.size > 500) {
      favCache.clear();
    }
    favCache.set(url, src);
    return src;
  }

  function collectTabs(q) {
    const out = [];
    const tabs = gBrowser.tabs;
    for (const tab of tabs) {
      // The current tab is never a useful destination.
      if (tab.closing || tab.selected) {
        continue;
      }
      const url = tab.linkedBrowser?.currentURI?.spec || "";
      const title = tab.label || url;
      const web = /^https?:/.test(url);
      const host = web ? hostOf(url) : "";
      let score;
      if (q) {
        score = matchFields(q, [title, host, web ? url : ""]);
        if (!score) {
          continue;
        }
      } else {
        score = tab.lastAccessed || 0;
      }
      const sp = spaceForTab(tab);
      out.push({
        key: "tab:" + (tab.linkedPanel || tabs.indexOf(tab)),
        label: title,
        hint: sp ? sp.name : "",
        fav: { ...tabIcon(tab, url), letter: title },
        url,
        score,
        match: q ? score : undefined,
        run: () => selectTab(tab),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, q ? 6 : 5);
  }

  // --- Built-in actions -----------------------------------------------
  function builtinActions() {
    const cmd = (id, label, icon, command, extra = {}) => ({
      id,
      label,
      icon,
      group: "actions",
      shortcut: () => shortcutForCommand(command),
      when: () => commandEnabled(command),
      run: () => doCommand(command),
      ...extra,
    });
    return [
      cmd("tab.new", "New tab", "plus", "cmd_newNavigatorTab", {
        keywords: ["open"],
        shortcut: () => shortcutForKey(document.getElementById("key_newNavigatorTab")),
      }),
      cmd("window.new", "New window", "window", "cmd_newNavigator"),
      cmd("window.private", "New private window", "private", "Tools:PrivateBrowsing", {
        keywords: ["incognito"],
      }),
      cmd("tab.close", "Close tab", "close", "cmd_close"),
      cmd("tab.reopen", "Reopen closed tab", "undo", "History:UndoCloseTab", {
        keywords: ["restore", "undo"],
        when: () => {
          try {
            return typeof SessionStore.getClosedTabCountForWindow == "function"
              ? SessionStore.getClosedTabCountForWindow(window) > 0
              : SessionStore.getClosedTabCount({ sourceWindow: window }) > 0;
          } catch (e) {
            return commandEnabled("History:UndoCloseTab");
          }
        },
        shortcut: () =>
          shortcutForCommand("History:RestoreLastClosedTabOrWindowOrSession"),
      }),
      {
        id: "compact.toggle",
        label: "Toggle compact mode",
        icon: "sidebar",
        group: "actions",
        keywords: ["sidebar", "collapse", "hide"],
        shortcut: "Accel+Shift+S",
        run: () => emit("toggle-compact", {}),
      },
      cmd("page.bookmark", "Bookmark this page", "bookmark", "Browser:AddBookmarkAs", {
        keywords: ["star", "save"],
      }),
      cmd("page.print", "Print", "print", "cmd_print"),
      cmd("downloads", "Downloads", "download", "Tools:Downloads"),
      cmd("page.find", "Find in page", "find", "cmd_find", { keywords: ["search"] }),
      cmd("page.reader", "Toggle reader view", "reader", "View:ReaderView", {
        when: () => {
          const b = gBrowser.selectedBrowser;
          return !!(b && (b.isArticle || b.currentURI?.spec.startsWith("about:reader")));
        },
      }),
      cmd("page.reload", "Reload page", "reload", "Browser:Reload", { keywords: ["refresh"] }),
      cmd("tab.duplicate", "Duplicate tab", "copy", "Browser:DuplicateTab"),
      cmd("tab.mute", "Mute or unmute tab", "sound", "cmd_toggleMute", {
        keywords: ["sound", "audio"],
      }),
      cmd("view.fullscreen", "Full screen", "expand", "View:FullScreen"),
      cmd("history.clear", "Clear recent history", "clock", "Tools:Sanitize", {
        keywords: ["delete", "cookies", "cache", "forget"],
      }),
      {
        id: "devtools",
        label: "Developer tools",
        icon: "code",
        group: "actions",
        keywords: ["inspector", "console", "devtools"],
        shortcut: () => shortcutForKey(document.getElementById("key_toggleToolbox")),
        when: () => !!document.getElementById("key_toggleToolbox"),
        run: () => document.getElementById("key_toggleToolbox").doCommand(),
      },
    ];
  }

  // --- Settings deep links ---------------------------------------------
  const FP_PREF = "amaya.fingerprinting.mode";
  function builtinSettings() {
    const pane = (id, label, icon, paneId, hint, keywords) => ({
      id,
      label,
      icon,
      hint,
      keywords,
      group: "settings",
      run: () => openPreferences(paneId),
    });
    const fpMode = () => {
      try {
        return Services.prefs.getStringPref(FP_PREF, "balanced");
      } catch (e) {
        return "balanced";
      }
    };
    const fp = (mode, label) => ({
      id: "settings.fingerprint." + mode,
      label,
      icon: "fingerprint",
      group: "settings",
      keywords: ["fingerprint", "privacy", "resist", mode],
      hint: () => (fpMode() == mode ? "Current" : "Applies after restart"),
      run: () => Services.prefs.setStringPref(FP_PREF, mode),
    });
    return [
      pane("settings.privacy", "Privacy and protection", "shield", "panePrivacy", "Privacy", [
        "security", "tracking", "cookies", "permissions",
      ]),
      pane("settings.tracking", "Tracker blocking", "shield", "privacy-trackingprotection", "Privacy", [
        "enhanced tracking protection", "etp", "strict",
      ]),
      fp("balanced", "Fingerprint protection: Balanced"),
      fp("uniform", "Fingerprint protection: Uniform"),
      pane("settings.logins", "Passwords", "key", "privacy-logins", "Privacy", ["logins", "autofill"]),
      pane("settings.permissions", "Site permissions", "lock", "privacy-permissions", "Privacy", [
        "camera", "microphone", "location", "notifications",
      ]),
      pane("settings.doh", "Encrypted DNS", "lock", "privacy-doh", "Privacy", ["dns over https", "doh", "resolver"]),
      pane("settings.search", "Search engine", "search", "paneSearch", "Search", ["default search"]),
      pane("settings.home", "Home and new tab", "home", "paneHome", "Home", ["homepage", "startup"]),
      pane("settings.general", "General settings", "gear", "paneGeneral", "General", [
        "language", "fonts", "downloads", "appearance", "theme",
      ]),
      pane("settings.network", "Network and proxy", "globe", "general-netsettings", "General", ["proxy", "connection"]),
      pane("settings.drm", "DRM content", "lock", "general-drm", "General", ["widevine", "drm", "netflix"]),
      {
        id: "settings.addons",
        label: "Extensions and themes",
        icon: "puzzle",
        hint: "Add-ons",
        group: "settings",
        keywords: ["addons", "add-ons", "ublock", "plugins"],
        run: () => doCommand("Tools:Addons") || openURL("about:addons", true),
      },
      pane("settings.all", "All settings", "gear", undefined, "", ["preferences", "options"]),
    ];
  }

  function allCommands() {
    const list = [...builtinActions(), ...builtinSettings()];
    const seen = new Map(list.map((c, i) => [c.id, i]));
    const add = c => {
      if (!c || !c.id || !c.label || typeof c.run != "function") {
        return;
      }
      if (seen.has(c.id)) {
        list[seen.get(c.id)] = c;
      } else {
        seen.set(c.id, list.length);
        list.push(c);
      }
    };
    registry.forEach(add);
    // Dynamic, open-time commands: ui.on("register-commands", e => e.detail.add({...}))
    const extra = [];
    window.dispatchEvent(
      new CustomEvent("amaya:register-commands", { detail: { add: c => extra.push(c) } })
    );
    extra.forEach(add);
    return list;
  }

  const val = v => (typeof v == "function" ? v() : v);

  function commandResults(commands, group, q, limit) {
    const out = [];
    commands.forEach((c, order) => {
      if ((c.group || "actions").toLowerCase() != group) {
        return;
      }
      try {
        if (c.when && !c.when()) {
          return;
        }
      } catch (e) {
        return;
      }
      const score = q ? matchFields(q, [c.label, ...(c.keywords || [])]) : 1;
      if (!score) {
        return;
      }
      // A label match beats a keyword-only match of the same strength.
      const labelScore = q ? scoreText(q.trim().toLowerCase(), c.label) : 0;
      let hint = "";
      let kbd = [];
      try {
        hint = val(c.hint) || "";
        kbd = shortcutParts(val(c.shortcut));
      } catch (e) {
        /* ignore */
      }
      out.push({
        key: "cmd:" + c.id,
        id: c.id,
        label: c.label,
        icon: c.icon,
        hint,
        kbd,
        score: score + (labelScore ? 5 : 0),
        match: q ? score : undefined,
        order,
        run: opts => c.run(opts),
      });
    });
    if (q) {
      out.sort((a, b) => b.score - a.score || a.order - b.order);
    }
    return out.slice(0, limit);
  }

  // --- History and bookmarks (local Places DB, read-only) ----------------
  async function queryPlaces(q, exclude) {
    const s = q.trim().toLowerCase();
    if (s.length < 2) {
      return [];
    }
    const esc = c => (c == "%" || c == "_" || c == "/" ? "/" + c : c);
    // Titles match as a subsequence ("gthb" -> "%g%t%h%b%"), URLs as a
    // substring, mirroring matchFields().
    const words = s.split(/\s+/);
    const params = {};
    words.forEach((w, i) => {
      params["p" + i] = "%" + [...w].map(esc).join("%") + "%";
      params["s" + i] = "%" + [...w].map(esc).join("") + "%";
    });
    const where = words
      .map((_, i) => `(h.url LIKE :s${i} ESCAPE '/' OR COALESCE(b.title, h.title) LIKE :p${i} ESCAPE '/')`)
      .join(" AND ");
    const db = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await db.executeCached(
      `SELECT h.url, COALESCE(b.title, h.title) AS title, h.frecency,
              b.id IS NOT NULL AS bookmarked
         FROM moz_places h
         LEFT JOIN moz_bookmarks b ON b.fk = h.id AND b.type = 1
        WHERE h.hidden = 0
          AND (h.visit_count > 0 OR b.id IS NOT NULL)
          AND ${where}
        GROUP BY h.id
        ORDER BY h.frecency DESC
        LIMIT 80`,
      params
    );
    const out = [];
    for (const row of rows) {
      const url = row.getResultByName("url");
      if (!/^(https?|file|about):/.test(url) || exclude.has(url)) {
        continue;
      }
      const title = row.getResultByName("title") || url;
      const host = hostOf(url);
      const score = matchFields(q, [title, host, url]);
      if (!score) {
        continue;
      }
      const frecency = Math.max(0, row.getResultByName("frecency") || 0);
      out.push({
        key: "place:" + url,
        label: title,
        hint: row.getResultByName("bookmarked") ? "Bookmark · " + host : host,
        fav: { page: /^https?:/.test(url) ? url : null, letter: host || title },
        url,
        newTabCapable: true,
        score: score + Math.log10(frecency + 1) * 4,
        match: score,
        run: ({ newTab }) => openURL(url, newTab),
      });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 6);
  }

  // --- Web search (default engine, built only when chosen) ----------------
  async function defaultEngine() {
    try {
      return lazy.PrivateBrowsingUtils.isWindowPrivate(window)
        ? await lazy.search.getDefaultPrivate()
        : await lazy.search.getDefault();
    } catch (e) {
      return null;
    }
  }

  async function webSearch(q, newTab) {
    const engine = await defaultEngine();
    if (!engine) {
      return;
    }
    const sub = engine.getSubmission(q);
    openURL(sub.uri.spec, newTab, { postData: sub.postData });
  }

  // When anything matches by prefix or substring, drop loose subsequence-only
  // matches everywhere ("print" should not list "Private data cleanup notes").
  const STRONG_MATCH = 55;
  const WEAK_MATCH = 36; // scoreText() subsequence scores stay below this
  function pruneWeak(groups) {
    const all = groups.flatMap(g => g.items);
    if (!all.some(i => i.match >= STRONG_MATCH)) {
      return groups;
    }
    return groups
      .map(g => ({ ...g, items: g.items.filter(i => i.match === undefined || i.match >= WEAK_MATCH) }))
      .filter(g => g.items.length);
  }

  /* ------------------------------------------------------------------ *
   * The bar
   * ------------------------------------------------------------------ */
  const GROUP_LABELS = {
    go: "",
    tabs: "Tabs",
    spaces: "Spaces",
    actions: "Actions",
    history: "History",
    settings: "Settings",
    web: "Web search",
  };

  class CommandBar {
    constructor() {
      this.isOpen = false;
      this.groups = [];
      this.items = [];
      this.selectedKey = null;
      this.engineName = "";
      this.queryToken = 0;
      this.lastFocus = null;
      this.build();
    }

    build() {
      const listId = "amaya-cmdbar-list";
      this.input = h("input", {
        class: "amaya-cmdbar__field",
        type: "text",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-expanded": "true",
        "aria-controls": listId,
        "aria-label": "Search tabs, actions, history and settings",
        placeholder: "Search tabs, actions, history and settings",
        spellcheck: "false",
        autocomplete: "off",
      });
      this.list = h("div", {
        id: listId,
        class: "amaya-cmdbar__list",
        role: "listbox",
        "aria-label": "Results",
      });
      this.dialog = h(
        "div",
        {
          class: "amaya-cmd amaya-cmdbar",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Command bar",
        },
        h(
          "div",
          { class: "amaya-cmd__input" },
          svgIcon("search"),
          this.input,
          h("span", { class: "amaya-kbd", "aria-hidden": "true" }, "Esc")
        ),
        this.list
      );
      this.backdrop = h(
        "div",
        { id: "amaya-cmdbar", class: "amaya-cmdbar-backdrop", hidden: true },
        this.dialog
      );

      this.input.addEventListener("input", () => this.refresh());
      this.input.addEventListener("keydown", e => this.onKeyDown(e));
      this.backdrop.addEventListener("mousedown", e => {
        if (e.target == this.backdrop) {
          e.preventDefault();
          this.close();
        }
      });
      // Focus trap: anything that tries to move focus out while open comes back.
      this.dialog.addEventListener("focusout", e => {
        if (!this.isOpen) {
          return;
        }
        const to = e.relatedTarget;
        if (to && !this.dialog.contains(to)) {
          window.setTimeout(() => this.isOpen && this.input.focus(), 0);
        }
      });
      this.list.addEventListener("mousemove", e => {
        const row = e.target.closest?.(".amaya-cmd__item");
        if (row && row.dataset.key != this.selectedKey) {
          this.select(row.dataset.key, false);
        }
      });
      this.list.addEventListener("mousedown", e => e.preventDefault());
      this.list.addEventListener("click", e => {
        const row = e.target.closest?.(".amaya-cmd__item");
        if (row) {
          this.runKey(row.dataset.key, { newTab: e.ctrlKey || e.metaKey || e.button == 1 });
        }
      });
    }

    mount(root) {
      root.appendChild(this.backdrop);
    }

    unmount() {
      this.backdrop.remove();
    }

    toggle() {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    }

    open(initial = "") {
      if (this.isOpen) {
        this.input.select();
        return;
      }
      this.isOpen = true;
      this.lastFocus = document.commandDispatcher.focusedElement;
      this.backdrop.hidden = false;
      this.input.value = initial;
      this.selectedKey = null;
      this.commands = allCommands();
      this.refresh();
      this.input.focus();
      this.input.select();
      defaultEngine().then(e => {
        this.engineName = (e && e.name) || "";
        const web = this.isOpen && this.items.find(i => i.key == "web");
        if (web) {
          web.hint = this.engineName;
          this.render();
        }
      });
      emit("cmdbar-opened", {});
    }

    close({ restoreFocus = true } = {}) {
      if (!this.isOpen) {
        return;
      }
      this.isOpen = false;
      this.queryToken++;
      this.backdrop.hidden = true;
      this.input.value = "";
      this.list.textContent = "";
      this.lastHistory = null;
      if (restoreFocus) {
        const prev = this.lastFocus;
        if (prev && prev.isConnected && prev.focus) {
          prev.focus();
        } else {
          gBrowser.selectedBrowser.focus();
        }
      }
      this.lastFocus = null;
      emit("cmdbar-closed", {});
    }

    refresh() {
      if (!this.isOpen) {
        return;
      }
      const raw = this.input.value;
      const q = raw.trim();
      const commands = this.commands || allCommands();
      const groups = [];
      const push = (id, items) => items.length && groups.push({ id, items });

      const url = urlFromInput(q);
      if (url) {
        push("go", [
          {
            key: "go:" + url,
            label: "Go to " + url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""),
            icon: "arrow",
            hint: "",
            url,
            newTabCapable: true,
            run: ({ newTab }) => openURL(url, newTab),
          },
        ]);
      }
      const tabs = collectTabs(q);
      push("tabs", tabs);
      push("spaces", commandResults(commands, "spaces", q, q ? 5 : 9));
      push("actions", commandResults(commands, "actions", q, q ? 6 : 6));
      // Keep still-matching history rows until the new query returns (no flicker).
      const prior = q.length >= 2 ? (this.lastHistory || []).filter(it => matchFields(q, [it.label, it.url])) : [];
      push("history", prior);
      if (q) {
        push("settings", commandResults(commands, "settings", q, 4));
        push("web", [
          {
            key: "web",
            label: `Search the web for “${q}”`,
            icon: "search",
            hint: this.engineName,
            newTabCapable: true,
            run: ({ newTab }) => webSearch(q, newTab),
          },
        ]);
      }
      this.groups = pruneWeak(groups);
      // A new query starts at the top; async history updates keep the selection.
      this.selectedKey = null;
      this.render();

      if (q.length >= 2) {
        const token = ++this.queryToken;
        const exclude = new Set(tabs.map(t => t.url).concat(url ? [url] : []));
        for (const t of gBrowser.tabs) {
          exclude.add(t.linkedBrowser?.currentURI?.spec);
        }
        queryPlaces(q, exclude)
          .then(items => {
            if (token != this.queryToken || !this.isOpen) {
              return;
            }
            this.lastHistory = items;
            this.groups = this.groups.filter(g => g.id != "history");
            if (items.length) {
              // History sits after Actions, before Settings.
              const at = this.groups.findIndex(g => g.id == "settings" || g.id == "web");
              this.groups.splice(at < 0 ? this.groups.length : at, 0, { id: "history", items });
            }
            this.groups = pruneWeak(this.groups);
            this.render();
          })
          .catch(e => log("history query failed", e));
      } else {
        this.queryToken++;
      }
    }

    render() {
      const frag = document.createDocumentFragment();
      this.items = [];
      let n = 0;
      for (const g of this.groups) {
        const labelText = GROUP_LABELS[g.id] ?? g.id;
        const labelId = "amaya-cmdbar-g-" + g.id;
        const group = h("div", {
          class: "amaya-cmd__group",
          role: "group",
          "aria-labelledby": labelText ? labelId : null,
          "aria-label": labelText ? null : "Go to address",
        });
        if (labelText) {
          group.append(h("div", { class: "amaya-cmd__label", id: labelId, role: "presentation" }, labelText));
        }
        for (const item of g.items) {
          item.group = g.id;
          item.domId = "amaya-cmdbar-o" + n++;
          this.items.push(item);
          group.append(this.renderItem(item));
        }
        frag.append(group);
      }
      this.list.textContent = "";
      this.list.append(frag);
      if (!this.items.length) {
        this.list.append(
          h("div", { class: "amaya-cmdbar__empty", role: "presentation" }, "Type to search tabs, actions and settings")
        );
      }
      const keep = this.items.find(i => i.key == this.selectedKey);
      this.select(keep ? keep.key : this.items[0]?.key, true);
    }

    renderItem(item) {
      let lead;
      if (item.fav) {
        const letter = (item.fav.letter || "?").replace(/^www\./, "").trim().charAt(0).toUpperCase() || "?";
        lead = h("span", { class: "amaya-cmdbar__fav", "aria-hidden": "true" }, letter);
        const show = src => {
          if (!src) {
            return;
          }
          const img = h("img", { class: "amaya-cmdbar__favimg", alt: "", src });
          img.addEventListener("load", () => lead.classList.add("has-img"));
          img.addEventListener("error", () => img.remove());
          lead.append(img);
        };
        if (item.fav.src) {
          show(item.fav.src);
        } else if (item.fav.page) {
          const cached = favCache.get(item.fav.page);
          if (cached !== undefined) {
            show(cached);
          } else {
            pageFavicon(item.fav.page).then(show);
          }
        }
      } else if (item.icon && item.icon.nodeType) {
        lead = item.icon.cloneNode(true);
      } else {
        lead = svgIcon(item.icon || "arrow");
      }
      const hint = h("span", { class: "amaya-cmd__hint" });
      if (item.kbd && item.kbd.length) {
        for (const k of item.kbd) {
          hint.append(h("span", { class: "amaya-kbd" }, k));
        }
      } else if (item.hint) {
        hint.append(h("span", { class: "amaya-cmdbar__hinttext" }, item.hint));
      }
      return h(
        "div",
        {
          class: "amaya-cmd__item",
          role: "option",
          id: item.domId,
          "data-key": item.key,
          "aria-selected": "false",
        },
        lead,
        h("span", { class: "amaya-cmdbar__label" }, item.label),
        hint
      );
    }

    select(key, scroll = true) {
      this.selectedKey = key || null;
      let selEl = null;
      for (const el of this.list.querySelectorAll(".amaya-cmd__item")) {
        const on = el.dataset.key == key;
        el.classList.toggle("is-selected", on);
        el.setAttribute("aria-selected", on ? "true" : "false");
        if (on) {
          selEl = el;
        }
      }
      if (selEl) {
        this.input.setAttribute("aria-activedescendant", selEl.id);
        if (scroll) {
          selEl.scrollIntoView({ block: "nearest" });
        }
      } else {
        this.input.removeAttribute("aria-activedescendant");
      }
    }

    move(delta) {
      if (!this.items.length) {
        return;
      }
      let i = this.items.findIndex(it => it.key == this.selectedKey);
      i = (i + delta + this.items.length) % this.items.length;
      this.select(this.items[i].key);
    }

    moveGroup(delta) {
      if (!this.groups.length) {
        return;
      }
      const cur = this.items.find(it => it.key == this.selectedKey);
      let gi = Math.max(0, this.groups.findIndex(g => g.id == cur?.group));
      gi = (gi + delta + this.groups.length) % this.groups.length;
      this.select(this.groups[gi].items[0].key);
    }

    runKey(key, opts = {}) {
      const item = this.items.find(it => it.key == key);
      if (!item) {
        return;
      }
      const newTab = !!opts.newTab && !!item.newTabCapable;
      // Close first (restoring focus), so the action decides where focus goes.
      this.close();
      try {
        const res = item.run({ newTab, window });
        if (res && typeof res.catch == "function") {
          res.catch(e => log("command failed", item.key, e));
        }
      } catch (e) {
        log("command failed", item.key, e);
      }
      emit("command", { id: item.id || item.key });
    }

    onKeyDown(e) {
      const accel = IS_MAC ? e.metaKey : e.ctrlKey;
      switch (e.key) {
        case "ArrowDown":
          this.move(1);
          break;
        case "ArrowUp":
          this.move(-1);
          break;
        case "PageDown":
          this.move(5);
          break;
        case "PageUp":
          this.move(-5);
          break;
        case "Tab":
          this.moveGroup(e.shiftKey ? -1 : 1);
          break;
        case "Enter":
          if (this.selectedKey) {
            this.runKey(this.selectedKey, { newTab: accel });
          }
          break;
        case "Escape":
          this.close();
          break;
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    }

    refreshIfOpen() {
      if (this.isOpen) {
        this.refresh();
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * Shortcut: take over Firefox's Ctrl/Cmd+K (key_search) while loaded.
   * ------------------------------------------------------------------ */
  let bar = null;
  let keySaved = null;
  const onKeyCommand = e => {
    e.stopPropagation();
    if (bar) {
      bar.toggle();
    }
  };

  function hijackKey() {
    const key = document.getElementById("key_search");
    if (!key) {
      log("key_search not found; Ctrl+K not bound");
      return;
    }
    keySaved = { key, command: key.getAttribute("command") };
    key.removeAttribute("command");
    key.addEventListener("command", onKeyCommand);
  }

  function restoreKey() {
    if (!keySaved) {
      return;
    }
    const { key, command } = keySaved;
    key.removeEventListener("command", onKeyCommand);
    if (command) {
      key.setAttribute("command", command);
    }
    keySaved = null;
  }

  const onRegister = e => registerCommand(e.detail);
  const onUnregister = e => unregisterCommand(e.detail && (e.detail.id || e.detail));
  const onOpenRequest = e => bar && bar.open((e.detail && e.detail.query) || "");

  ui.register(NAME, {
    init(win) {
      let root = ui.overlayRoot;
      if (!root) {
        // Degraded: no loader overlay. Make our own full-window layer.
        root = h("div", { id: "amaya-cmdbar-host", class: "amaya-cmdbar-host" });
        document.documentElement.appendChild(root);
      }
      bar = new CommandBar();
      bar.mount(root);
      hijackKey();
      window.addEventListener("amaya:register-command", onRegister);
      window.addEventListener("amaya:unregister-command", onUnregister);
      window.addEventListener("amaya:open-cmdbar", onOpenRequest);
      ui.cmdbar = {
        open: q => bar.open(q || ""),
        close: () => bar.close(),
        toggle: () => bar.toggle(),
        get isOpen() {
          return bar.isOpen;
        },
        register: registerCommand,
        unregister: unregisterCommand,
        // For tests.
        _bar: bar,
        _matchFields: matchFields,
        _urlFromInput: urlFromInput,
      };
    },
    uninit(win) {
      if (bar) {
        bar.close({ restoreFocus: false });
        bar.unmount();
        bar = null;
      }
      document.getElementById("amaya-cmdbar-host")?.remove();
      restoreKey();
      window.removeEventListener("amaya:register-command", onRegister);
      window.removeEventListener("amaya:unregister-command", onUnregister);
      window.removeEventListener("amaya:open-cmdbar", onOpenRequest);
      delete ui.cmdbar;
    },
  });
})();
