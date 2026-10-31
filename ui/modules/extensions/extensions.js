/* Amaya extensions module.
 *
 * Makes Firefox add-ons first-class in the Amaya sidebar without replacing
 * any of Firefox's own extension UI:
 *
 *  - Extensions button: Firefox's own #unified-extensions-button, moved into
 *    the sidebar top row (#amaya-sidebar-top) and drawn with the design-set
 *    puzzle icon. Being the native button, it opens the native extensions
 *    panel (gUnifiedExtensions.togglePanel) anchored to itself, and it is the
 *    anchor Firefox already uses for install/permission prompts and for the
 *    popups of extensions that live in the panel.
 *  - Pinned extensions ("Pin to toolbar" in the panel): Firefox puts them in
 *    the nav-bar, which the shell hides. Their real toolbar nodes are moved
 *    into a small row of icons in the top row (#amaya-ext-pins), at most
 *    MAX_PINS and only as many as fit; the rest are shown in the extensions
 *    panel the same way Firefox shows overflowed toolbar extensions, with
 *    their popups anchored to the Extensions button. Keyboard shortcuts and
 *    action.openPopup() therefore always find a visible anchor.
 *  - Compact mode (collapsed sidebar): the pinned icons are hidden; popups of
 *    pinned extensions anchor to the Extensions button, which keeps a
 *    (transparent) box over the collapse button for that purpose.
 *  - Command bar: "Extensions" (open the panel), "Find extensions" (AMO), and
 *    one "<name> sidebar" entry per extension that has a sidebar, since the
 *    shell hides the native sidebar launcher icons.
 *
 * Themes: Amaya's tokens stay authoritative (see shell.css); a Firefox theme
 * only chooses light or dark for the chrome. Documented in ui/README.md.
 */
