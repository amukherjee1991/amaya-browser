/* Amaya Glance: Alt+click (or long-press) a link to preview it over the page.
 *
 * Runs in the browser window scope (see ui/README.md, module contract).
 *
 * How it works
 * ------------
 * - A small frame script (inlined below as a data: URL, so it needs no file
 *   access from the sandboxed content process) listens for Alt+click and
 *   long-press on links in every browser of this window. It swallows the
 *   click (preventDefault + stopPropagation in the capture phase, above the
 *   page), so the page never sees it and Firefox never turns it into a
 *   navigation, a new tab or "save link" (browser.altClickSave).
 * - The parent opens a real remote <browser> inside AmayaUI.overlayRoot, with
 *   the source tab's userContextId (same space/container). Private browsing,
 *   tracking protection, RFP/FPI and the referrer policy all apply as they do
 *   for the page beneath: they are per-window, per-container or global.
 * - "Open as tab" and "Split" move the live page into a real tab by swapping
 *   docshells (no reload). If that fails, the URL is opened in a new tab of
 *   the same container instead.
 */
(function () {
  "use strict";

  const NAME = "glance";
  const MSG_OPEN = "Amaya:Glance:Open";
  const MSG_SHUTDOWN = "Amaya:Glance:Shutdown";
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const XUL_NS =
    "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
  const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
  const OPEN_MS = 180;
  const CLOSE_MS = 120;

  // ---------------------------------------------------------------------
  // Content side. Serialised with Function#toString, so it must not use
  // anything from the enclosing scope. Runs once per <browser> (top-level
  // frame) in the content process, with the frame script globals
  // (addEventListener, sendAsyncMessage, addMessageListener, content...).
  // ---------------------------------------------------------------------
  function glanceFrameScript() {
    const { BrowserUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/BrowserUtils.sys.mjs"
    );
    const { E10SUtils } = ChromeUtils.importESModule(
      "resource://gre/modules/E10SUtils.sys.mjs"
    );
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
      "resource://gre/modules/Timer.sys.mjs"
    );
    const LONG_PRESS_MS = 500;
    const SLOP_PX = 6;
    let press = null; // pending long-press
    let swallowClick = false; // the click that ends a long-press

    function linkFor(event) {
      let found;
      try {
        found = BrowserUtils.hrefAndLinkNodeForClickEvent(event);
      } catch (e) {
        return null;
      }
      if (!found) {
        return null;
      }
      let [href, node, principal] = found;
      if (!href || !node) {
        return null;
      }
      // Never Glance downloads.
      if (node.hasAttribute("download")) {
        return null;
      }
      // Web pages only: no javascript:, data:, blob:, mailto:, file:...
      let scheme;
      try {
        scheme = Services.io.extractScheme(href);
      } catch (e) {
        return null;
      }
      if (scheme != "http" && scheme != "https") {
        return null;
      }
      try {
        Services.scriptSecurityManager.checkLoadURIStrWithPrincipal(
          principal,
          href
        );
      } catch (e) {
        return null;
      }
      return { href, node, principal };
    }

    function send(link, event, how) {
      let doc = link.node.ownerDocument;
      let referrerInfo = Cc["@mozilla.org/referrer-info;1"].createInstance(
        Ci.nsIReferrerInfo
      );
      referrerInfo.initWithElement(link.node);
      let data = {
        href: link.href,
        how,
        screenX: event.screenX,
        screenY: event.screenY,
        referrerInfo: E10SUtils.serializeReferrerInfo(referrerInfo),
        policyContainer: doc.policyContainer
          ? E10SUtils.serializePolicyContainer(doc.policyContainer)
          : null,
        triggeringPrincipal: E10SUtils.serializePrincipal(link.principal),
      };
      sendAsyncMessage("Amaya:Glance:Open", data);
    }

    function swallow(event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function cancelPress() {
      if (press) {
        clearTimeout(press.timer);
        press = null;
      }
    }

    function onClick(event) {
      if (!event.isTrusted) {
        return;
      }
      if (swallowClick) {
        swallowClick = false;
        if (event.button == 0) {
          swallow(event);
        }
        return;
      }
      if (
        event.button != 0 ||
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      let link = linkFor(event);
      if (!link) {
        return;
      }
      swallow(event);
      send(link, event, "alt-click");
    }

    function onMouseDown(event) {
      swallowClick = false;
      cancelPress();
      if (
        !event.isTrusted ||
        event.button != 0 ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      let enabled = true;
      try {
        enabled = Services.prefs.getBoolPref("amaya.glance.longpress", true);
      } catch (e) {}
      if (!enabled) {
        return;
      }
      let link = linkFor(event);
      if (!link) {
        return;
      }
      let snapshot = {
        screenX: event.screenX,
        screenY: event.screenY,
      };
      press = {
        x: event.screenX,
        y: event.screenY,
        timer: setTimeout(() => {
          press = null;
          swallowClick = true;
          send(link, snapshot, "long-press");
        }, LONG_PRESS_MS),
      };
    }

    function onMouseMove(event) {
      if (
        press &&
        (Math.abs(event.screenX - press.x) > SLOP_PX ||
          Math.abs(event.screenY - press.y) > SLOP_PX)
      ) {
        cancelPress();
      }
    }

    const listeners = [
      ["click", onClick],
      ["auxclick", onClick],
      ["mousedown", onMouseDown],
      ["mousemove", onMouseMove],
      ["mouseup", cancelPress],
      ["dragstart", cancelPress],
      ["scroll", cancelPress],
      ["pagehide", cancelPress],
    ];
    for (let [type, fn] of listeners) {
      addEventListener(type, fn, { capture: true });
    }
    function shutdown() {
      cancelPress();
      for (let [type, fn] of listeners) {
        removeEventListener(type, fn, { capture: true });
      }
      removeMessageListener("Amaya:Glance:Shutdown", shutdown);
    }
    addMessageListener("Amaya:Glance:Shutdown", shutdown);
  }

  const FRAME_SCRIPT_URL =
    "data:application/javascript;charset=utf-8," +
    encodeURIComponent("(" + glanceFrameScript.toString() + ")();");

  // ---------------------------------------------------------------------
  // Parent side.
  // ---------------------------------------------------------------------
  const ui = window.AmayaUI;
  const { E10SUtils } = ChromeUtils.importESModule(
    "resource://gre/modules/E10SUtils.sys.mjs"
  );

  // Icon paths from the design system (16px stroke on a 24px grid). Used
  // only if AmayaUI.icon is missing.
  const ICON_PATHS = {
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    warning:
      '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.01"/>',
    "open-in-tab":
      '<path d="M14 5h5v5M19 5l-8 8M10 5H5v14h14v-5"/>',
    split: '<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M12 5v14"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };

  function log(...args) {
    if (ui && ui.log) {
      ui.log(NAME, ...args);
    } else {
      console.log("[amaya-ui:" + NAME + "]", ...args);
    }
  }

  function el(tag, attrs = {}, ...children) {
    let node = document.createElementNS(HTML_NS, tag);
    for (let [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) {
        continue;
      }
      if (k == "class") {
        node.className = v;
      } else {
        node.setAttribute(k, v === true ? "" : v);
      }
    }
    for (let c of children) {
      if (c === null || c === undefined) {
        continue;
      }
      node.append(typeof c == "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function icon(name) {
    let node = null;
    try {
      let got = ui && ui.icon ? ui.icon(name) : null;
      if (got && typeof got == "object" && got.nodeType) {
        node = got;
      } else if (typeof got == "string" && got.trim()) {
        node = new DOMParser().parseFromString(got, "image/svg+xml")
          .documentElement;
        node = document.importNode(node, true);
      }
    } catch (e) {
      node = null;
    }
    if (!node || node.localName != "svg") {
      node = new DOMParser().parseFromString(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
          (ICON_PATHS[name] || "") +
          "</svg>",
        "image/svg+xml"
      ).documentElement;
      node = document.importNode(node, true);
    }
    node.setAttribute("aria-hidden", "true");
    node.classList.add("amaya-glance__ico");
    return node;
  }

  function reducedMotion() {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  function emit(type, detail) {
    if (ui && typeof ui.emit == "function") {
      ui.emit(type, detail);
    } else {
      window.dispatchEvent(new CustomEvent("amaya:" + type, { detail }));
    }
  }

  function overlayRoot() {
    return (
      (ui && ui.overlayRoot) || document.getElementById("amaya-overlay-root")
    );
  }

  function isWebURL(uri) {
    return uri && (uri.schemeIs("http") || uri.schemeIs("https"));
  }

  function userContextIdOf(browser) {
    let id = 0;
    try {
      id = browser.browsingContext?.originAttributes?.userContextId || 0;
    } catch (e) {}
    if (!id) {
      id = parseInt(browser.getAttribute("usercontextid") || "0", 10) || 0;
    }
    return id;
  }

  // The single Glance, or null.
  let g = null;

  // ----- Layout ---------------------------------------------------------

  function contentRect() {
    let gb = window.gBrowser;
    let area =
      (gb && gb.tabpanels) || document.getElementById("tabbrowser-tabpanels");
    return area.getBoundingClientRect();
  }

  function layout() {
    if (!g) {
      return;
    }
    let root = overlayRoot().getBoundingClientRect();
    let c = contentRect();
    let left = c.left - root.left;
    let top = c.top - root.top;
    Object.assign(g.scrim.style, {
      left: left + "px",
      top: top + "px",
      width: c.width + "px",
      height: c.height + "px",
    });
    let w = Math.round(c.width * 0.92);
    let h = Math.round(c.height * 0.8);
    Object.assign(g.card.style, {
      left: Math.round(left + (c.width - w) / 2) + "px",
      top: Math.round(top + (c.height - h) / 2) + "px",
      width: w + "px",
      height: h + "px",
    });
  }

  // ----- Address bar ----------------------------------------------------

  function updateAddress() {
    if (!g) {
      return;
    }
    let uri = g.browser.currentURI;
    if (!uri || uri.spec == "about:blank") {
      uri = g.pendingURI || uri;
    }
    let host = "";
    let rest = "";
    try {
      let exposable = Services.io.createExposableURI(uri);
      if (isWebURL(exposable)) {
        host = exposable.displayHostPort;
        rest = exposable.displayPrePath.length
          ? exposable.displaySpec.slice(exposable.displayPrePath.length)
          : "";
        if (rest == "/") {
          rest = "";
        }
      } else {
        rest = exposable.displaySpec;
      }
    } catch (e) {
      rest = uri ? uri.spec : "";
    }
    g.host.textContent = host;
    g.path.textContent = rest;
    g.address.title = (uri && uri.spec) || "";
    g.card.setAttribute(
      "aria-label",
      "Glance preview" + (host ? " of " + host : "")
    );

    let secure = uri && uri.schemeIs("https");
    try {
      let state = g.browser.securityUI?.state;
      if (typeof state == "number") {
        secure =
          secure && !!(state & Ci.nsIWebProgressListener.STATE_IS_SECURE);
      }
    } catch (e) {}
    let insecure = uri && uri.schemeIs("http");
    if (g.secureState !== (secure ? "secure" : insecure ? "insecure" : "")) {
      g.secureState = secure ? "secure" : insecure ? "insecure" : "";
      g.security.replaceChildren();
      if (secure) {
        g.security.append(icon("lock"));
        g.security.setAttribute("aria-label", "Connection is secure");
        g.security.setAttribute("role", "img");
      } else if (insecure) {
        g.security.append(icon("warning"), el("span", {}, "Not secure"));
        g.security.removeAttribute("aria-label");
        g.security.removeAttribute("role");
      } else {
        g.security.removeAttribute("aria-label");
        g.security.removeAttribute("role");
      }
      g.security.classList.toggle(
        "amaya-glance__security--warn",
        !!insecure && !secure
      );
    }
  }

  // ----- Browser --------------------------------------------------------

  function createBrowser({ url, userContextId, sourceBrowser }) {
    let b = document.createElementNS(XUL_NS, "browser");
    // Same global as tabbrowser uses for permanentKey, so it can't keep this
    // window alive if something holds on to it.
    b.permanentKey = new (Cu.getGlobalForObject(Services).Object)();
    let remoteType = sourceBrowser?.remoteType || E10SUtils.WEB_REMOTE_TYPE;
    try {
      remoteType = ChromeUtils.predictRemoteTypeForURI(url, {
        window,
        userContextId,
        preferredRemoteType: sourceBrowser?.remoteType,
      });
    } catch (e) {}
    const attrs = {
      type: "content",
      remote: "true",
      remoteType,
      maychangeremoteness: "true",
      messagemanagergroup: "browsers",
      message: "true",
      nodefaultsrc: "true",
      contextmenu: "contentAreaContextMenu",
      tooltip: "aHTMLTooltip",
      autocompletepopup: "PopupAutoComplete",
      class: "amaya-glance__browser",
      "aria-label": "Preview",
    };
    if (userContextId) {
      attrs.usercontextid = String(userContextId);
    }
    for (let [k, v] of Object.entries(attrs)) {
      b.setAttribute(k, v);
    }
    return b;
  }

  function makeProgressListener() {
    return {
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
      onLocationChange(webProgress) {
        if (webProgress?.isTopLevel) {
          updateAddress();
        }
      },
      onSecurityChange(webProgress) {
        if (webProgress?.isTopLevel) {
          updateAddress();
        }
      },
      onStateChange(webProgress, request, flags, status) {
        if (!g || !webProgress?.isTopLevel) {
          return;
        }
        const WPL = Ci.nsIWebProgressListener;
        if (flags & WPL.STATE_START && flags & WPL.STATE_IS_NETWORK) {
          g.card.setAttribute("aria-busy", "true");
        }
        if (flags & WPL.STATE_STOP && flags & WPL.STATE_IS_NETWORK) {
          g.card.removeAttribute("aria-busy");
          // A link that turned out to be a download: the load is handed to
          // the download manager and the preview stays blank. Glance is
          // never used for downloads, so get out of the way.
          let blank =
            !g.browser.currentURI || g.browser.currentURI.spec == "about:blank";
          if (status == Cr.NS_BINDING_RETARGETED || (blank && g.pendingURI)) {
            let glance = g;
            Services.tm.dispatchToMainThread(() => {
              if (g === glance) {
                close({ animate: false });
              }
            });
            return;
          }
          g.pendingURI = null;
          updateAddress();
        }
      },
      onProgressChange() {},
      onStatusChange() {},
      onContentBlockingEvent() {},
    };
  }

  function load(uri, opts = {}) {
    let params = {
      triggeringPrincipal:
        opts.triggeringPrincipal ||
        Services.scriptSecurityManager.getSystemPrincipal(),
      hasValidUserGestureActivation: true,
    };
    if (opts.referrerInfo) {
      params.referrerInfo = opts.referrerInfo;
    }
    if (opts.policyContainer) {
      params.policyContainer = opts.policyContainer;
    }
    g.pendingURI = uri;
    updateAddress();
    try {
      g.browser.loadURI(uri, params);
    } catch (e) {
      log("load failed", e);
    }
  }

  // ----- Open / close ---------------------------------------------------

  function open({
    url,
    sourceBrowser,
    point,
    triggeringPrincipal,
    referrerInfo,
    policyContainer,
  }) {
    let uri;
    try {
      uri = Services.io.newURI(url);
    } catch (e) {
      return;
    }
    if (!isWebURL(uri)) {
      return;
    }
    let gb = window.gBrowser;
    sourceBrowser = sourceBrowser || gb.selectedBrowser;
    let sourceTab = gb.getTabForBrowser(sourceBrowser);
    if (!sourceTab) {
      return;
    }
    let userContextId = userContextIdOf(sourceBrowser);
    // The triggering principal must belong to the same container.
    if (
      triggeringPrincipal &&
      !triggeringPrincipal.isSystemPrincipal &&
      (triggeringPrincipal.originAttributes.userContextId || 0) !=
        userContextId
    ) {
      triggeringPrincipal = null;
      referrerInfo = null;
      policyContainer = null;
    }

    // Only one Glance at a time: reuse the open one.
    if (g) {
      load(uri, { triggeringPrincipal, referrerInfo, policyContainer });
      return;
    }
    let root = overlayRoot();
    if (!root) {
      log("no overlay root; Glance is unavailable");
      return;
    }

    let titleId = "amaya-glance-title";
    let host = el("span", { class: "amaya-glance__host" });
    let path = el("span", { class: "amaya-glance__path" });
    let address = el(
      "span",
      { class: "amaya-glance__address", id: titleId },
      host,
      path
    );
    let security = el("span", { class: "amaya-glance__security" });
    let openBtn = el(
      "button",
      { class: "amaya-glance__btn", type: "button" },
      icon("open-in-tab"),
      "Open as tab"
    );
    let splitBtn = el(
      "button",
      { class: "amaya-glance__btn", type: "button" },
      icon("split"),
      "Split"
    );
    let closeBtn = el(
      "button",
      {
        class: "amaya-glance__iconbtn",
        type: "button",
        "aria-label": "Close preview",
        title: "Close preview (Esc)",
      },
      icon("close")
    );
    let bar = el(
      "div",
      { class: "amaya-glance__bar" },
      security,
      address,
      openBtn,
      splitBtn,
      closeBtn
    );
    let body = el("div", { class: "amaya-glance__body" });
    let card = el(
      "section",
      {
        class: "amaya-glance",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Glance preview",
      },
      bar,
      body
    );
    let scrim = el("div", { class: "amaya-glance-scrim" });
    let layer = el(
      "div",
      { class: "amaya-glance-layer", id: "amaya-glance" },
      scrim,
      card
    );

    let browser = createBrowser({ url: uri.spec, userContextId, sourceBrowser });
    let prevFocus = document.commandDispatcher.focusedElement;

    g = {
      layer,
      scrim,
      card,
      bar,
      body,
      browser,
      address,
      host,
      path,
      security,
      openBtn,
      splitBtn,
      closeBtn,
      sourceTab,
      sourceBrowser,
      userContextId,
      prevFocus,
      pendingURI: uri,
      secureState: null,
      listener: makeProgressListener(),
      closing: false,
    };

    // Clicking anywhere outside the card closes, like a click on the scrim.
    layer.addEventListener("mousedown", e => {
      if (e.button == 0 && !card.contains(e.target)) {
        e.preventDefault();
        close();
      }
    });
    openBtn.addEventListener("click", () => openAsTab());
    splitBtn.addEventListener("click", () => openAsSplit());
    closeBtn.addEventListener("click", () => close());
    browser.addEventListener("oop-browser-crashed", () =>
      close({ animate: false })
    );

    root.append(layer);
    layout();
    body.append(browser);
    root.setAttribute("amaya-glance-open", "true");

    try {
      browser.webProgress.addProgressListener(
        g.listener,
        Ci.nsIWebProgress.NOTIFY_STATE_NETWORK |
          Ci.nsIWebProgress.NOTIFY_LOCATION |
          Ci.nsIWebProgress.NOTIFY_SECURITY
      );
    } catch (e) {
      log("progress listener failed", e);
    }
    try {
      browser.docShellIsActive = true;
    } catch (e) {}

    load(uri, { triggeringPrincipal, referrerInfo, policyContainer });
    updateAddress();
    startWatching();

    // Open: 180ms ease-out, scale 0.96 -> 1 and fade, from the click point.
    // Instant under reduced motion and when opened from the keyboard.
    if (point && !reducedMotion()) {
      let r = card.getBoundingClientRect();
      let ox = Math.min(Math.max(point.x - r.left, 0), r.width);
      let oy = Math.min(Math.max(point.y - r.top, 0), r.height);
      card.style.transformOrigin = ox + "px " + oy + "px";
      card.animate(
        [
          { opacity: 0, transform: "scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: OPEN_MS, easing: EASE_OUT }
      );
      scrim.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: OPEN_MS,
        easing: EASE_OUT,
      });
    }

    // Focus the page so the keyboard scrolls it; Tab reaches the bar.
    browser.focus();
  }

  function detachListener() {
    if (!g || !g.listener) {
      return;
    }
    try {
      g.browser.webProgress?.removeProgressListener(g.listener);
    } catch (e) {}
    g.listener = null;
  }

  function close({ animate = true, restoreFocus = true } = {}) {
    if (!g || g.closing) {
      return;
    }
    let glance = g;
    glance.closing = true;
    stopWatching();
    detachListener();
    g = null;

    let root = overlayRoot();
    root?.removeAttribute("amaya-glance-open");

    let finish = () => {
      try {
        glance.browser.remove();
      } catch (e) {}
      glance.layer.remove();
    };

    if (restoreFocus) {
      let target = glance.prevFocus;
      if (!target || !target.isConnected || glance.layer.contains(target)) {
        target = glance.sourceBrowser;
      }
      try {
        if (target && target.isConnected) {
          target.focus();
        }
      } catch (e) {}
    }

    if (animate && !reducedMotion()) {
      glance.layer.style.pointerEvents = "none";
      let opts = { duration: CLOSE_MS, easing: "ease-in", fill: "forwards" };
      glance.card.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "scale(0.98)" },
        ],
        opts
      );
      glance.scrim
        .animate([{ opacity: 1 }, { opacity: 0 }], opts)
        .finished.then(finish, finish);
    } else {
      finish();
    }
  }

  // ----- Into a tab -----------------------------------------------------

  /**
   * Creates a tab in the Glance's container and moves the live page into it
   * by swapping docshells, so nothing reloads.
   *
   * tabbrowser only swaps between two tabs, and keeps the tab's progress
   * listener ("filter") private. We capture that filter while the tab's
   * browser is inserted, swap the frame loaders, and move the filter to the
   * browsing context the tab now holds -- the same steps as tabbrowser's own
   * #swapBrowserDocShells.
   */
  function adoptIntoNewTab(glance, { select }) {
    let gb = window.gBrowser;
    let other = glance.browser;
    if (!other.browsingContext || !other.isRemoteBrowser) {
      throw new Error("Glance browser has no remote content to adopt");
    }

    // tabbrowser deletes per-instance overrides while inserting a browser,
    // so wrap the prototype getter, for this one browser, only for the
    // duration of the synchronous addTab() call below.
    let captured = { browser: null, listeners: [] };
    let observer = subject => {
      if (
        !captured.browser &&
        subject.ownerDocument === gb.tabpanels.ownerDocument
      ) {
        captured.browser = subject;
      }
    };
    let proto = null;
    let desc = null;
    for (let p = Object.getPrototypeOf(other); p; p = Object.getPrototypeOf(p)) {
      let d = Object.getOwnPropertyDescriptor(p, "webProgress");
      if (d) {
        proto = p;
        desc = d;
        break;
      }
    }
    if (!desc || !desc.get || !desc.configurable) {
      throw new Error("browser.webProgress is not a configurable getter");
    }
    let realGet = desc.get;
    let wrappedGet = function () {
      let wp = realGet.call(this);
      if (!wp || this !== captured.browser) {
        return wp;
      }
      // A forwarding object, not a Proxy on wp itself: XPCOM methods are
      // non-configurable, so a Proxy could not replace one.
      return new Proxy(
        {},
        {
          get(_, key) {
            if (key == "addProgressListener") {
              return (listener, mask) => {
                captured.listeners.push(listener);
                return wp.addProgressListener(listener, mask);
              };
            }
            let v = wp[key];
            return typeof v == "function" ? v.bind(wp) : v;
          },
        }
      );
    };

    let index;
    let src = glance.sourceTab;
    if (src && !src.closing && src.isConnected && gb.tabs.includes(src)) {
      index = gb.tabs.indexOf(src) + 1;
    }

    let tab;
    Services.obs.addObserver(
      observer,
      "tabbrowser-browser-element-will-be-inserted"
    );
    Object.defineProperty(proto, "webProgress", { ...desc, get: wrappedGet });
    try {
      tab = gb.addTab("about:blank", {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        userContextId: glance.userContextId,
        preferredRemoteType: other.remoteType,
        inBackground: true,
        skipAnimation: true,
        skipLoad: true,
        tabIndex: index,
        ownerTab: select ? src : null,
      });
    } finally {
      Object.defineProperty(proto, "webProgress", desc);
      Services.obs.removeObserver(
        observer,
        "tabbrowser-browser-element-will-be-inserted"
      );
    }

    if (!tab) {
      throw new Error("addTab failed");
    }
    let ours = tab.linkedBrowser;
    try {
      if (captured.browser !== ours || captured.listeners.length != 1) {
        throw new Error(
          "could not find the tab's progress listener (" +
            captured.listeners.length +
            ")"
        );
      }
      if (!ours.isRemoteBrowser) {
        throw new Error("new tab is not remote");
      }
      let filter = captured.listeners[0];

      ours.webProgress.removeProgressListener(filter);
      other.docShellIsActive = select || gb.shouldActivateDocShell(ours);
      ours.swapDocShells(other);
      ours.webProgress.addProgressListener(
        filter,
        Ci.nsIWebProgress.NOTIFY_ALL
      );
      // Keep session data with the page, like tabbrowser does.
      let key = ours.permanentKey;
      ours.permanentKey = other.permanentKey;
      other.permanentKey = key;
    } catch (e) {
      gb.removeTab(tab, { animate: false, skipSessionStore: true });
      throw e;
    }

    gb.setTabTitle(tab);
    if (select) {
      gb.selectedTab = tab;
    }
    if (tab.selected) {
      gb.updateCurrentBrowser(true);
    }
    return tab;
  }

  function reopenInNewTab(glance, { select }) {
    let gb = window.gBrowser;
    let uri = glance.browser.currentURI;
    if (!uri || uri.spec == "about:blank") {
      uri = glance.pendingURI;
    }
    if (!uri) {
      return null;
    }
    let src = glance.sourceTab;
    let index;
    if (src && gb.tabs.includes(src)) {
      index = gb.tabs.indexOf(src) + 1;
    }
    let principal = glance.browser.contentPrincipal;
    if (!principal || principal.isNullPrincipal || !isWebURL(uri)) {
      principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
        userContextId: glance.userContextId,
      });
    }
    return gb.addTab(uri.spec, {
      triggeringPrincipal: principal,
      userContextId: glance.userContextId,
      inBackground: !select,
      tabIndex: index,
    });
  }

  function moveToTab({ select }) {
    if (!g || g.closing) {
      return null;
    }
    let glance = g;
    let tab = null;
    // Stop our own listener first; the page is about to leave.
    stopWatching();
    detachListener();
    try {
      tab = adoptIntoNewTab(glance, { select });
    } catch (e) {
      log("could not move the page without reloading; opening it again", e);
      tab = null;
    }
    if (!tab) {
      try {
        tab = reopenInNewTab(glance, { select: false });
      } catch (e) {
        log("could not open the page in a tab", e);
      }
    }
    // The preview is gone (or now empty): remove it without animation.
    close({ animate: false, restoreFocus: false });
    if (tab && select) {
      window.gBrowser.selectedTab = tab;
      tab.linkedBrowser.focus();
    }
    return { tab, sourceTab: glance.sourceTab };
  }

  function openAsTab() {
    moveToTab({ select: true });
  }

  function openAsSplit() {
    let res = moveToTab({ select: false });
    if (!res || !res.tab) {
      return;
    }
    let tabs = [res.sourceTab, res.tab].filter(
      t => t && window.gBrowser.tabs.includes(t)
    );
    emit("split", { tabs, source: NAME });
  }

  // ----- While open: keyboard, focus trap, things that close it ---------

  function focusables() {
    return g ? [g.openBtn, g.splitBtn, g.closeBtn, g.browser] : [];
  }

  function onKeyDown(e) {
    if (!g) {
      return;
    }
    if (e.key == "Escape" && !e.defaultPrevented) {
      if (document.fullscreenElement || window.fullScreen) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key == "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      let list = focusables();
      let active = document.commandDispatcher.focusedElement;
      let i = list.indexOf(active);
      // Inside the page, Tab belongs to the page. When the page runs out of
      // focusable things, focus leaves it and onFocusIn brings it back.
      if (i < 0 || active === g.browser) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      let next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
      next.focus();
    }
  }

  function onFocusIn(e) {
    if (!g || g.closing) {
      return;
    }
    let t = e.target;
    if (!t || t === window || t === document || t.nodeType != 1) {
      return;
    }
    if (g.layer.contains(t)) {
      return;
    }
    // Focus escaped the dialog (Tab out of the page, a click elsewhere...).
    g.openBtn.focus();
  }

  function onTabEvent(e) {
    if (!g) {
      return;
    }
    if (e.type == "TabSelect" || e.target === g.sourceTab) {
      close({ animate: false, restoreFocus: false });
    }
  }

  function onSpaceChanged() {
    close({ animate: false, restoreFocus: false });
  }

  function onResize() {
    layout();
  }

  function startWatching() {
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("resize", onResize);
    let tc = window.gBrowser.tabContainer;
    tc.addEventListener("TabSelect", onTabEvent);
    tc.addEventListener("TabClose", onTabEvent);
    window.addEventListener("amaya:space-changed", onSpaceChanged);
  }

  function stopWatching() {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("focusin", onFocusIn, true);
    window.removeEventListener("resize", onResize);
    let tc = window.gBrowser?.tabContainer;
    tc?.removeEventListener("TabSelect", onTabEvent);
    tc?.removeEventListener("TabClose", onTabEvent);
    window.removeEventListener("amaya:space-changed", onSpaceChanged);
  }

  // ----- Inputs ---------------------------------------------------------

  function onContentMessage(msg) {
    // The window message manager only hears from this window's browsers.
    let browser = msg.target;
    if (!browser) {
      return;
    }
    let d = msg.data || {};
    let triggeringPrincipal = null;
    let referrerInfo = null;
    let policyContainer = null;
    try {
      triggeringPrincipal = d.triggeringPrincipal
        ? E10SUtils.deserializePrincipal(d.triggeringPrincipal)
        : null;
    } catch (e) {}
    try {
      referrerInfo = d.referrerInfo
        ? E10SUtils.deserializeReferrerInfo(d.referrerInfo)
        : null;
    } catch (e) {}
    try {
      policyContainer = d.policyContainer
        ? E10SUtils.deserializePolicyContainer(d.policyContainer)
        : null;
    } catch (e) {}
    if (!triggeringPrincipal) {
      return;
    }

    // A link inside the Glance replaces its content.
    if (g && browser === g.browser) {
      let uri;
      try {
        uri = Services.io.newURI(d.href);
      } catch (e) {
        return;
      }
      if (isWebURL(uri)) {
        load(uri, { triggeringPrincipal, referrerInfo, policyContainer });
      }
      return;
    }
    if (!window.gBrowser.getTabForBrowser(browser)) {
      return;
    }
    let point = null;
    if (typeof d.screenX == "number") {
      point = {
        x: d.screenX - window.mozInnerScreenX,
        y: d.screenY - window.mozInnerScreenY,
      };
    }
    open({
      url: d.href,
      sourceBrowser: browser,
      point,
      triggeringPrincipal,
      referrerInfo,
      policyContainer,
    });
  }

  function onOpenGlanceEvent(e) {
    let d = (e && e.detail) || {};
    if (!d.url) {
      return;
    }
    // Opened by another module (command bar, keyboard...): no animation.
    open({
      url: String(d.url),
      sourceBrowser: window.gBrowser.selectedBrowser,
      point: null,
      triggeringPrincipal: d.triggeringPrincipal || null,
    });
  }

  // ----- Module ---------------------------------------------------------

  const glanceModule = {
    init() {
      window.messageManager.addMessageListener(MSG_OPEN, onContentMessage);
      window.messageManager.loadFrameScript(FRAME_SCRIPT_URL, true);
      window.addEventListener("amaya:open-glance", onOpenGlanceEvent);
    },
    uninit() {
      close({ animate: false, restoreFocus: false });
      window.removeEventListener("amaya:open-glance", onOpenGlanceEvent);
      try {
        window.messageManager.removeDelayedFrameScript(FRAME_SCRIPT_URL);
        window.messageManager.broadcastAsyncMessage(MSG_SHUTDOWN);
      } catch (e) {}
      window.messageManager.removeMessageListener(MSG_OPEN, onContentMessage);
    },
    // For tests and other modules.
    open(url) {
      open({ url, sourceBrowser: window.gBrowser.selectedBrowser });
    },
    close() {
      close();
    },
    get isOpen() {
      return !!g;
    },
    get browser() {
      return g ? g.browser : null;
    },
    openAsTab,
    openAsSplit,
  };

  if (ui && typeof ui.register == "function") {
    ui.register(NAME, glanceModule);
  } else {
    log("AmayaUI is missing; Glance not registered");
  }
})();
