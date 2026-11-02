/* Amaya glass module.
 *
 * Optional translucent look (off by default): a window gradient tinted with
 * the active space's colour, translucent sidebar surfaces and frosted
 * floating UI. All styling is in glass.css under :root[amaya-glass]; this
 * file only keeps that attribute and the tint in sync.
 *
 *  - Pref: amaya.ui.glass (bool). Watched, so about:config changes apply to
 *    every open window at once.
 *  - Tint: --amaya-glass-tint on the root, from the active space's colour
 *    (AmayaUI.spaces at start, then amaya:space-changed).
 *  - Command bar: "Glass mode" toggles the pref.
 */
(function () {
  "use strict";

  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const NAME = "glass";
  const PREF = "amaya.ui.glass";
  const ATTR = "amaya-glass";

  let state = null;

  const log = (...args) => {
    try {
      ui.log(NAME, ...args);
    } catch (e) {
      console.log(`[amaya-ui:${NAME}]`, ...args);
    }
  };

  function enabled() {
    return ui.prefs.getBoolPref(PREF, false);
  }

  function apply(win) {
    win.document.documentElement.toggleAttribute(ATTR, enabled());
  }

  function setTint(win, color) {
    const root = win.document.documentElement;
    if (color) {
      root.style.setProperty("--amaya-glass-tint", `var(--amaya-space-${color})`);
    } else {
      root.style.removeProperty("--amaya-glass-tint");
    }
  }

  function activeColor() {
    try {
      const spaces = ui.spaces;
      const active = spaces?.list().find(s => s.id == spaces.activeId);
      return active?.color || null;
    } catch (e) {
      log("spaces", e);
      return null;
    }
  }

  function registerCommands(win) {
    const cmds = [
      {
        id: "glass.toggle",
        label: "Glass mode",
        icon: "sidebar",
        group: "actions",
        hint: () => (enabled() ? "On" : "Off"),
        keywords: ["glass", "translucent", "transparent", "blur", "theme", "appearance"],
        run: () => ui.prefs.setBoolPref(PREF, !enabled()),
      },
    ];
    // Same registry pattern as the extensions module: the shared list reaches
    // a command bar that loads later, the event one that is already running.
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
  }

  function init(win) {
    if (state) {
      return;
    }
    state = { cleanups: [] };

    apply(win);
    const observer = () => apply(win);
    ui.prefs.addObserver(PREF, observer);
    state.cleanups.push(() => ui.prefs.removeObserver(PREF, observer));

    setTint(win, activeColor());
    const off = ui.on("space-changed", e => setTint(win, e.detail?.color));
    state.cleanups.push(() => off?.());

    registerCommands(win);
    log("ready", enabled() ? "on" : "off");
  }

  function uninit(win) {
    if (!state) {
      return;
    }
    for (const fn of state.cleanups.reverse()) {
      try {
        fn();
      } catch (e) {
        log("cleanup", e);
      }
    }
    win.document.documentElement.removeAttribute(ATTR);
    setTint(win, null);
    state = null;
  }

  ui.register(NAME, { init, uninit });
})();
