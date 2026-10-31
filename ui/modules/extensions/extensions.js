/* Amaya extensions module.
 *
 * Makes Firefox add-ons first-class in the Amaya sidebar without replacing
 * any of Firefox's own extension UI. Everything lives in one row right under
 * the address field (#amaya-ext-row):
 *
 *  - One icon per extension with a toolbar button (browser action), pinned or
 *    not, in the order of the extensions panel (pinned first, then the rest).
 *    Each icon mirrors the real widget (icon, badge, title, enabled state);
 *    a click runs the action the way a toolbar click does: Firefox's own
 *    popup (the widget's panelview, PanelUI.showSubView) anchored to the
 *    icon, or the extension's onClicked. Middle click and the right-click
 *    menu (Manage / Remove / Pin / Report, the extension's own menu items)
 *    are Firefox's too. The real widget nodes stay in the panel, so the panel
 *    keeps listing every extension.
 *  - Extensions button: Firefox's own #unified-extensions-button (puzzle),
 *    last in the row. It opens the native extensions panel and is the anchor
 *    Firefox uses for install/permission prompts, for extensions without an
 *    icon here, and for popups opened by keyboard shortcut or
 *    action.openPopup().
 *  - Pinned extensions ("Pin to toolbar"): Firefox puts them in the nav-bar,
 *    which the shell hides. Their real nodes are shown in the panel the way
 *    Firefox shows extensions of a hidden toolbar, anchored to the button.
 *  - Compact mode (52px rail): only the Extensions button shows.
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
  const ADDONS_AREA = "unified-extensions-area";
  const BUTTON_ID = "unified-extensions-button";
  const ROW_ID = "amaya-ext-row";
  const CONTEXT_MENU = "unified-extensions-context-menu";
  const AMO_URL = "https://addons.mozilla.org/firefox/extensions/";
  // Attributes of the real action button that the mirrored icon follows.
  const MIRRORED = ["style", "badge", "badgeStyle", "disabled", "data-l10n-args"];

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
  /* Row and Extensions button                                         */
  /* ---------------------------------------------------------------- */

  function buildRow(win, slot) {
    const row = ui.h("div", {
      id: ROW_ID,
      class: "amaya-ext-row",
      role: "toolbar",
      "aria-label": "Extensions",
    });
    slot.after(row);
    state.cleanups.push(() => row.remove());
    return row;
  }

  function setupButton(win, row) {
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

    row.append(button);
    button.classList.add("amaya-ext-button");
    state.cleanups.push(() => button.classList.remove("amaya-ext-button"));

    // Firefox opens the panel from listeners delegated to #navigator-toolbox
    // (navigator-toolbox.js: "mousedown" and "keypress" on the toolbox,
    // matched by id). Outside the toolbox those never see the button, so a
    // real click did nothing. Same handler, on the button itself.
    const open = e => {
      if (!button.closest("#navigator-toolbox")) {
        win.gUnifiedExtensions.togglePanel(e);
      }
    };
    listen(button, "mousedown", open);
    listen(button, "keypress", open);

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
  /* Widgets                                                           */
  /* ---------------------------------------------------------------- */

  function widgetNode(win, id) {
    try {
      return win.CustomizableUI.getWidget(id)?.forWindow(win)?.node || null;
    } catch (e) {
      return null;
    }
  }

  function webextIds(win, area) {
    const CUI = win.CustomizableUI;
    try {
      return CUI.getWidgetIdsInArea(area).filter(id => CUI.isWebExtensionWidget(id));
    } catch (e) {
      return [];
    }
  }

  /** widget id -> browserAction, for the extensions usable in this window. */
  function browserActions(win) {
    const map = new Map();
    const gUE = win.gUnifiedExtensions;
    let policies = [];
    try {
      policies = gUE.getActivePolicies();
    } catch (e) {
      log("policies", e);
    }
    for (const policy of policies) {
      try {
        const ba = gUE.browserActionFor(policy);
        if (ba?.widget) {
          map.set(ba.widget.id, ba);
        }
      } catch (e) {}
    }
    return map;
  }

  function actionButton(node) {
    return node?.querySelector(".unified-extensions-item-action-button") || null;
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

  /** A pinned widget's node, out of the hidden nav-bar into the panel. */
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
  /* Extension icons                                                   */
  /* ---------------------------------------------------------------- */

  function clickModifiers(win, e) {
    const mods = [];
    if (e.shiftKey) {
      mods.push("Shift");
    }
    if (e.altKey) {
      mods.push("Alt");
    }
    if (e.metaKey) {
      mods.push("Command");
    }
    if (e.ctrlKey) {
      mods.push("Ctrl");
      if (win.AppConstants?.platform == "macosx") {
        mods.push("MacCtrl");
      }
    }
    return mods;
  }

  /** What a toolbar click on the widget does (CustomizableUI's
   * handleWidgetCommand + showWidgetView for a "view" action), with the
   * popup anchored to our icon instead of the hidden widget. */
  function runAction(win, id, icon, e) {
    const ba = state.actions.get(id);
    if (!ba || icon.getAttribute("aria-disabled") == "true" || icon.open) {
      return;
    }
    ba.lastClickInfo = { button: 0, modifiers: clickModifiers(win, e) };
    ba.openPopupWithoutUserInteraction = false;
    win.PanelUI.showSubView(ba.viewId, icon, e);
  }

  /** Firefox's extension context menu, for the real widget. The menu reads
   * the extension from its triggerNode, which comes from the trigger event's
   * target: dispatch it on the real action button first. */
  function openContextMenu(win, id, icon, e) {
    const doc = win.document;
    const real = actionButton(widgetNode(win, id));
    const menu = doc.getElementById(CONTEXT_MENU);
    if (!real || !menu) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const trigger = new win.MouseEvent("amaya-ext-contextmenu", {
      screenX: e.screenX,
      screenY: e.screenY,
      button: 2,
    });
    real.dispatchEvent(trigger);
    state.ctxPending = true;
    const byKeyboard = !e.screenX && !e.screenY;
    if (byKeyboard) {
      menu.openPopup(icon, "after_start", 0, 0, true, false, trigger);
    } else {
      menu.openPopupAtScreen(e.screenX, e.screenY, true, trigger);
    }
  }

  function makeIcon(win, id) {
    const icon = ui.h(
      "button",
      {
        type: "button",
        class: "amaya-ext-icon",
        "data-widget-id": id,
      },
      ui.h("span", { class: "amaya-ext-icon__img", "aria-hidden": "true" }),
      ui.h("span", { class: "amaya-ext-icon__badge", "aria-hidden": "true" })
    );
    // PanelUI.showSubView marks its anchor with .open while the popup shows.
    Object.defineProperty(icon, "open", {
      configurable: true,
      get() {
        return this.hasAttribute("open");
      },
      set(v) {
        this.toggleAttribute("open", !!v);
      },
    });
    icon.addEventListener("click", e => {
      if (e.button == 0) {
        runAction(win, id, icon, e);
      }
    });
    icon.addEventListener("auxclick", e => {
      const ba = state?.actions.get(id);
      if (e.button == 1 && ba && icon.getAttribute("aria-disabled") != "true") {
        ba.handleEvent(e);
      }
    });
    icon.addEventListener("contextmenu", e => openContextMenu(win, id, icon, e));
    return icon;
  }

  function updateIcon(win, icon, ba, real) {
    let name = "";
    try {
      name =
        ba.action.getProperty(win.gBrowser.selectedTab, "title") ||
        ba.extension.name ||
        "";
    } catch (e) {
      name = ba.extension?.name || "";
    }
    icon.setAttribute("aria-label", name);
    icon.setAttribute("title", name);
    const style = real.getAttribute("style") || "";
    if (icon.getAttribute("style") != style) {
      icon.setAttribute("style", style);
    }
    const badge = real.getAttribute("badge") || "";
    const badgeEl = icon.querySelector(".amaya-ext-icon__badge");
    badgeEl.textContent = badge;
    badgeEl.setAttribute("style", real.getAttribute("badgeStyle") || "");
    icon.toggleAttribute("badged", !!badge);
    icon.setAttribute("aria-disabled", String(real.hasAttribute("disabled")));
  }

  function sync(win) {
    if (!state?.row || state.customizing) {
      return;
    }
    const pinned = webextIds(win, NAVBAR);
    const inPanel = webextIds(win, ADDONS_AREA);

    // Pinned widgets: never left in the hidden nav-bar.
    let list = null;
    for (const id of pinned) {
      const node = widgetNode(win, id);
      if (!node) {
        continue;
      }
      list ||= overflowList(win);
      if (list) {
        state.tracked.add(id);
        placeInPanel(win, id, node, list);
      }
    }
    for (const id of [...state.tracked]) {
      if (!pinned.includes(id)) {
        // Unpinned: CustomizableUI moved it into the panel area.
        state.tracked.delete(id);
        const node = widgetNode(win, id);
        if (node?.parentNode?.id == ADDONS_AREA) {
          node.removeAttribute("overflowedItem");
          node.removeAttribute("artificallyOverflowed");
        }
      }
    }

    // One icon per widget, in the panel's order.
    state.actions = browserActions(win);
    const keep = new Set();
    let before = state.button && state.button.parentNode == state.row ? state.button : null;
    const order = [...pinned, ...inPanel].filter(id => state.actions.has(id));
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const real = actionButton(widgetNode(win, id));
      if (!real) {
        continue;
      }
      let icon = state.icons.get(id);
      if (!icon) {
        icon = makeIcon(win, id);
        state.icons.set(id, icon);
      }
      updateIcon(win, icon, state.actions.get(id), real);
      state.mo.observe(real, { attributes: true, attributeFilter: MIRRORED });
      if (icon.nextSibling != before || icon.parentNode != state.row) {
        state.row.insertBefore(icon, before);
      }
      before = icon;
      keep.add(id);
    }
    for (const [id, icon] of state.icons) {
      if (!keep.has(id)) {
        icon.remove();
        state.icons.delete(id);
      }
    }
    state.row.toggleAttribute("empty", !keep.size);
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

  /** Commands of Firefox's extension context menu end with
   * gUnifiedExtensions.onContextMenuCommand(), which toggles the panel (it
   * assumes the menu came from the panel). Opened from our row, that would
   * open the panel after "Manage extension": skip it then. */
  function guardContextMenu(win) {
    const gUE = win.gUnifiedExtensions;
    const menu = win.document.getElementById(CONTEXT_MENU);
    if (!gUE || !menu) {
      return;
    }
    const original = gUE.onContextMenuCommand;
    const own = Object.prototype.hasOwnProperty.call(gUE, "onContextMenuCommand");
    gUE.onContextMenuCommand = function (...args) {
      if (state?.ctxFromRow) {
        return undefined;
      }
      return original.apply(this, args);
    };
    state.cleanups.push(() => {
      if (own) {
        gUE.onContextMenuCommand = original;
      } else {
        delete gUE.onContextMenuCommand;
      }
    });
    listen(menu, "popupshowing", e => {
      if (e.target == menu) {
        state.ctxFromRow = !!state.ctxPending;
        state.ctxPending = false;
      }
    });
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
    // The shared registry reaches the command bar even though this module
    // loads before it; the event covers a bar that is already running.
    const registry = (ui.commands ||= []);
    for (const c of cmds) {
      registry.push(c);
      ui.emit("register-command", c);
    }
    state.cleanups.push(() => {
      for (const c of cmds) {
        const i = registry.indexOf(c);
        if (i >= 0) {
          registry.splice(i, 1);
        }
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

  function setup(win, slot) {
    if (!state || state.row) {
      return;
    }
    const doc = win.document;
    state.row = buildRow(win, slot);
    state.button = setupButton(win, state.row);
    state.mo = new win.MutationObserver(() => scheduleSync(win));
    state.cleanups.push(() => state.mo.disconnect());

    // Builds the panel (and with it the panel area's widget nodes, which the
    // icons mirror) and localizes the extension context menu.
    try {
      win.gUnifiedExtensions.panel;
    } catch (e) {
      log("panel", e);
    }
    guardContextMenu(win);

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

    // Titles can be per tab.
    listen(win, "TabSelect", () => scheduleSync(win));

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

    registerCommands(win);
    sync(win);
    log("ready");
  }

  function init(win) {
    if (state) {
      return;
    }
    state = {
      cleanups: [],
      tracked: new Set(),
      icons: new Map(),
      actions: new Map(),
    };
    ui.whenAnchor("amaya-urlbar-slot", slot => setup(win, slot));
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
