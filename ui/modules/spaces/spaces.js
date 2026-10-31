/* Amaya spaces: named, coloured sets of tabs with their own storage.
 *
 * A space has a name, one of six colours, an "isolated storage" switch and an
 * optional proxy. An isolated space owns a contextual identity (container), so
 * its cookies, local storage and cache never mix with other spaces. The first
 * space ("Personal") keeps the default storage (userContextId 0), so tabs from
 * before Amaya are not orphaned.
 *
 * Persistence
 *   spaces list      AmayaUI.store("spaces")  -> <profile>/amaya/spaces.json
 *   tab -> space     SessionStore custom tab value "amaya-space"
 *   window -> space  SessionStore custom window value "amaya-space"
 *
 * Keyboard
 *   Ctrl+1 ... Ctrl+9 (Cmd on macOS) switch to space 1 to 9. This replaces
 *   Firefox's "select tab N" shortcuts (Alt+N on Linux), which are disabled
 *   while the module is loaded.
 *
 * For other modules
 *   AmayaUI.spaces: activeId, list(), spaceForTab(tab), switchTo(id)
 *   tab attributes amaya-space-id / amaya-space-name
 *   event amaya:space-changed {id, userContextId, name, color}
 *   command-bar entries (group "spaces") in AmayaUI.commands and via
 *   amaya:register-commands detail.add()
 *
 * Proxy: a space with its own container may route through a SOCKS or HTTP
 * proxy (nsIProtocolProxyChannelFilter keyed on the channel's
 * originAttributes.userContextId). No direct fallback if the proxy is down.
 *
 * Runs in the browser window scope (privileged), see ui/README.md.
 */
