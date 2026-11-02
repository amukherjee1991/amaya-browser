/* Amaya shell module.
 *
 * Turns Gecko's native vertical tabs + revamped sidebar into the Amaya
 * sidebar: top row (collapse, back, forward, reload, menu), the real #urlbar moved
 * into the sidebar, pinned tabs as a 3-column tile grid, tab rows, a "New tab"
 * row and a footer for the space switcher. Hides the top bars, turns the web
 * view into one inset card and adds compact mode (52px, slides out on hover).
 *
 * Shared anchors created here (see ui/README.md): #amaya-sidebar,
 * #amaya-sidebar-top, #amaya-urlbar-slot, #amaya-pins, #amaya-sidebar-footer.
 *
 * Events: emits "shell-compact" { compact, collapsed } when compact mode
 * changes. Root attributes: [amaya-shell] while active, [amaya-compact] in
 * compact mode.
 */
(function () {
  "use strict";

  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const NAME = "shell";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const PREF_COMPACT = "amaya.ui.shell.compact";
  const NARROW_WINDOW = 720;
  const SIDEBAR_WIDTH = 264;
  const SIDEBAR_INSET = 8;

  // Fallback paths in the design-system icon style, used when ui.icon() does
  // not provide one.
  const ICON_PATHS = {
    sidebar: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 5v14"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    forward: '<path d="M9 6l6 6-6 6"/>',
    reload: '<path d="M19 12a7 7 0 11-2.05-4.95"/><path d="M19 5v4h-4"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };

  let state = null;

  const log = (...args) => {
    try {
      ui.log(NAME, ...args);
    } catch (e) {
      console.log(`[amaya-ui:${NAME}]`, ...args);
    }
  };

  /* ---------------------------------------------------------------- */
  /* Helpers                                                           */
  /* ---------------------------------------------------------------- */

  function html(doc, tag, attrs = {}, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) {
        continue;
      }
      el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) {
      if (c) {
        el.append(c);
      }
    }
    return el;
  }

  function icon(doc, name) {
    let node = null;
    try {
      const got = ui.icon?.(name);
      if (got && typeof got == "object" && got.nodeType == 1) {
        node = got;
      } else if (typeof got == "string" && got.includes("<svg")) {
        const parsed = new DOMParser().parseFromString(got, "image/svg+xml");
        if (parsed.documentElement?.localName == "svg") {
          node = doc.importNode(parsed.documentElement, true);
        }
      }
    } catch (e) {
      node = null;
    }
    if (!node || !node.childElementCount) {
      node = doc.createElementNS(SVG_NS, "svg");
      node.setAttribute("viewBox", "0 0 24 24");
      const parsed = new DOMParser().parseFromString(
        `<svg xmlns="${SVG_NS}">${ICON_PATHS[name] || ""}</svg>`,
        "image/svg+xml"
      );
      for (const c of parsed.documentElement.childNodes) {
        node.append(doc.importNode(c, true));
      }
    }
    node.classList.add("amaya-ico");
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("focusable", "false");
    return node;
  }

  function shortcutLabel(win, key, { shift = false } = {}) {
    const mac = win.AppConstants.platform == "macosx";
    const parts = [mac ? "Cmd" : "Ctrl"];
    if (shift) {
      parts.push("Shift");
    }
    parts.push(key);
    return parts.join("+");
  }

  function setPrefIfUnset(prefs, name, value) {
    try {
      if (prefs.prefHasUserValue(name) || prefs.prefIsLocked(name)) {
        return;
      }
      const cur =
        typeof value == "boolean"
          ? prefs.getBoolPref(name, !value)
          : prefs.getStringPref(name, "");
      if (cur === value) {
        return;
      }
      if (typeof value == "boolean") {
        prefs.setBoolPref(name, value);
      } else {
        prefs.setStringPref(name, value);
      }
    } catch (e) {
      log("pref", name, e);
    }
  }

  /** Remember where a node was so uninit can put it back. */
  function moveNode(node, newParent, before = null) {
    if (!node || !newParent) {
      return;
    }
    state.moved.push({
      node,
      parent: node.parentNode,
      next: node.nextSibling,
    });
    newParent.insertBefore(node, before);
  }

  function restoreMovedNodes() {
    for (const { node, parent, next } of state.moved.reverse()) {
      try {
        if (!parent) {
          continue;
        }
        if (next && next.parentNode == parent) {
          parent.insertBefore(node, next);
        } else {
          parent.appendChild(node);
        }
      } catch (e) {
        log("restore", e);
      }
    }
    state.moved = [];
  }

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    state.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function setAttr(el, name, value) {
    if (!el) {
      return;
    }
    const had = el.hasAttribute(name);
    const old = el.getAttribute(name);
    state.cleanups.push(() => {
      if (had) {
        el.setAttribute(name, old);
      } else {
        el.removeAttribute(name);
      }
    });
    el.setAttribute(name, value);
  }

  const sleep = (win, ms) => new Promise(r => win.setTimeout(r, ms));

  async function waitFor(win, test, timeoutMs = 10000) {
    const start = Date.now();
    while (!test()) {
      if (!state || win.closed || Date.now() - start > timeoutMs) {
        return false;
      }
      await sleep(win, 50);
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Prefs                                                             */
  /* ---------------------------------------------------------------- */

  function ensurePrefs(prefs) {
    // The Amaya layout is the native revamped sidebar with vertical tabs.
    setPrefIfUnset(prefs, "sidebar.revamp", true);
    setPrefIfUnset(prefs, "sidebar.verticalTabs", true);
    // Hover slide-out in compact mode uses the design's sidebar duration.
    try {
      prefs
        .getDefaultBranch("")
        .setIntPref("sidebar.animation.expand-on-hover.duration-ms", 200);
      prefs
        .getDefaultBranch("")
        .setIntPref("sidebar.animation.duration-ms", 200);
    } catch (e) {
      log("pref defaults", e);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Building                                                          */
  /* ---------------------------------------------------------------- */

  function sidebarReady(win) {
    const doc = win.document;
    const vt = doc.getElementById("vertical-tabs");
    const container = doc.getElementById("sidebar-container");
    return (
      win.SidebarController?.sidebarMain &&
      container &&
      !container.hidden &&
      vt &&
      vt.contains(doc.getElementById("tabbrowser-tabs"))
    );
  }

  function buildTopRow(win, doc) {
    const top = html(doc, "div", {
      id: "amaya-sidebar-top",
      class: "amaya-sidebar__top",
    });

    const collapse = html(
      doc,
      "button",
      {
        id: "amaya-collapse-button",
        class: "amaya-iconbtn",
        type: "button",
        "aria-label": "Collapse sidebar",
        "aria-controls": "amaya-sidebar",
        "aria-expanded": "true",
        title: `Collapse sidebar (${shortcutLabel(win, "S", { shift: true })})`,
      },
      icon(doc, "sidebar")
    );
    collapse.addEventListener("click", () => toggleCompact(win));

    const back = html(
      doc,
      "button",
      {
        id: "amaya-back-button",
        class: "amaya-iconbtn",
        type: "button",
        "aria-label": "Back",
        title: "Back",
      },
      icon(doc, "back")
    );
    const forward = html(
      doc,
      "button",
      {
        id: "amaya-forward-button",
        class: "amaya-iconbtn",
        type: "button",
        "aria-label": "Forward",
        title: "Forward",
      },
      icon(doc, "forward")
    );

    const navigate = (btn, dir) => {
      const run = e => {
        if (btn.disabled) {
          return;
        }
        if (e.type == "auxclick" && e.button != 1) {
          return;
        }
        if (dir == "back") {
          win.BrowserCommands.back(e);
        } else {
          win.BrowserCommands.forward(e);
        }
      };
      btn.addEventListener("click", run);
      btn.addEventListener("auxclick", run);
      btn.addEventListener("contextmenu", e => {
        e.preventDefault();
        const menu = doc.getElementById("backForwardMenu");
        menu?.openPopup(btn, "after_start", 0, 0, true, false, e);
      });
    };
    navigate(back, "back");
    navigate(forward, "forward");

    // Reload, or stop while the page loads (Firefox's combined button):
    // shift bypasses the cache, middle click duplicates the tab.
    const reloadIcon = icon(doc, "reload");
    reloadIcon.classList.add("amaya-reload-ico");
    const stopIcon = icon(doc, "close");
    stopIcon.classList.add("amaya-stop-ico");
    const reload = html(
      doc,
      "button",
      {
        id: "amaya-reload-button",
        class: "amaya-iconbtn",
        type: "button",
      },
      reloadIcon,
      stopIcon
    );
    const reloadOrStop = e => {
      if (e.type == "auxclick" && e.button != 1) {
        return;
      }
      if (reload.hasAttribute("loading")) {
        win.BrowserCommands.stop();
      } else {
        win.BrowserCommands.reloadOrDuplicate(e);
      }
    };
    reload.addEventListener("click", reloadOrStop);
    reload.addEventListener("auxclick", reloadOrStop);

    // Mirror the enabled state of the native commands.
    const sync = () => {
      back.disabled =
        doc.getElementById("Browser:Back")?.getAttribute("disabled") == "true";
      forward.disabled =
        doc.getElementById("Browser:Forward")?.getAttribute("disabled") ==
        "true";
      // Browser:Stop is enabled exactly while the selected tab is loading.
      const stopCmd = doc.getElementById("Browser:Stop");
      const loading = !!stopCmd && !stopCmd.hasAttribute("disabled");
      reload.toggleAttribute("loading", loading);
      const label = loading ? "Stop" : "Reload";
      reload.setAttribute("aria-label", label);
      reload.title = loading
        ? "Stop (Esc)"
        : `Reload (${shortcutLabel(win, "R")})`;
    };
    const mo = new win.MutationObserver(sync);
    for (const id of ["Browser:Back", "Browser:Forward", "Browser:Stop"]) {
      const cmd = doc.getElementById(id);
      if (cmd) {
        mo.observe(cmd, { attributes: true, attributeFilter: ["disabled"] });
      }
    }
    state.cleanups.push(() => mo.disconnect());
    sync();

    const spacer = html(doc, "span", {
      class: "amaya-shell-spacer",
      "aria-hidden": "true",
    });

    top.append(collapse, spacer, back, forward, reload);
    return { top, collapse };
  }

  function buildUrlbarSlot(doc) {
    // A XUL <toolbar> so the urlbar keeps showing its results in the top
    // layer (UrlbarInput only uses its popover inside a toolbar).
    const slot = doc.createXULElement("toolbar");
    slot.id = "amaya-urlbar-slot";
    slot.className = "amaya-urlbar-slot";
    slot.setAttribute("mode", "icons");
    return slot;
  }

  function moveChromeIntoTopRow(win, doc, top) {
    // The app menu ("the single overflow menu"). The extensions button is
    // placed by the extensions module.
    const menuItem = doc.getElementById("PanelUI-button");
    if (menuItem) {
      moveNode(menuItem, top);
      const btn = doc.getElementById("PanelUI-menu-button");
      if (btn && !btn.getAttribute("aria-label")) {
        setAttr(btn, "aria-label", "Menu");
      }
    }

    // Native window controls (Linux/Windows client-side decorations, macOS
    // traffic lights): first on macOS, last elsewhere.
    const navBar = doc.getElementById("nav-bar");
    const box = navBar?.querySelector(":scope > .titlebar-buttonbox-container");
    if (box) {
      if (win.AppConstants.platform == "macosx") {
        moveNode(box, top, top.firstChild);
      } else {
        moveNode(box, top);
      }
    }
  }

  function injectShadowStyles(win, sidebarMain) {
    const root = sidebarMain.shadowRoot;
    if (!root) {
      return;
    }
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(`
      .wrapper { width: 100% !important; height: 100%; }
      .buttons-wrapper,
      #sidebar-tools-and-extensions-splitter { display: none !important; }
    `);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    state.cleanups.push(() => {
      root.adoptedStyleSheets = root.adoptedStyleSheets.filter(s => s != sheet);
    });
  }

  function relabelNewTab(doc) {
    // Sentence case per the design voice. Fluent would put "New Tab" back,
    // so the l10n id is lifted while the shell runs (restored on uninit).
    for (const id of ["tabs-newtab-button", "vertical-tabs-newtab-button"]) {
      const b = doc.getElementById(id);
      if (b) {
        if (b.hasAttribute("data-l10n-id")) {
          setAttr(b, "data-l10n-id", b.getAttribute("data-l10n-id"));
          b.removeAttribute("data-l10n-id");
        }
        setAttr(b, "label", "New tab");
        setAttr(b, "tooltiptext", "New tab");
        setAttr(b, "aria-label", "New tab");
      }
    }
  }

  /* Sites without a favicon show a neutral square with their first letter. */
  function updateTabLetter(tab) {
    const stack = tab?.querySelector?.(".tab-icon-stack");
    if (!stack) {
      return;
    }
    const noIcon = !tab.getAttribute("image");
    let letter = "";
    if (noIcon) {
      let host = "";
      try {
        host = tab.linkedBrowser?.currentURI?.host || "";
      } catch (e) {}
      const source = (tab.label || host.replace(/^www\./, "") || "").trim();
      letter = (source.match(/[\p{L}\p{N}]/u) || [""])[0].toUpperCase();
    }
    if (noIcon && letter) {
      stack.setAttribute("amaya-letter", letter);
      tab.setAttribute("amaya-letter-icon", "true");
    } else {
      stack.removeAttribute("amaya-letter");
      tab.removeAttribute("amaya-letter-icon");
    }
  }

  function watchTabLetters(win) {
    const gb = win.gBrowser;
    for (const t of gb.tabs) {
      updateTabLetter(t);
    }
    const onTab = e => updateTabLetter(e.target);
    for (const type of ["TabAttrModified", "TabOpen", "TabPinned", "TabUnpinned"]) {
      listen(gb.tabContainer, type, onTab);
    }
    state.cleanups.push(() => {
      for (const t of gb.tabs) {
        t.removeAttribute("amaya-letter-icon");
        t.querySelector(".tab-icon-stack")?.removeAttribute("amaya-letter");
      }
    });
  }

  async function build(win) {
    const doc = win.document;
    const ok = await waitFor(win, () => sidebarReady(win));
    if (!state) {
      return;
    }
    if (!ok) {
      log("vertical tabs did not become ready; shell not applied");
      return;
    }
    await win.SidebarController.waitUntilStable?.();
    if (!state) {
      return;
    }

    const sidebarMain = win.SidebarController.sidebarMain;
    const verticalTabs = doc.getElementById("vertical-tabs");

    const sidebar = html(doc, "div", {
      id: "amaya-sidebar",
      class: "amaya-sidebar",
      role: "navigation",
      "aria-label": "Sidebar",
      slot: "tabstrip",
    });
    const { top, collapse } = buildTopRow(win, doc);
    const slot = buildUrlbarSlot(doc);
    const pins = html(doc, "div", {
      id: "amaya-pins",
      class: "amaya-pins",
      "aria-hidden": "true",
    });
    const footer = html(doc, "div", {
      id: "amaya-sidebar-footer",
      class: "amaya-sidebar__footer",
    });
    state.collapse = collapse;
    state.sidebar = sidebar;

    sidebarMain.insertBefore(sidebar, verticalTabs);
    state.nodes.push(sidebar);
    sidebar.append(top, slot, pins);
    moveNode(verticalTabs, sidebar);
    sidebar.append(footer);

    moveChromeIntoTopRow(win, doc, top);

    // The real address field.
    const urlbar = doc.getElementById("urlbar");
    if (urlbar) {
      moveNode(urlbar, slot);
    }

    // The top bar is hidden by shell.css (display: none, not collapsed, so
    // Firefox does not treat it as a collapsed toolbar and pull pinned
    // extensions out of it: the extensions module shows those).

    injectShadowStyles(win, sidebarMain);
    relabelNewTab(doc);
    watchTabLetters(win);

    // Other modules (the command bar) can ask for the same toggle.
    try {
      const off = ui.on("toggle-compact", () => toggleCompact(win));
      if (typeof off == "function") {
        state.cleanups.push(off);
      }
    } catch (e) {
      log("toggle-compact listener", e);
    }

    // Default width 264 + the window inset, unless the user resized it.
    const st = win.SidebarController._state;
    if (st && !st.expandedLauncherWidth) {
      st.expandedLauncherWidth = SIDEBAR_WIDTH + SIDEBAR_INSET;
    }

    // Keep the compact attributes in sync with the launcher state.
    const container = doc.getElementById("sidebar-container");
    const amo = new win.MutationObserver(() => syncCollapsedState(win));
    amo.observe(container, {
      attributes: true,
      attributeFilter: ["sidebar-launcher-expanded"],
    });
    state.cleanups.push(() => amo.disconnect());

    // Floating address field while collapsed in compact mode.
    // It stays up while focus is anywhere in it (the privacy shield) or one
    // of its popups is open (the privacy panel, aria-expanded="true").
    if (urlbar) {
      const mo = new win.MutationObserver(() => syncFloatingUrlbar(win));
      mo.observe(urlbar, {
        attributes: true,
        subtree: true,
        attributeFilter: ["focused", "aria-expanded"],
      });
      state.cleanups.push(() => mo.disconnect());
      listen(urlbar, "focusin", () => syncFloatingUrlbar(win));
      listen(urlbar, "focusout", () => syncFloatingUrlbar(win));
      // A press on a control inside it (the shield) blurs the input before
      // the click lands: hold the field in place until the click is done.
      listen(urlbar, "mousedown", () => {
        state.holdFloating = true;
      }, true);
      listen(win, "mouseup", () => {
        if (state.holdFloating) {
          win.setTimeout(() => {
            if (state) {
              state.holdFloating = false;
              syncFloatingUrlbar(win);
            }
          }, 0);
        }
      }, true);
    }

    listen(win, "keydown", e => onKeyDown(win, e), true);
    listen(win, "resize", () => onResize(win));

    // Start compact below 720px, otherwise use the saved state.
    const saved = ui.prefs.getBoolPref(PREF_COMPACT, false);
    state.narrow = win.innerWidth < NARROW_WINDOW;
    await applyCompact(win, saved || state.narrow, { initial: true });

    state.ready = true;
    log("ready");
  }

  /* ---------------------------------------------------------------- */
  /* Compact mode                                                      */
  /* ---------------------------------------------------------------- */

  function isCompact(win) {
    return win.document.documentElement.hasAttribute("amaya-compact");
  }

  function syncCollapsedState(win) {
    if (!state) {
      return;
    }
    const doc = win.document;
    const compact = isCompact(win);
    const container = doc.getElementById("sidebar-container");
    const expanded = container?.hasAttribute("sidebar-launcher-expanded");
    const collapsed = compact && !expanded;
    state.sidebar?.toggleAttribute("amaya-collapsed", collapsed);
    if (state.collapse) {
      const label = compact ? "Expand sidebar" : "Collapse sidebar";
      state.collapse.setAttribute("aria-label", label);
      state.collapse.setAttribute(
        "title",
        `${label} (${shortcutLabel(win, "S", { shift: true })})`
      );
      state.collapse.setAttribute("aria-expanded", String(!compact));
    }
    syncFloatingUrlbar(win);
    if (state.lastEmitted !== `${compact}|${collapsed}`) {
      state.lastEmitted = `${compact}|${collapsed}`;
      try {
        ui.emit("shell-compact", { compact, collapsed });
      } catch (e) {}
    }
  }

  function syncFloatingUrlbar(win) {
    if (!state) {
      return;
    }
    const doc = win.document;
    const container = doc.getElementById("sidebar-container");
    const urlbar = doc.getElementById("urlbar");
    const root = doc.documentElement;
    const active = () =>
      !!urlbar &&
      (urlbar.hasAttribute("focused") ||
        urlbar.matches(":focus-within") ||
        !!urlbar.querySelector('[aria-expanded="true"]'));
    const floating =
      isCompact(win) &&
      !container?.hasAttribute("sidebar-launcher-expanded") &&
      (active() || (root.hasAttribute("amaya-urlbar-floating") && state.holdFloating));
    if (floating || !root.hasAttribute("amaya-urlbar-floating")) {
      root.toggleAttribute("amaya-urlbar-floating", floating);
      return;
    }
    // Focus moving between the input and a control in the field passes
    // through "nothing focused" for a moment: decide once it has settled.
    win.clearTimeout(state.floatTimer);
    state.floatTimer = win.setTimeout(() => {
      if (!state) {
        return;
      }
      const still =
        isCompact(win) &&
        !container?.hasAttribute("sidebar-launcher-expanded") &&
        (active() || state.holdFloating);
      root.toggleAttribute("amaya-urlbar-floating", still);
    }, 0);
  }

  async function applyCompact(win, compact, { initial = false } = {}) {
    const doc = win.document;
    const SC = win.SidebarController;
    const root = doc.documentElement;
    const was = isCompact(win);
    if (!initial && was == compact) {
      return;
    }
    root.toggleAttribute("amaya-compact", compact);

    // Native modes: "expand-on-hover" is compact (collapsed launcher that
    // slides out over the page on hover), "always-show" is expanded.
    const visibility = compact ? "expand-on-hover" : "always-show";
    if (ui.prefs.getStringPref("sidebar.visibility", "") != visibility) {
      ui.prefs.setStringPref("sidebar.visibility", visibility);
      await sleep(win, 0);
    }
    try {
      await SC.waitUntilStable?.();
      if (compact) {
        if (SC._state?.launcherExpanded) {
          SC._collapseLauncher?.();
        }
      } else if (!SC._state?.launcherExpanded) {
        if (SC._animationEnabled && !win.gReduceMotion && !initial) {
          SC._animateSidebarContainer();
        }
        SC._state.updateVisibility(true, true);
      }
    } catch (e) {
      log("compact", e);
    }
    syncCollapsedState(win);
  }

  function toggleCompact(win) {
    const compact = !isCompact(win);
    ui.prefs.setBoolPref(PREF_COMPACT, compact);
    applyCompact(win, compact);
  }

  function onKeyDown(win, e) {
    // Ctrl+Shift+S (Cmd+Shift+S on macOS) toggles compact mode.
    const accel = win.AppConstants.platform == "macosx" ? e.metaKey : e.ctrlKey;
    if (
      accel &&
      e.shiftKey &&
      !e.altKey &&
      (e.code == "KeyS" || e.key == "S" || e.key == "s")
    ) {
      e.preventDefault();
      e.stopPropagation();
      toggleCompact(win);
    }
  }

  function onResize(win) {
    if (!state?.ready) {
      return;
    }
    const narrow = win.innerWidth < NARROW_WINDOW;
    if (narrow == state.narrow) {
      return;
    }
    state.narrow = narrow;
    const saved = ui.prefs.getBoolPref(PREF_COMPACT, false);
    applyCompact(win, narrow || saved);
  }

  /* ---------------------------------------------------------------- */
  /* Module                                                            */
  /* ---------------------------------------------------------------- */

  function init(win) {
    if (state) {
      return;
    }
    state = { moved: [], cleanups: [], nodes: [], ready: false };
    const doc = win.document;
    ensurePrefs(ui.prefs);
    setAttr(doc.documentElement, "amaya-shell", "true");
    build(win).catch(e => {
      log("build failed", e);
      console.error(e);
    });
  }

  function uninit(win) {
    if (!state) {
      return;
    }
    const doc = win.document;
    const s = state;
    state = null;
    try {
      // Put moved native nodes back first (urlbar, menu, window controls,
      // vertical tabs), then remove what we created.
      state = s;
      restoreMovedNodes();
      state = null;
      for (const n of s.nodes) {
        n.remove();
      }
      for (const fn of s.cleanups.reverse()) {
        try {
          fn();
        } catch (e) {
          log("cleanup", e);
        }
      }
      doc.documentElement.removeAttribute("amaya-compact");
      doc.documentElement.removeAttribute("amaya-urlbar-floating");
      doc.documentElement.removeAttribute("amaya-shell");
      if (window.AmayaShell) {
        delete window.AmayaShell;
      }
    } catch (e) {
      log("uninit", e);
    }
  }

  // Small public surface for other modules and tests.
  window.AmayaShell = {
    get compact() {
      return isCompact(window);
    },
    setCompact(on) {
      ui.prefs.setBoolPref(PREF_COMPACT, !!on);
      return applyCompact(window, !!on);
    },
    toggleCompact() {
      toggleCompact(window);
    },
    // The loader calls uninit on window unload; exposed for tests.
    uninit() {
      uninit(window);
    },
  };

  ui.register(NAME, { init, uninit });
})();