(function () {
  "use strict";

  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const NAME = "extensions";
  const NAVBAR = "nav-bar";
  const BUTTON_ID = "unified-extensions-button";
  const PINS_ID = "amaya-ext-pins";
  const MAX_PINS = 3;
  const PIN_SLOT = 32; // 28px button + 4px gap
  const AMO_URL = "https://addons.mozilla.org/firefox/extensions/";

  let state = null;

  const log = (...args) => {
    try {
      ui.log(NAME, ...args);
    } catch (e) {
      console.log(`[amaya-ui:${NAME}]`, ...args);
    }
  };

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    state.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  /* ---------------------------------------------------------------- */
  /* Extensions button                                                 */
  /* ---------------------------------------------------------------- */

  function setupButton(win, top) {
    const doc = win.document;
    const button = doc.getElementById(BUTTON_ID);
    if (!button) {
      log("no #unified-extensions-button");
      return null;
    }
    const parent = button.parentNode;
    const next = button.nextSibling;
    state.cleanups.push(() => {
      if (parent) {
        parent.insertBefore(button, next && next.parentNode == parent ? next : null);
      }
    });

    // collapse, spacer, [pins], Extensions, back, forward, menu
    const before =
      doc.getElementById("amaya-back-button") ||
      doc.getElementById("PanelUI-button") ||
      null;
    top.insertBefore(button, before && before.parentNode == top ? before : null);
    button.classList.add("amaya-ext-button");
    state.cleanups.push(() => button.classList.remove("amaya-ext-button"));

    const stack = button.querySelector(".toolbarbutton-badge-stack");
    if (stack && !stack.querySelector(".amaya-ico")) {
      const svg = ui.icon("puzzle");
      svg.classList.add("amaya-ext-button__icon");
      stack.prepend(svg);
      state.cleanups.push(() => svg.remove());
    }
    return button;
  }

  /* ---------------------------------------------------------------- */
  /* Pinned extensions                                                 */
  /* ---------------------------------------------------------------- */

  function buildPins(win, top, button) {
    const doc = win.document;
    // A XUL <toolbar> so the moved widgets keep their native toolbar styling
    // (icon size, badge, hover) - it is not a CustomizableUI area.
    const pins = doc.createXULElement("toolbar");
    pins.id = PINS_ID;
    pins.className = "amaya-ext-pins";
    pins.setAttribute("mode", "icons");
    pins.setAttribute("aria-label", "Pinned extensions");
    top.insertBefore(pins, button && button.parentNode == top ? button : null);
    state.cleanups.push(() => pins.remove());
    return pins;
  }

  function widgetNode(win, id) {
    try {
      return win.CustomizableUI.getWidget(id)?.forWindow(win)?.node || null;
    } catch (e) {
      return null;
    }
  }

  function pinnedIds(win) {
    const CUI = win.CustomizableUI;
    try {
      return CUI.getWidgetIdsInArea(NAVBAR).filter(id => CUI.isWebExtensionWidget(id));
    } catch (e) {
      return [];
    }
  }

  function overflowList(win) {
    try {
      return win.gUnifiedExtensions.panel.querySelector("#overflowed-extensions-list");
    } catch (e) {
      return null;
    }
  }

  function setClass(win, id, inPanel) {
    try {
      win.gUnifiedExtensions._updateWidgetClassName(id, inPanel);
    } catch (e) {}
  }

  /** How many pinned icons fit next to the other top-row controls. */
  function capacity(win) {
    const top = state.top;
    if (!top || state.collapsed) {
      return state.capacity;
    }
    const width = top.getBoundingClientRect().width;
    if (!width) {
      return state.capacity;
    }
    const gap = parseFloat(win.getComputedStyle(top).columnGap) || 4;
    let used = 0;
    for (const child of top.children) {
      if (child == state.pins || child.classList.contains("amaya-shell-spacer")) {
        continue;
      }
      const w = child.getBoundingClientRect().width;
      if (w) {
        used += w + gap;
      }
    }
    // Keep at least one slot of breathing room for the drag area.
    const free = width - used - PIN_SLOT / 2;
    return Math.max(0, Math.min(MAX_PINS, Math.floor(free / PIN_SLOT)));
  }

  function placeInPins(win, id, node, index) {
    const pins = state.pins;
    if (pins.children[index] != node) {
      pins.insertBefore(node, pins.children[index] || null);
    }
    node.removeAttribute("overflowedItem");
    node.removeAttribute("artificallyOverflowed");
    // While the icons are hidden (collapsed sidebar), popups go to the
    // Extensions button instead.
    if (state.collapsed) {
      node.setAttribute("cui-anchorid", BUTTON_ID);
    } else {
      node.removeAttribute("cui-anchorid");
    }
    setClass(win, id, false);
  }

  function placeInPanel(win, id, node, list) {
    // Same attributes Firefox uses for extensions of a hidden toolbar
    // (gUnifiedExtensions.onToolbarVisibilityChange).
    node.setAttribute("overflowedItem", true);
    node.setAttribute("artificallyOverflowed", true);
    node.setAttribute("cui-anchorid", BUTTON_ID);
    if (node.parentNode != list) {
      list.appendChild(node);
    }
    setClass(win, id, true);
  }

  function sync(win) {
    if (!state?.pins || state.customizing) {
      return;
    }
    const ids = pinnedIds(win);
    const cap = capacity(win);
    state.capacity = cap;
    let list = null;
    let shown = 0;
    for (const id of ids) {
      const node = widgetNode(win, id);
      if (!node) {
        continue;
      }
      state.tracked.add(id);
      if (shown < cap) {
        placeInPins(win, id, node, shown);
        shown++;
      } else {
        list ||= overflowList(win);
        if (list) {
          placeInPanel(win, id, node, list);
        }
      }
    }
    // Unpinned (moved to the panel) or removed since the last sync.
    for (const id of [...state.tracked]) {
      if (!ids.includes(id)) {
        state.tracked.delete(id);
        const node = widgetNode(win, id);
        if (node && node.parentNode == state.pins) {
          node.remove();
        }
      }
    }
    state.pins.toggleAttribute("empty", !state.pins.childElementCount);
  }

  function scheduleSync(win) {
    if (!state || state.syncQueued) {
      return;
    }
    state.syncQueued = true;
    win.requestAnimationFrame(() => {
      if (!state) {
        return;
      }
      state.syncQueued = false;
      try {
        sync(win);
      } catch (e) {
        log("sync", e);
      }
    });
  }

  /** Put every pinned widget back where CustomizableUI expects it. */
  function restorePins(win) {
    for (const id of state.tracked) {
      const node = widgetNode(win, id);
      if (!node) {
        continue;
      }
      try {
        node.setAttribute("artificallyOverflowed", true);
        win.gUnifiedExtensions._maybeMoveWidgetNodeBack(id);
      } catch (e) {
        log("restore", id, e);
      }
    }
    state.tracked.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Command bar                                                       */
  /* ---------------------------------------------------------------- */

  function registerCommands(win) {
    const cmds = [
      {
        id: "extensions.panel",
        label: "Extensions",
        icon: "puzzle",
        group: "actions",
        keywords: ["addons", "add-ons", "plugins", "puzzle"],
        run: () => {
          // After the bar has closed, so the panel keeps focus.
          win.setTimeout(() => {
            if (!win.gUnifiedExtensions.isPanelOpen()) {
              win.gUnifiedExtensions.togglePanel(null, "amaya_cmdbar");
            }
          }, 0);
        },
      },
      {
        id: "extensions.find",
        label: "Find extensions",
        icon: "search",
        group: "actions",
        hint: "addons.mozilla.org",
        keywords: ["addons", "add-ons", "amo", "install", "themes", "store"],
        run: ({ newTab } = {}) => {
          win.openTrustedLinkIn(AMO_URL, newTab === false ? "current" : "tab", {
            triggeringPrincipal: win.Services.scriptSecurityManager.getSystemPrincipal(),
          });
        },
      },
    ];
    for (const c of cmds) {
      ui.emit("register-command", c);
    }
    state.cleanups.push(() => {
      for (const c of cmds) {
        ui.emit("unregister-command", { id: c.id });
      }
    });

    // One entry per extension sidebar (sidebar_action), built when the bar
    // opens so it follows installs and removals.
    const onOpen = e => {
      const SC = win.SidebarController;
      let exts = [];
      try {
        exts = SC?.getExtensions?.() || [];
      } catch (err) {
        exts = [];
      }
      for (const ext of exts) {
        const label = ext.tooltiptext || ext.name || "Extension";
        e.detail.add({
          id: "extensions.sidebar." + ext.commandID,
          label: `${label} sidebar`,
          icon: "sidebar",
          group: "actions",
          hint: () => (SC.isOpen && SC.currentID == ext.commandID ? "Open" : "Extension"),
          keywords: ["sidebar", "extension", label.toLowerCase()],
          run: () => SC.toggle(ext.commandID),
        });
      }
    };
    listen(win, "amaya:register-commands", onOpen);
  }

  /* ---------------------------------------------------------------- */
  /* Module                                                            */
  /* ---------------------------------------------------------------- */

  function setup(win, top) {
    if (!state || state.top) {
      return;
    }
    const doc = win.document;
    state.top = top;
    const button = setupButton(win, top);
    state.pins = buildPins(win, top, button);
    state.collapsed = !!doc.getElementById("amaya-sidebar")?.hasAttribute("amaya-collapsed");

    const CUI = win.CustomizableUI;
    const listener = {
      onWidgetAdded: () => scheduleSync(win),
      onWidgetRemoved: () => scheduleSync(win),
      onWidgetMoved: () => scheduleSync(win),
      onWidgetAfterDOMChange: () => scheduleSync(win),
      onWidgetAfterCreation: () => scheduleSync(win),
      onWidgetDestroyed: () => scheduleSync(win),
      onAreaReset: () => scheduleSync(win),
    };
    CUI.addListener(listener);
    state.cleanups.push(() => CUI.removeListener(listener));

    // Customize mode works on the real toolbars: hand the widgets back.
    const toolbox = doc.getElementById("navigator-toolbox");
    if (toolbox) {
      listen(toolbox, "customizationstarting", () => {
        state.customizing = true;
        restorePins(win);
      });
      listen(toolbox, "aftercustomization", () => {
        state.customizing = false;
        scheduleSync(win);
      });
    }

    const ro = new win.ResizeObserver(() => scheduleSync(win));
    ro.observe(top);
    state.cleanups.push(() => ro.disconnect());

    try {
      const off = ui.on("shell-compact", e => {
        const detail = e?.detail ?? e;
        state.collapsed = !!detail?.collapsed;
        scheduleSync(win);
      });
      if (typeof off == "function") {
        state.cleanups.push(off);
      }
    } catch (e) {
      log("shell-compact", e);
    }

    registerCommands(win);
    sync(win);
    log("ready");
  }

  function init(win) {
    if (state) {
      return;
    }
    state = { cleanups: [], tracked: new Set(), capacity: MAX_PINS, collapsed: false };
    ui.whenAnchor("amaya-sidebar-top", top => setup(win, top));
  }

  function uninit(win) {
    if (!state) {
      return;
    }
    try {
      restorePins(win);
    } catch (e) {
      log("uninit", e);
    }
    for (const fn of state.cleanups.reverse()) {
      try {
        fn();
      } catch (e) {
        log("cleanup", e);
      }
    }
    state = null;
  }

  ui.register(NAME, { init, uninit });
})();