(function () {
  "use strict";

  const ui = window.AmayaUI;
  const NAME = "spaces";

  // browser.js already defines both as lazy window globals.
  const ContextualIdentityService =
    window.ContextualIdentityService ||
    ChromeUtils.importESModule(
      "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
    ).ContextualIdentityService;
  const SessionStore =
    window.SessionStore ||
    ChromeUtils.importESModule("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs")
      .SessionStore;

  const COLORS = ["moss", "clay", "sky", "sand", "plum", "slate"];
  const COLOR_LABELS = {
    moss: "Moss",
    clay: "Clay",
    sky: "Sky",
    sand: "Sand",
    plum: "Plum",
    slate: "Slate",
  };
  // Container colour used by Firefox's own UI (tab line, menus) for each space colour.
  const CONTAINER_COLORS = {
    moss: "green",
    clay: "orange",
    sky: "blue",
    sand: "yellow",
    plum: "purple",
    slate: "toolbar",
  };
  const TAB_KEY = "amaya-space";
  const WIN_KEY = "amaya-space";
  const HIDE_SOURCE = "amaya-spaces";
  const UPDATED_TOPIC = "amaya-spaces-updated";
  const MAX_ROW = 8;
  const MAX_KEYS = 9;
  const IS_MAC = AppConstants.platform == "macosx";
  const ACCEL_LABEL = IS_MAC ? "⌘" : "Ctrl+";

  const log = (...a) => (ui && ui.log ? ui.log(NAME, ...a) : console.log("[amaya-ui:spaces]", ...a));

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  function newId() {
    return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function defaultProxy() {
    return { enabled: false, type: "socks", host: "", port: "" };
  }

  function defaultData() {
    return {
      version: 1,
      active: "personal",
      spaces: [
        {
          id: "personal",
          name: "Personal",
          color: "sky",
          isolated: true,
          userContextId: 0,
          proxy: defaultProxy(),
        },
      ],
    };
  }

  function normalize(data) {
    if (!data || !Array.isArray(data.spaces) || !data.spaces.length) {
      return defaultData();
    }
    let seen = new Set();
    data.spaces = data.spaces.filter(s => {
      if (!s || typeof s.id != "string" || seen.has(s.id)) {
        return false;
      }
      seen.add(s.id);
      s.name = String(s.name || "Space").slice(0, 40);
      if (!COLORS.includes(s.color)) {
        s.color = "sky";
      }
      s.isolated = s.isolated !== false;
      s.userContextId = Number.isInteger(s.userContextId) ? s.userContextId : null;
      s.proxy = Object.assign(defaultProxy(), s.proxy || {});
      return true;
    });
    if (!data.spaces.length) {
      return defaultData();
    }
    if (!data.spaces.some(s => s.id == data.active)) {
      data.active = data.spaces[0].id;
    }
    return data;
  }

  /** Whether the space uses the default storage while counted as isolated. */
  function isDefaultStore(space) {
    return space.userContextId === 0;
  }

  /** The userContextId new tabs in this space open with. */
  function ctxOf(space) {
    if (!space || !space.isolated) {
      return 0;
    }
    return space.userContextId || 0;
  }

  function identityExists(id) {
    try {
      return !!ContextualIdentityService.getPublicIdentityFromId(id)?.userContextId;
    } catch (e) {
      return false;
    }
  }

  /** Create (or re-create) the container for an isolated space. Returns true if data changed. */
  function ensureContainer(space) {
    if (!space.isolated || isDefaultStore(space)) {
      return false;
    }
    if (space.userContextId && identityExists(space.userContextId)) {
      return false;
    }
    let identity = ContextualIdentityService.create(
      space.name.trim() || "Space",
      "circle",
      CONTAINER_COLORS[space.color]
    );
    space.userContextId = identity.userContextId;
    log("created container", identity.userContextId, "for", space.name);
    return true;
  }

  function syncContainer(space) {
    if (space.userContextId > 0 && identityExists(space.userContextId)) {
      try {
        ContextualIdentityService.update(
          space.userContextId,
          space.name.trim() || "Space",
          "circle",
          CONTAINER_COLORS[space.color]
        );
      } catch (e) {
        log("container update failed", e);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Per-space proxy (channel filter keyed on originAttributes)          */
  /* ------------------------------------------------------------------ */

  const pps = Cc["@mozilla.org/network/protocol-proxy-service;1"].getService(
    Ci.nsIProtocolProxyService
  );

  function parseProxy(p) {
    if (!p || !p.enabled) {
      return null;
    }
    let host = String(p.host || "").trim();
    let port = parseInt(p.port, 10);
    if (!host || !/^[A-Za-z0-9.\-:\[\]]+$/.test(host) || !(port > 0 && port < 65536)) {
      return null;
    }
    return { type: p.type == "http" ? "http" : "socks", host: host.replace(/^\[|\]$/g, ""), port };
  }

  /** Split "host:port" typed in one field. */
  function splitHostPort(text) {
    text = String(text || "").trim();
    let m = text.match(/^\[([^\]]+)\]:(\d+)$/) || text.match(/^([^:\s]+):(\d+)$/);
    if (m) {
      return { host: m[1], port: m[2] };
    }
    return { host: text, port: "" };
  }

  const proxyFilter = {
    QueryInterface: ChromeUtils.generateQI(["nsIProtocolProxyChannelFilter"]),
    byContext: new Map(),
    applyFilter(channel, defaultProxyInfo, callback) {
      let result = defaultProxyInfo;
      try {
        let ctx = channel.loadInfo?.originAttributes?.userContextId || 0;
        let p = ctx && this.byContext.get(ctx);
        if (p) {
          let flags =
            p.type == "socks" ? Ci.nsIProxyInfo.TRANSPARENT_PROXY_RESOLVES_HOST : 0;
          // No failover proxy: if the proxy is down, loads fail instead of
          // silently going direct.
          result = pps.newProxyInfo(
            p.type,
            p.host,
            p.port,
            "",
            "amaya-space-" + ctx,
            flags,
            30,
            null
          );
        }
      } catch (e) {
        result = defaultProxyInfo;
      }
      callback.onProxyFilterResult(result);
    },
  };

  function updateProxyFilter(data) {
    proxyFilter.byContext.clear();
    for (let s of data.spaces) {
      let p = parseProxy(s.proxy);
      if (p && s.isolated && s.userContextId > 0) {
        proxyFilter.byContext.set(s.userContextId, p);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Controller (one per browser window)                                 */
  /* ------------------------------------------------------------------ */

  const S = {
    win: null,
    data: null,
    activeId: null,
    ready: false,
    store: null,
    els: {},
    cleanups: [],
    card: null,
    menu: null,
    commandIds: new Set(),
    origAddTab: null,
  };

  function space(id) {
    return S.data?.spaces.find(s => s.id == id) || null;
  }
  function activeSpace() {
    return space(S.activeId) || S.data.spaces[0];
  }

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    S.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  async function save() {
    try {
      await S.store.write(S.data);
    } catch (e) {
      log("save failed", e);
    }
    updateProxyFilter(S.data);
    Services.obs.notifyObservers(null, UPDATED_TOPIC, String(window.docShell?.outerWindowID ?? ""));
  }

  /* ---- tabs ---- */

  function setTabSpace(tab, id) {
    try {
      SessionStore.setCustomTabValue(tab, TAB_KEY, id);
    } catch (e) {
      // SessionStore not ready for this tab yet; the attribute still works for this session.
    }
    setTabAttrs(tab, id);
  }

  /** Attributes other modules can read without SessionStore. */
  function setTabAttrs(tab, id) {
    let sp = space(id);
    if (tab.getAttribute("amaya-space-id") != id) {
      tab.setAttribute("amaya-space-id", id);
    }
    if (sp && tab.getAttribute("amaya-space-name") != sp.name) {
      tab.setAttribute("amaya-space-name", sp.name);
    }
  }

  /** The space id a tab belongs to (assigning one if it has none). */
  function spaceIdOfTab(tab) {
    let id = null;
    try {
      id = SessionStore.getCustomTabValue(tab, TAB_KEY) || null;
    } catch (e) {}
    if (!id) {
      id = tab.getAttribute("amaya-space-id") || null;
    }
    if (id && space(id)) {
      setTabAttrs(tab, id);
      return id;
    }
    // Unknown or missing: infer from the tab's container.
    let ctx = tab.userContextId || 0;
    let match =
      S.data.spaces.find(s => ctx && s.userContextId == ctx) ||
      (ctx == 0 && S.data.spaces.find(s => isDefaultStore(s))) ||
      (ctx == 0 && S.data.spaces.find(s => !s.isolated)) ||
      activeSpace();
    setTabSpace(tab, match.id);
    return match.id;
  }

  function tabsOf(id) {
    return gBrowser.tabs.filter(t => !t.closing && spaceIdOfTab(t) == id);
  }

  function showTabEl(tab) {
    if (!tab.hidden) {
      return;
    }
    if (tab.pinned) {
      tab.removeAttribute("hidden");
      gBrowser.tabContainer._invalidateCachedVisibleTabs?.();
    } else {
      gBrowser.showTab(tab);
    }
  }

  function hideTabEl(tab) {
    if (tab.hidden || tab.selected || tab.closing) {
      return;
    }
    if (tab.pinned) {
      // gBrowser.hideTab refuses pinned tabs; pinned tabs belong to a space too.
      tab.setAttribute("hidden", "true");
      gBrowser.tabContainer._invalidateCachedVisibleTabs?.();
      try {
        // As hideTab does: a hidden tab must not be selected on close.
        gBrowser.replaceInSuccession(tab, gBrowser.getSuccessor(tab));
        gBrowser.setSuccessor(tab, null);
      } catch (e) {}
    } else {
      gBrowser.hideTab(tab, HIDE_SOURCE);
    }
  }

  function applyVisibility() {
    for (let tab of gBrowser.tabs) {
      if (tab.closing || tab == window.FirefoxViewHandler?.tab) {
        continue;
      }
      if (spaceIdOfTab(tab) == S.activeId) {
        showTabEl(tab);
      } else {
        hideTabEl(tab);
      }
    }
  }

  function openTabInSpace(sp, { select = true } = {}) {
    let tab = gBrowser.addTrustedTab(window.BROWSER_NEW_TAB_URL, {
      userContextId: ctxOf(sp),
      inBackground: !select,
      focusUrlBar: select,
    });
    setTabSpace(tab, sp.id);
    if (select) {
      gBrowser.selectedTab = tab;
    }
    return tab;
  }

  /**
   * Switch this window to a space.
   * @param {string} id
   * @param {object} [opts]
   * @param {MozTabbrowserTab} [opts.select] tab to select (default: the space's last used tab)
   */
  function switchTo(id, opts = {}) {
    let sp = space(id);
    if (!sp) {
      return;
    }
    let changed = id != S.activeId;
    S.activeId = id;
    let mine = tabsOf(id);
    for (let t of mine) {
      showTabEl(t);
    }
    let target = opts.select && mine.includes(opts.select) ? opts.select : null;
    if (!target && !mine.includes(gBrowser.selectedTab)) {
      target = mine.reduce((best, t) => (!best || t.lastAccessed > best.lastAccessed ? t : best), null);
    }
    if (target && gBrowser.selectedTab != target) {
      gBrowser.selectedTab = target;
    } else if (!target && !mine.includes(gBrowser.selectedTab)) {
      openTabInSpace(sp);
    }
    applyVisibility();
    try {
      SessionStore.setCustomWindowValue(window, WIN_KEY, id);
    } catch (e) {}
    if (S.data.active != id) {
      S.data.active = id;
      save();
    }
    render();
    if (changed) {
      ui.emit("space-changed", {
        id: sp.id,
        userContextId: ctxOf(sp),
        name: sp.name,
        color: sp.color,
      });
    }
  }

  /* ---- tab events ---- */

  function onTabOpen(e) {
    if (!S.ready) {
      return;
    }
    let tab = e.target;
    let id = null;
    try {
      id = SessionStore.getCustomTabValue(tab, TAB_KEY);
    } catch (err) {}
    if (!id || !space(id)) {
      // A new tab belongs to the space it was opened in; a tab opened from
      // another tab follows its container if that differs (e.g. window.open).
      let ctx = tab.userContextId || 0;
      let byCtx = ctx && S.data.spaces.find(s => s.userContextId == ctx);
      setTabSpace(tab, (byCtx || activeSpace()).id);
    }
  }

  function onTabSelect() {
    if (!S.ready) {
      return;
    }
    let id = spaceIdOfTab(gBrowser.selectedTab);
    if (id != S.activeId) {
      // Something selected a tab from another space (switch-to-tab result,
      // all-tabs menu, extension): follow it.
      switchTo(id, { select: gBrowser.selectedTab });
    }
  }

  /**
   * Called before tabs close. Firefox counts only visible tabs when deciding
   * whether a tab is the last one (and then closes the window), so closing the
   * last tab of a space would close the window with every other space in it.
   * Instead the space gets a fresh new tab first, and you stay in the space.
   */
  function beforeRemove(closing) {
    if (!S.ready || window.closed || !closing.length) {
      return;
    }
    let set = new Set(closing);
    let remaining = gBrowser.tabs.filter(t => !set.has(t) && !t.closing);
    if (!remaining.length) {
      return; // Every tab of the window is closing: Firefox decides.
    }
    if (remaining.some(t => !t.hidden)) {
      return;
    }
    let fresh = openTabInSpace(activeSpace(), { select: false });
    for (let t of closing) {
      if (t.selected) {
        try {
          gBrowser.setSuccessor(t, fresh);
        } catch (err) {}
      }
    }
  }

  function onTabRestoring(e) {
    if (!S.ready) {
      return;
    }
    let tab = e.target;
    if (spaceIdOfTab(tab) == S.activeId) {
      showTabEl(tab);
    } else {
      hideTabEl(tab);
    }
  }

  function onWindowRestored() {
    if (!S.ready) {
      return;
    }
    let id = null;
    try {
      id = SessionStore.getCustomWindowValue(window, WIN_KEY);
    } catch (e) {}
    if (!space(id)) {
      id = spaceIdOfTab(gBrowser.selectedTab);
    }
    S.activeId = null;
    switchTo(id);
  }

  /* ---- new tabs open in the current space's container ---- */

  function hookAddTab() {
    S.origAddTab = gBrowser.addTab;
    gBrowser.addTab = function (uri, params = {}) {
      try {
        if (
          S.ready &&
          params &&
          params.userContextId == null &&
          !params.skipLoad &&
          !params.createLazyBrowser &&
          params.insertTab !== false &&
          !params.openerBrowser
        ) {
          let ctx = ctxOf(activeSpace());
          if (ctx) {
            params = Object.assign({}, params, { userContextId: ctx });
          }
        }
      } catch (e) {
        log("addTab hook", e);
      }
      return S.origAddTab.call(this, uri, params);
    };
    S.origRemoveTab = gBrowser.removeTab;
    gBrowser.removeTab = function (tab, ...rest) {
      try {
        if (tab && !tab.closing) {
          beforeRemove([tab]);
        }
      } catch (e) {
        log("removeTab hook", e);
      }
      return S.origRemoveTab.call(this, tab, ...rest);
    };
    S.origRemoveTabs = gBrowser.removeTabs;
    gBrowser.removeTabs = function (tabs, ...rest) {
      try {
        beforeRemove([...(tabs || [])].filter(t => !t.closing));
      } catch (e) {
        log("removeTabs hook", e);
      }
      return S.origRemoveTabs.call(this, tabs, ...rest);
    };
  }

  function unhookTabbrowser() {
    for (let [name, key] of [
      ["addTab", "origAddTab"],
      ["removeTab", "origRemoveTab"],
      ["removeTabs", "origRemoveTabs"],
    ]) {
      if (S[key]) {
        delete gBrowser[name];
        S[key] = null;
      }
    }
  }

  /* ---- keyboard ---- */

  function setupKeys() {
    // Firefox's "select tab N" keys go to spaces instead.
    for (let i = 1; i <= 9; i++) {
      let key = document.getElementById(i == 9 ? "key_selectLastTab" : "key_selectTab" + i);
      if (key && !key.hasAttribute("disabled")) {
        key.setAttribute("disabled", "true");
        key.setAttribute("amaya-spaces-disabled", "true");
      }
    }
    let keyset = document.createXULElement("keyset");
    keyset.id = "amaya-spaces-keyset";
    for (let i = 1; i <= MAX_KEYS; i++) {
      let key = document.createXULElement("key");
      key.id = "amaya-key-space-" + i;
      key.setAttribute("key", String(i));
      key.setAttribute("modifiers", "accel");
      key.setAttribute("reserved", "true");
      key.addEventListener("command", () => {
        let sp = S.data?.spaces[i - 1];
        if (sp) {
          switchTo(sp.id);
        }
      });
      keyset.appendChild(key);
    }
    let main = document.getElementById("mainKeyset");
    (main?.parentNode || document.documentElement).appendChild(keyset);
    S.els.keyset = keyset;
  }

  function teardownKeys() {
    S.els.keyset?.remove();
    for (let key of document.querySelectorAll("key[amaya-spaces-disabled]")) {
      key.removeAttribute("disabled");
      key.removeAttribute("amaya-spaces-disabled");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Switcher UI                                                         */
  /* ------------------------------------------------------------------ */

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";

  /** HTML element helper: every prop is an attribute; null children are skipped. */
  function h(tag, props, ...children) {
    let el = document.createElementNS(HTML_NS, tag);
    for (let [k, v] of Object.entries(props || {})) {
      if (v != null && v !== false) {
        el.setAttribute(k, v);
      }
    }
    for (let c of children.flat()) {
      if (c != null) {
        el.append(c);
      }
    }
    return el;
  }

  /** Plus icon from the design set (16px, 1.5 stroke). */
  function plusIcon() {
    let svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "amaya-ico");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    let path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M12 5v14M5 12h14");
    svg.appendChild(path);
    return svg;
  }

  function colorVar(color) {
    return `var(--amaya-space-${color})`;
  }

  function keyHint(index) {
    return index < MAX_KEYS ? `${ACCEL_LABEL}${index + 1}` : "";
  }

  function buildSwitcher() {
    let root = h("div", {
      id: "amaya-spaces",
      class: "amaya-spaces",
      role: "toolbar",
      "aria-label": "Spaces",
    });
    listen(root, "keydown", onRowKeydown);
    S.els.root = root;
    return root;
  }

  /** Arrow keys move between chips (roving focus inside the row). */
  function onRowKeydown(e) {
    if (e.key != "ArrowLeft" && e.key != "ArrowRight") {
      return;
    }
    let items = [...S.els.root.querySelectorAll("button")];
    let i = items.indexOf(document.activeElement);
    if (i < 0) {
      return;
    }
    let next = items[(i + (e.key == "ArrowRight" ? 1 : -1) + items.length) % items.length];
    next.focus();
    e.preventDefault();
  }

  function visibleRowSpaces(cap) {
    let all = S.data.spaces;
    if (all.length <= cap) {
      return { row: all, overflow: [] };
    }
    let row = all.slice(0, cap);
    let act = activeSpace();
    if (!row.includes(act)) {
      row[cap - 1] = act;
    }
    return { row, overflow: all.filter(s => !row.includes(s)) };
  }

  /** Render with up to MAX_ROW chips, fewer if the row is narrower than that. */
  function render() {
    let root = S.els.root;
    if (!root || !S.data) {
      return;
    }
    if (S.ready) {
      // Keeps amaya-space-name current after a rename.
      for (let t of gBrowser.tabs) {
        if (!t.closing) {
          spaceIdOfTab(t);
        }
      }
    }
    let focusedId = document.activeElement?.closest?.("#amaya-spaces")
      ? document.activeElement.dataset.spaceId || document.activeElement.dataset.role
      : null;
    for (let cap = MAX_ROW; cap >= 1; cap--) {
      renderRow(cap);
      if (!root.isConnected || root.scrollWidth <= root.clientWidth + 1) {
        break;
      }
    }
    if (focusedId) {
      root
        .querySelector(`[data-space-id="${CSS.escape(focusedId)}"], [data-role="${CSS.escape(focusedId)}"]`)
        ?.focus();
    }
    registerCommands();
  }

  function renderRow(cap) {
    let root = S.els.root;
    root.replaceChildren();
    let { row, overflow } = visibleRowSpaces(cap);
    for (let sp of row) {
      let index = S.data.spaces.indexOf(sp);
      let active = sp.id == S.activeId;
      let hint = keyHint(index);
      let label = active ? sp.name : `${sp.name}${hint ? ` (${hint})` : ""}`;
      let btn = h(
        "button",
        {
          class: "amaya-space" + (active ? " is-active" : ""),
          style: `--c: ${colorVar(sp.color)}`,
          "aria-pressed": active ? "true" : "false",
          "data-space-id": sp.id,
          title: active ? `${sp.name}. Click to edit` : label,
          "aria-label": active ? `${sp.name}, current space. Activate to edit` : sp.name,
        },
        h("span", { class: "amaya-space__dot", "aria-hidden": "true" }),
        active ? h("span", { class: "amaya-space__name" }, sp.name) : null
      );
      btn.addEventListener("click", e => {
        if (sp.id == S.activeId) {
          openCard(sp, btn, { pointer: e.detail > 0 });
        } else {
          switchTo(sp.id);
        }
      });
      btn.addEventListener("contextmenu", e => {
        e.preventDefault();
        openCard(sp, btn, { pointer: e.button == 2 });
      });
      root.appendChild(btn);
    }
    if (overflow.length) {
      let more = h(
        "button",
        {
          class: "amaya-iconbtn amaya-spaces__more",
          "aria-label": `${overflow.length} more spaces`,
          title: `${overflow.length} more spaces`,
          "aria-haspopup": "menu",
          "data-role": "more",
        },
        h("span", { class: "amaya-spaces__count" }, `+${overflow.length}`)
      );
      more.addEventListener("click", e => openOverflow(overflow, more, { pointer: e.detail > 0 }));
      root.appendChild(more);
    }
    let add = h(
      "button",
      {
        class: "amaya-iconbtn amaya-spaces__add",
        "aria-label": "New space",
        title: "New space",
        "data-role": "add",
      },
      plusIcon()
    );
    add.addEventListener("click", e => openCard(null, add, { pointer: e.detail > 0 }));
    root.appendChild(add);
  }

  /** Re-fit the row when its container changes width (sidebar resize). */
  function observeRowWidth(container) {
    S.rowObserver?.disconnect();
    let lastWidth = -1;
    S.rowObserver = new window.ResizeObserver(entries => {
      let w = Math.round(entries[0].contentRect.width);
      if (w != lastWidth) {
        lastWidth = w;
        render();
      }
    });
    S.rowObserver.observe(container);
  }

  function mountSwitcher() {
    let root = buildSwitcher();
    let footer = ui.anchor("amaya-sidebar-footer");
    if (footer) {
      footer.appendChild(root);
      root.classList.add("is-fit");
      observeRowWidth(footer);
    } else {
      // Fallback while (or if) the shell is not loaded: a nav-bar item.
      let item = document.createXULElement("toolbaritem");
      item.id = "amaya-spaces-toolbaritem";
      item.setAttribute("removable", "false");
      item.setAttribute("label", "Spaces");
      item.appendChild(root);
      let target = document.getElementById("nav-bar-customization-target");
      target?.insertBefore(item, target.firstChild);
      S.els.toolbaritem = item;
      ui.whenAnchor("amaya-sidebar-footer", el => {
        if (!S.els.root) {
          return;
        }
        el.appendChild(S.els.root);
        S.els.root.classList.add("is-fit");
        S.els.toolbaritem?.remove();
        S.els.toolbaritem = null;
        observeRowWidth(el);
      });
    }
  }

  /* ---- popovers (card + overflow menu) ---- */

  function popoverHost() {
    return ui.overlayRoot || document.documentElement;
  }

  function place(pop, anchorEl) {
    let host = popoverHost();
    let hr = host.getBoundingClientRect();
    if (!anchorEl.isConnected) {
      // The row re-rendered while the card was open (live edits): use the active chip.
      anchorEl = anchorForCard();
    }
    let ar = anchorEl.getBoundingClientRect();
    let pr = pop.getBoundingClientRect();
    let gap = 8;
    let left = Math.max(gap, Math.min(ar.left - hr.left, hr.width - pr.width - gap));
    let top = ar.top - hr.top - pr.height - gap;
    if (top < gap) {
      top = ar.bottom - hr.top + gap; // no room above (e.g. nav-bar fallback): open below
    }
    pop.style.left = left + "px";
    pop.style.top = Math.max(gap, Math.min(top, hr.height - pr.height - gap)) + "px";
  }

  function closePopovers({ restoreFocus = true } = {}) {
    for (let key of ["card", "menu"]) {
      let p = S[key];
      if (p) {
        S[key] = null;
        p.el.remove();
        p.cleanup();
        if (restoreFocus) {
          // The row may have re-rendered (rename, recolour): fall back to the active chip.
          let target = p.returnFocus?.isConnected
            ? p.returnFocus
            : S.els.root?.querySelector(".amaya-space.is-active");
          target?.focus();
        }
      }
    }
  }

  function mountPopover(key, el, anchorEl, { pointer }) {
    closePopovers({ restoreFocus: false });
    el.classList.toggle("amaya-anim", !!pointer);
    popoverHost().appendChild(el);
    place(el, anchorEl);
    let onDown = e => {
      if (!el.contains(e.target) && !anchorEl.contains(e.target)) {
        closePopovers({ restoreFocus: false });
      }
    };
    let onKey = e => {
      if (e.key == "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePopovers();
      }
    };
    let onResize = () => place(el, anchorEl);
    window.addEventListener("mousedown", onDown, true);
    el.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    // The card grows (proxy fields, delete confirmation): keep it on screen.
    let ro = new window.ResizeObserver(onResize);
    ro.observe(el);
    S[key] = {
      el,
      returnFocus: anchorEl,
      cleanup() {
        ro.disconnect();
        window.removeEventListener("mousedown", onDown, true);
        window.removeEventListener("resize", onResize);
      },
    };
  }

  function openOverflow(list, anchorEl, opts) {
    let menu = h("div", {
      class: "amaya-spaces-menu",
      role: "menu",
      "aria-label": "More spaces",
    });
    for (let sp of list) {
      let index = S.data.spaces.indexOf(sp);
      let item = h(
        "button",
        {
          class: "amaya-spaces-menu__item",
          role: "menuitem",
          style: `--c: ${colorVar(sp.color)}`,
        },
        h("span", { class: "amaya-space__dot", "aria-hidden": "true" }),
        h("span", { class: "amaya-spaces-menu__name" }, sp.name),
        keyHint(index) ? h("span", { class: "amaya-kbd" }, keyHint(index)) : null
      );
      item.addEventListener("click", () => {
        closePopovers({ restoreFocus: false });
        switchTo(sp.id);
      });
      item.addEventListener("contextmenu", e => {
        e.preventDefault();
        openCard(sp, anchorEl, { pointer: true });
      });
      menu.appendChild(item);
    }
    menu.addEventListener("keydown", e => {
      let items = [...menu.querySelectorAll("[role=menuitem]")];
      let i = items.indexOf(document.activeElement);
      if (e.key == "ArrowDown" || e.key == "ArrowUp") {
        e.preventDefault();
        items[(i + (e.key == "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    });
    mountPopover("menu", menu, anchorEl, opts);
    menu.querySelector("[role=menuitem]")?.focus();
  }

  /* ---- the space card ---- */

  function toggle(label, checked, { disabled = false } = {}) {
    let t = h("button", {
      class: "amaya-toggle",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      "aria-label": label,
    });
    if (disabled) {
      t.setAttribute("disabled", "true");
    }
    t.addEventListener("click", () => {
      t.setAttribute("aria-checked", t.getAttribute("aria-checked") == "true" ? "false" : "true");
      t.dispatchEvent(new CustomEvent("amaya-toggle", { bubbles: false }));
    });
    return t;
  }

  /**
   * Edit-space card. With `sp == null` it is the new-space form (applies on
   * "Create space"); otherwise every change applies immediately.
   */
  function openCard(sp, anchorEl, opts = {}) {
    let creating = !sp;
    let draft = creating
      ? {
          id: newId(),
          name: "",
          color: COLORS.find(c => !S.data.spaces.some(s => s.color == c)) ||
            COLORS[S.data.spaces.length % COLORS.length],
          isolated: true,
          userContextId: null,
          proxy: defaultProxy(),
        }
      : sp;
    let uid = "amaya-space-card-" + Math.random().toString(36).slice(2, 7);

    let commit = () => {
      if (creating) {
        return;
      }
      syncContainer(draft);
      save();
      render();
      registerCommands();
    };

    // Name
    let nameInput = h("input", {
      class: "amaya-field",
      id: uid + "-name",
      type: "text",
      maxlength: "40",
      placeholder: "Name this space",
      value: draft.name,
      autocomplete: "off",
    });
    nameInput.value = draft.name;
    nameInput.addEventListener("input", () => {
      let v = nameInput.value.trim();
      if (creating) {
        createBtn.toggleAttribute("disabled", !v);
        return;
      }
      if (v) {
        draft.name = v;
        commit();
      }
    });
    nameInput.addEventListener("keydown", e => {
      if (e.key == "Enter") {
        e.preventDefault();
        if (creating && nameInput.value.trim()) {
          createBtn.click();
        } else if (!creating) {
          closePopovers();
        }
      }
    });

    // Colour
    let swatches = h("div", {
      class: "amaya-swatches",
      role: "radiogroup",
      "aria-labelledby": uid + "-colour",
    });
    let swatchButtons = COLORS.map(c => {
      let b = h("button", {
        class: "amaya-swatch" + (c == draft.color ? " is-on" : ""),
        role: "radio",
        "aria-checked": c == draft.color ? "true" : "false",
        "aria-label": COLOR_LABELS[c],
        title: COLOR_LABELS[c],
        tabindex: c == draft.color ? "0" : "-1",
        style: `--c: ${colorVar(c)}`,
      });
      b.addEventListener("click", () => pick(c));
      swatches.appendChild(b);
      return b;
    });
    function pick(c, focus) {
      draft.color = c;
      swatchButtons.forEach((b, i) => {
        let on = COLORS[i] == c;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.setAttribute("tabindex", on ? "0" : "-1");
        if (on && focus) {
          b.focus();
        }
      });
      commit();
    }
    swatches.addEventListener("keydown", e => {
      let d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (d) {
        e.preventDefault();
        e.stopPropagation();
        let i = COLORS.indexOf(draft.color);
        pick(COLORS[(i + d + COLORS.length) % COLORS.length], true);
      }
    });

    // Isolated storage
    let defaultStore = !creating && isDefaultStore(draft);
    let isoToggle = toggle("Separate logins and storage", draft.isolated, { disabled: defaultStore });
    let isoSub = h(
      "div",
      { class: "amaya-sub", id: uid + "-iso-sub" },
      defaultStore
        ? "Cookies never mix with other spaces. This space keeps your existing logins."
        : "Cookies never mix with other spaces"
    );
    isoToggle.setAttribute("aria-describedby", uid + "-iso-sub");
    isoToggle.addEventListener("amaya-toggle", () => {
      draft.isolated = isoToggle.getAttribute("aria-checked") == "true";
      if (!creating && draft.isolated) {
        ensureContainer(draft);
      }
      updateProxyAvailability();
      commit();
    });

    // Proxy
    let proxyToggle = toggle("Route through a proxy", draft.proxy.enabled);
    let proxySub = h("div", { class: "amaya-sub", id: uid + "-proxy-sub" }, "");
    proxyToggle.setAttribute("aria-describedby", uid + "-proxy-sub");
    let typeSeg = h("div", { class: "amaya-segment", role: "radiogroup", "aria-label": "Proxy type" });
    let typeButtons = ["socks", "http"].map(tp => {
      let b = h(
        "button",
        {
          role: "radio",
          class: draft.proxy.type == tp ? "is-on" : "",
          "aria-checked": draft.proxy.type == tp ? "true" : "false",
        },
        tp == "socks" ? "SOCKS" : "HTTP"
      );
      b.addEventListener("click", () => {
        draft.proxy.type = tp;
        typeButtons.forEach(x => {
          let on = x == b;
          x.classList.toggle("is-on", on);
          x.setAttribute("aria-checked", on ? "true" : "false");
        });
        commit();
      });
      typeSeg.appendChild(b);
      return b;
    });
    let hostInput = h("input", {
      class: "amaya-field",
      type: "text",
      placeholder: "host:port",
      "aria-label": "Proxy address, host and port",
      spellcheck: "false",
      autocomplete: "off",
    });
    hostInput.value = draft.proxy.host
      ? (draft.proxy.host.includes(":") ? `[${draft.proxy.host}]` : draft.proxy.host) +
        (draft.proxy.port ? ":" + draft.proxy.port : "")
      : "";
    let proxyNote = h("div", { class: "amaya-sub amaya-spaces-card__note", role: "status" }, "");
    hostInput.addEventListener("input", () => {
      let { host, port } = splitHostPort(hostInput.value);
      draft.proxy.host = host;
      draft.proxy.port = port;
      validateProxy();
      commit();
    });
    let proxyFields = h("div", { class: "amaya-spaces-card__proxy" }, typeSeg, hostInput, proxyNote);
    proxyToggle.addEventListener("amaya-toggle", () => {
      draft.proxy.enabled = proxyToggle.getAttribute("aria-checked") == "true";
      proxyFields.hidden = !draft.proxy.enabled;
      validateProxy();
      commit();
      if (draft.proxy.enabled) {
        hostInput.focus();
      }
    });
    function validateProxy() {
      if (!draft.proxy.enabled) {
        proxyNote.textContent = "";
        return;
      }
      proxyNote.textContent = parseProxy(draft.proxy)
        ? "Pages in this space load through this proxy. If it is down, they do not load."
        : "Enter the proxy as host:port, for example 127.0.0.1:9050.";
    }
    function updateProxyAvailability() {
      // The proxy follows the space's own container, so it needs separate storage.
      let ok = draft.isolated && !isDefaultStore(draft);
      proxyToggle.toggleAttribute("disabled", !ok);
      if (!ok && draft.proxy.enabled) {
        draft.proxy.enabled = false;
        proxyToggle.setAttribute("aria-checked", "false");
      }
      proxyFields.hidden = !ok || !draft.proxy.enabled;
      proxySub.textContent = ok
        ? "Use your VPN or proxy for this space"
        : "Needs separate logins and storage in this space";
      validateProxy();
    }
    updateProxyAvailability();

    // Footer
    let footer = h("div", { class: "amaya-spaces-card__footer" });
    let createBtn = h("button", { class: "amaya-btn amaya-btn--primary" }, "Create space");
    if (creating) {
      let cancel = h("button", { class: "amaya-btn amaya-btn--quiet" }, "Cancel");
      cancel.addEventListener("click", () => closePopovers());
      createBtn.toggleAttribute("disabled", !draft.name);
      createBtn.addEventListener("click", () => {
        let v = nameInput.value.trim();
        if (!v) {
          nameInput.focus();
          return;
        }
        draft.name = v;
        createSpace(draft);
        closePopovers({ restoreFocus: false });
        S.els.root?.querySelector(".amaya-space.is-active")?.focus();
      });
      footer.append(cancel, createBtn);
    } else {
      let del = h("button", { class: "amaya-btn amaya-btn--quiet amaya-btn--danger" }, "Delete space");
      if (S.data.spaces.length < 2) {
        del.setAttribute("disabled", "true");
        del.setAttribute("title", "You need at least one space");
      }
      del.addEventListener("click", () => confirmDelete());
      footer.append(del);
    }

    function confirmDelete() {
      let n = tabsAllWindows(draft.id).length;
      let msg =
        `Delete ${draft.name}? ` +
        (n ? `Its ${n == 1 ? "tab closes" : n + " tabs close"}` : "Nothing is open in it") +
        (draft.isolated && draft.userContextId > 0
          ? ", and its cookies and site data are removed."
          : ".");
      let cancel = h("button", { class: "amaya-btn" }, "Keep space");
      let ok = h("button", { class: "amaya-btn amaya-btn--danger-solid" }, "Delete space");
      cancel.addEventListener("click", () => {
        confirm.replaceWith(footer);
        footer.querySelector("button")?.focus();
      });
      ok.addEventListener("click", () => {
        closePopovers({ restoreFocus: false });
        deleteSpace(draft.id);
        S.els.root?.querySelector(".amaya-space.is-active")?.focus();
      });
      let confirm = h(
        "div",
        { class: "amaya-spaces-card__confirm", role: "alertdialog", "aria-label": "Delete space" },
        h("div", { class: "amaya-sub amaya-spaces-card__warn" }, msg),
        h("div", { class: "amaya-spaces-card__footer" }, cancel, ok)
      );
      footer.replaceWith(confirm);
      cancel.focus();
    }

    let titleId = uid + "-title";
    let card = h(
      "div",
      {
        class: "amaya-card amaya-spaces-card",
        role: "dialog",
        "aria-labelledby": titleId,
      },
      h("div", { class: "amaya-title", id: titleId }, creating ? "New space" : "Edit space"),
      h(
        "div",
        { class: "amaya-spaces-card__group" },
        h("label", { class: "amaya-label", for: uid + "-name" }, "Name"),
        nameInput
      ),
      h(
        "div",
        { class: "amaya-spaces-card__group" },
        h("div", { class: "amaya-label", id: uid + "-colour" }, "Colour"),
        swatches
      ),
      h("div", { class: "amaya-row" }, h("div", null, h("div", null, "Separate logins and storage"), isoSub), isoToggle),
      h(
        "div",
        { class: "amaya-row" },
        h("div", null, h("div", null, "Route through a proxy"), proxySub),
        proxyToggle
      ),
      proxyFields,
      footer
    );
    card.style.setProperty("--c", colorVar(draft.color));
    mountPopover("card", card, anchorEl, opts);
    nameInput.focus();
    if (!creating) {
      nameInput.select();
    }
  }

  /* ---- create / delete ---- */

  function createSpace(draft) {
    let sp = {
      id: draft.id,
      name: draft.name,
      color: draft.color,
      isolated: draft.isolated,
      userContextId: null,
      proxy: Object.assign(defaultProxy(), draft.proxy),
    };
    if (sp.isolated) {
      ensureContainer(sp);
    } else {
      sp.proxy.enabled = false;
    }
    S.data.spaces.push(sp);
    save();
    switchTo(sp.id);
    return sp;
  }

  function browserWindows() {
    return [...Services.wm.getEnumerator("navigator:browser")].filter(w => !w.closed && w.gBrowser);
  }

  function tabsAllWindows(id) {
    let out = [];
    for (let w of browserWindows()) {
      for (let t of w.gBrowser.tabs) {
        let v = null;
        try {
          v = SessionStore.getCustomTabValue(t, TAB_KEY) || t.getAttribute("amaya-space-id");
        } catch (e) {}
        if (v == id && !t.closing) {
          out.push({ win: w, tab: t });
        }
      }
    }
    return out;
  }

  async function deleteSpace(id) {
    let sp = space(id);
    if (!sp || S.data.spaces.length < 2) {
      return;
    }
    let idx = S.data.spaces.indexOf(sp);
    if (S.activeId == id) {
      let next = S.data.spaces[idx + 1] || S.data.spaces[idx - 1];
      switchTo(next.id);
    }
    S.data.spaces.splice(idx, 1);
    if (S.data.active == id) {
      S.data.active = S.activeId;
    }
    for (let { win, tab } of tabsAllWindows(id)) {
      win.gBrowser.removeTab(tab, { animate: false, skipPermitUnload: true });
    }
    let ctx = sp.userContextId;
    if (ctx > 0) {
      try {
        await ContextualIdentityService.closeContainerTabs(ctx, { skipPermitUnload: true });
      } catch (e) {}
      // Removes the container and clears its cookies and site data.
      ContextualIdentityService.remove(ctx);
    }
    await save();
    render();
  }

  /* ------------------------------------------------------------------ */
  /* Command bar                                                         */
  /* ------------------------------------------------------------------ */

  /*
   * The command bar reads `AmayaUI.commands` (an array; same id replaces) and
   * fires `amaya:register-commands` with `detail.add(cmd)` each time it opens.
   * Both are fed the same list, so entries are always current.
   */
  function anchorForCard() {
    return (
      S.els.root?.querySelector(".amaya-space.is-active") ||
      S.els.root ||
      document.getElementById("nav-bar")
    );
  }

  function buildCommands() {
    if (!S.data) {
      return [];
    }
    let cmds = [
      {
        id: "spaces.new",
        label: "New space",
        icon: "plus",
        group: "spaces",
        run: () => openCard(null, anchorForCard(), { pointer: false }),
      },
      {
        id: "spaces.edit",
        label: "Edit space",
        icon: "gear",
        hint: activeSpace().name,
        group: "spaces",
        run: () => openCard(activeSpace(), anchorForCard(), { pointer: false }),
      },
    ];
    S.data.spaces.forEach((sp, i) => {
      cmds.push({
        id: "spaces.switch." + sp.id,
        label: `Switch to ${sp.name}`,
        icon: "arrow",
        hint: keyHint(i),
        color: sp.color,
        group: "spaces",
        run: () => switchTo(sp.id),
      });
    });
    return cmds;
  }

  /** Sync our entries into AmayaUI.commands (add/replace ours, drop stale ones). */
  function registerCommands() {
    let cmds = buildCommands();
    let list = (ui.commands ||= []);
    if (!Array.isArray(list)) {
      return;
    }
    let ids = new Set(cmds.map(c => c.id));
    for (let i = list.length - 1; i >= 0; i--) {
      let id = list[i]?.id;
      if (typeof id == "string" && id.startsWith("spaces.") && (S.commandIds.has(id) || !ids.has(id))) {
        list.splice(i, 1);
      }
    }
    list.push(...cmds);
    S.commandIds = ids;
  }

  function unregisterCommands() {
    if (Array.isArray(ui.commands)) {
      for (let i = ui.commands.length - 1; i >= 0; i--) {
        if (S.commandIds.has(ui.commands[i]?.id)) {
          ui.commands.splice(i, 1);
        }
      }
    }
    S.commandIds = new Set();
  }

  /* ------------------------------------------------------------------ */
  /* Cross-window sync                                                   */
  /* ------------------------------------------------------------------ */

  const syncObserver = {
    QueryInterface: ChromeUtils.generateQI(["nsIObserver", "nsISupportsWeakReference"]),
    async observe(subject, topic, data) {
      if (topic == UPDATED_TOPIC) {
        if (data == String(window.docShell?.outerWindowID ?? "")) {
          return;
        }
        S.data = normalize(await S.store.read());
        updateProxyFilter(S.data);
        if (!space(S.activeId)) {
          S.activeId = null;
          switchTo(spaceIdOfTab(gBrowser.selectedTab));
        } else {
          applyVisibility();
          render();
        }
      } else if (topic == "contextual-identity-deleted") {
        let ctx = subject?.wrappedJSObject?.userContextId;
        let sp = ctx && S.data?.spaces.find(s => s.userContextId == ctx);
        if (sp) {
          // Removed elsewhere (for example in settings): a new one is made on next use.
          sp.userContextId = null;
        }
      }
    },
  };

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async function start() {
    S.store = ui.store("spaces");
    let raw = null;
    try {
      raw = await S.store.read();
    } catch (e) {
      log("read failed, starting fresh", e);
    }
    if (window.closed) {
      return;
    }
    let firstRun = !raw || !Array.isArray(raw.spaces);
    S.data = normalize(raw);
    let dirty = firstRun;
    for (let sp of S.data.spaces) {
      dirty = ensureContainer(sp) || dirty;
    }
    updateProxyFilter(S.data);

    let winId = null;
    try {
      winId = SessionStore.getCustomWindowValue(window, WIN_KEY);
    } catch (e) {}
    S.ready = true;
    // A restored window returns to its space; a fresh one starts in the
    // space of its first tab.
    let start = space(winId) ? winId : spaceIdOfTab(gBrowser.selectedTab);
    if (dirty) {
      await save();
    }
    S.activeId = null;
    switchTo(start);
    log("ready:", S.data.spaces.length, "spaces, active", S.activeId);
  }

  function init() {
    S.win = window;
    hookAddTab();
    setupKeys();
    mountSwitcher();
    let tc = gBrowser.tabContainer;
    listen(tc, "TabOpen", onTabOpen);
    listen(tc, "TabSelect", onTabSelect);
    listen(tc, "SSTabRestoring", onTabRestoring);
    listen(window, "SSWindowRestored", onWindowRestored);
    let offRegister = ui.on("register-commands", e => {
      let add = e?.detail?.add;
      if (typeof add == "function") {
        for (let cmd of buildCommands()) {
          add(cmd);
        }
      }
    });
    if (typeof offRegister == "function") {
      S.cleanups.push(offRegister);
    }
    Services.obs.addObserver(syncObserver, UPDATED_TOPIC, true);
    Services.obs.addObserver(syncObserver, "contextual-identity-deleted", true);
    pps.registerChannelFilter(proxyFilter, 0);
    start().catch(e => log("start failed", e));
  }

  function uninit() {
    closePopovers({ restoreFocus: false });
    for (let fn of S.cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {}
    }
    try {
      Services.obs.removeObserver(syncObserver, UPDATED_TOPIC);
      Services.obs.removeObserver(syncObserver, "contextual-identity-deleted");
    } catch (e) {}
    try {
      pps.unregisterChannelFilter(proxyFilter);
    } catch (e) {}
    unhookTabbrowser();
    teardownKeys();
    S.rowObserver?.disconnect();
    S.rowObserver = null;
    unregisterCommands();
    S.els.root?.remove();
    S.els.toolbaritem?.remove();
    // Leave the window with every tab visible.
    for (let t of gBrowser.tabs) {
      showTabEl(t);
    }
    S.ready = false;
    S.els = {};
  }

  function publicSpace(sp) {
    return sp ? { id: sp.id, name: sp.name, color: sp.color, userContextId: ctxOf(sp) } : null;
  }

  // API for other modules (AmayaUI.spaces) and tests (window.AmayaSpaces).
  const api = {
    get activeId() {
      return S.activeId;
    },
    list() {
      return S.data ? S.data.spaces.map(publicSpace) : [];
    },
    spaceForTab(tab) {
      return S.ready && tab ? publicSpace(space(spaceIdOfTab(tab))) : null;
    },
    get spaces() {
      return S.data ? S.data.spaces.map(s => Object.assign({}, s, { proxy: Object.assign({}, s.proxy) })) : [];
    },
    get active() {
      return S.data ? Object.assign({}, activeSpace()) : null;
    },
    get ready() {
      return S.ready;
    },
    switchTo,
    create(name, color = "moss", { isolated = true } = {}) {
      return createSpace({ id: newId(), name, color, isolated, proxy: defaultProxy() }).id;
    },
    update(id, changes) {
      let sp = space(id);
      if (!sp) {
        return;
      }
      if (changes.proxy) {
        sp.proxy = Object.assign(sp.proxy, changes.proxy);
      }
      for (let k of ["name", "color", "isolated"]) {
        if (k in changes) {
          sp[k] = changes[k];
        }
      }
      ensureContainer(sp);
      syncContainer(sp);
      save();
      render();
    },
    remove: deleteSpace,
    spaceOfTab: tab => spaceIdOfTab(tab),
    newTab: () => openTabInSpace(activeSpace()),
    edit: id => openCard(space(id) || activeSpace(), anchorForCard(), { pointer: false }),
    newSpaceCard: () => openCard(null, anchorForCard(), { pointer: false }),
    contextOf: id => ctxOf(space(id)),
  };
  window.AmayaSpaces = api;
  ui.spaces = api;

  ui.register(NAME, {
    init,
    uninit() {
      uninit();
      delete window.AmayaSpaces;
      if (ui.spaces === api) {
        delete ui.spaces;
      }
    },
  });
})();
