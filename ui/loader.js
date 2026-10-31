/* Amaya workflow UI loader.  See ui/README.md for the contract.
 *
 * This file runs in two places:
 *
 *  1. Boot mode — loaded once by amaya.cfg (privileged autoconfig sandbox)
 *     with `AMAYA_UI_DIR_URL` (file:// URL of the UI dir, trailing slash) in
 *     scope.  It watches for browser windows and loads this same file into
 *     each one.
 *  2. Window mode — loaded into a browser window (`window` exists).  It
 *     creates `window.AmayaUI`, adds tokens.css and loads every module listed
 *     in modules.json (CSS sheet, then JS) in order.
 *
 * Everything is wrapped in an IIFE so nothing leaks into the window's global
 * lexical scope (browser.js lives there too).
 */
(function () {
  "use strict";

  const BROWSER_URL = "chrome://browser/content/browser.xhtml";
  const TAG = "[amaya-ui]";

  /* ------------------------------------------------------------------ *
   * Boot mode
   * ------------------------------------------------------------------ */
  if (typeof window === "undefined") {
    const dirURL = AMAYA_UI_DIR_URL; // provided by amaya.cfg
    const loaderURL = dirURL + "loader.js";

    const attach = subject => {
      try {
        // The autoconfig sandbox sees windows through Xray wrappers; waive
        // them so the expando below (and window.AmayaUI) are the real ones.
        const win = Cu.waiveXrays(subject);
        if (win.location.href !== BROWSER_URL || win.AmayaUI) {
          return;
        }
        win.__amayaUIBoot = { dirURL };
        Services.scriptloader.loadSubScriptWithOptions(loaderURL, {
          target: win,
          ignoreCache: true,
          allowUnsafeURL: true,
        });
      } catch (e) {
        Cu.reportError(`${TAG} cannot attach to window: ${e}\n${e.stack || ""}`);
      }
    };

    const observer = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished") {
          attach(subject);
        }
      },
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");

    // Windows that finished startup before we got here (not normally the case
    // when loaded from amaya.cfg, but keeps re-loading the loader harmless).
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.gBrowserInit && win.gBrowserInit.delayedStartupFinished) {
        attach(win);
      }
    }
    return;
  }

  /* ------------------------------------------------------------------ *
   * Window mode
   * ------------------------------------------------------------------ */
  const win = window;
  const doc = win.document;
  const boot = win.__amayaUIBoot || {};
  delete win.__amayaUIBoot;
  if (win.AmayaUI) {
    return;
  }

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const dirURL = boot.dirURL;
  const dirPath = Services.io.newURI(dirURL).QueryInterface(Ci.nsIFileURL).file.path;

  const cleanups = []; // run on unload, last first
  const modules = new Map(); // name -> {init, uninit, inited}
  const sheets = [];

  function log(name, ...args) {
    console.log(`[amaya-ui:${name}]`, ...args);
  }
  function logError(name, e) {
    const msg = e && e.stack ? `${e}\n${e.stack}` : String(e);
    console.error(`[amaya-ui:${name}] ${msg}`);
  }

  function addSheet(url) {
    win.windowUtils.loadSheetUsingURIString(url, win.windowUtils.AUTHOR_SHEET);
    sheets.push(url);
  }

  /* ---- h(): tiny HTML element helper -------------------------------- */
  function append(el, child) {
    if (child == null || child === false) {
      return;
    }
    if (Array.isArray(child)) {
      child.forEach(c => append(el, c));
    } else if (typeof child === "string" || typeof child === "number") {
      el.append(doc.createTextNode(String(child)));
    } else {
      el.append(child);
    }
  }

  function h(tag, props, ...children) {
    const el = doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) {
        continue;
      }
      if (k === "class" || k === "className") {
        el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
      } else if (k === "style" && typeof v === "object") {
        for (const [p, pv] of Object.entries(v)) {
          if (p.startsWith("--") || p.includes("-")) {
            el.style.setProperty(p, pv);
          } else {
            el.style[p] = pv;
          }
        }
      } else if (k === "dataset") {
        Object.assign(el.dataset, v);
      } else if (k.startsWith("on") && typeof v === "function") {
        el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "text") {
        el.textContent = v;
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
    append(el, children);
    return el;
  }

  /* ---- icon(): the design-system icon set --------------------------- *
   * 16px stroke icons on a 24px grid, 1.5px stroke, round caps/joins,
   * currentColor.  Paths copied from ui/design/components/*.preview.html and
   * ui/design/mockups/*.dc.html; folder and forward drawn in the same style. */
  const ICONS = {
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    split: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12 5v14"/>',
    folder: '<path d="M4 7.5A1.5 1.5 0 015.5 6H10l2 2h6.5A1.5 1.5 0 0120 9.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5z"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    "chevron-right": '<path d="M9 6l6 6-6 6"/>',
    sidebar: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M9 5v14"/>',
    "open-in-tab": '<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 01-1 1H6a1 1 0 01-1-1V7a1 1 0 011-1h4"/>',
    sound: '<path d="M5 10v4h3l4 4V6L8 10z"/><path d="M16 9a4 4 0 010 6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    back: '<path d="M15 6l-6 6 6 6"/>',
    forward: '<path d="M9 6l6 6-6 6"/>',
    warning: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
  };

  function icon(name, size = 16) {
    const body = ICONS[name];
    if (!body) {
      log("loader", `unknown icon "${name}"`);
    }
    const src =
      `<svg xmlns="${SVG_NS}" viewBox="0 0 24 24" width="${size}" height="${size}" ` +
      'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      `stroke-linejoin="round" aria-hidden="true" class="amaya-ico">${body || ""}</svg>`;
    const parsed = new win.DOMParser().parseFromString(src, "image/svg+xml");
    return doc.importNode(parsed.documentElement, true);
  }

  /* ---- anchors ------------------------------------------------------ */
  function anchor(id) {
    return doc.getElementById(id);
  }

  function whenAnchor(id, cb) {
    const run = el => {
      try {
        cb(el);
      } catch (e) {
        logError(`whenAnchor:${id}`, e);
      }
    };
    const el = anchor(id);
    if (el) {
      run(el);
      return () => {};
    }
    const mo = new win.MutationObserver(() => {
      const found = anchor(id);
      if (found) {
        mo.disconnect();
        run(found);
      }
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
    const cancel = () => mo.disconnect();
    cleanups.push(cancel);
    return cancel;
  }

  /* ---- overlay root ------------------------------------------------- *
   * A full-window layer above web content and the browser chrome (but below
   * XUL popups/panels, which are separate widgets).  pointer-events: none so
   * it never eats clicks; children opt in with pointer-events: auto. */
  const overlayRoot = h("div", {
    id: "amaya-overlay-root",
    style: {
      position: "fixed",
      inset: "0",
      "z-index": "2147483000",
      "pointer-events": "none",
      overflow: "hidden",
    },
  });
  doc.body.append(overlayRoot);
  cleanups.push(() => overlayRoot.remove());

  /* ---- store -------------------------------------------------------- */
  function store(name) {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`invalid store name "${name}"`);
    }
    const dir = PathUtils.join(PathUtils.profileDir, "amaya");
    const path = PathUtils.join(dir, `${name}.json`);
    return {
      path,
      async read() {
        try {
          return await IOUtils.readJSON(path);
        } catch (e) {
          if (DOMException.isInstance(e) && e.name === "NotFoundError") {
            return null;
          }
          throw e;
        }
      },
      async write(obj) {
        await IOUtils.makeDirectory(dir, { ignoreExisting: true });
        await IOUtils.writeJSON(path, obj, { tmpPath: `${path}.tmp` });
      },
    };
  }

  /* ---- events ------------------------------------------------------- */
  function emit(type, detail) {
    win.dispatchEvent(new win.CustomEvent(`amaya:${type}`, { detail }));
  }
  function on(type, fn) {
    const name = `amaya:${type}`;
    win.addEventListener(name, fn);
    const off = () => win.removeEventListener(name, fn);
    cleanups.push(off);
    return off;
  }

  /* ---- modules ------------------------------------------------------ */
  let currentModule = null;

  function register(name, impl) {
    if (modules.has(name)) {
      logError(name, new Error("module registered twice"));
      return;
    }
    const entry = { name, impl: impl || {}, inited: false };
    modules.set(name, entry);
    if (currentModule && currentModule !== name) {
      log(currentModule, `registered under a different name: "${name}"`);
    }
    if (typeof entry.impl.init === "function") {
      try {
        entry.impl.init(win);
        entry.inited = true;
      } catch (e) {
        logError(name, e);
      }
    } else {
      entry.inited = true;
    }
  }

  async function loadModules() {
    let names = [];
    try {
      names = await IOUtils.readJSON(PathUtils.join(dirPath, "modules.json"));
    } catch (e) {
      logError("loader", e);
      return;
    }
    for (const name of names) {
      if (typeof name !== "string" || !/^[a-z0-9_-]+$/.test(name)) {
        logError("loader", new Error(`bad module name ${JSON.stringify(name)}`));
        continue;
      }
      const mdir = PathUtils.join(dirPath, "modules", name);
      try {
        if (!(await IOUtils.exists(mdir))) {
          continue; // not built yet: skip silently
        }
        if (await IOUtils.exists(PathUtils.join(mdir, `${name}.css`))) {
          addSheet(`${dirURL}modules/${name}/${name}.css`);
        }
        if (await IOUtils.exists(PathUtils.join(mdir, `${name}.js`))) {
          currentModule = name;
          Services.scriptloader.loadSubScriptWithOptions(
            `${dirURL}modules/${name}/${name}.js`,
            { target: win, ignoreCache: true, allowUnsafeURL: true }
          );
        }
      } catch (e) {
        logError(name, e);
      } finally {
        currentModule = null;
      }
    }
    log("loader", `ready: ${[...modules.keys()].join(", ") || "(no modules)"}`);
    emit("ready", { modules: [...modules.keys()] });
  }

  function uninit() {
    for (const entry of [...modules.values()].reverse()) {
      if (entry.inited && typeof entry.impl.uninit === "function") {
        try {
          entry.impl.uninit(win);
        } catch (e) {
          logError(entry.name, e);
        }
      }
    }
    modules.clear();
    while (cleanups.length) {
      try {
        cleanups.pop()();
      } catch (e) {
        logError("loader", e);
      }
    }
    for (const url of sheets.splice(0)) {
      try {
        win.windowUtils.removeSheetUsingURIString(url, win.windowUtils.AUTHOR_SHEET);
      } catch (e) {}
    }
  }

  win.AmayaUI = {
    dirURL,
    register,
    anchor,
    whenAnchor,
    overlayRoot,
    h,
    icon,
    icons: Object.keys(ICONS),
    prefs: Services.prefs,
    store,
    emit,
    on,
    log,
    // Resolves once every module in modules.json has been loaded.
    ready: null,
    get modules() {
      return [...modules.keys()];
    },
  };

  win.addEventListener("unload", uninit, { once: true });

  try {
    addSheet(`${dirURL}tokens.css`);
  } catch (e) {
    logError("tokens", e);
  }
  win.AmayaUI.ready = loadModules().catch(e => logError("loader", e));
})();
