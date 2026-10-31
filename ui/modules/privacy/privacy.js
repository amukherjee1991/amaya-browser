/* Amaya privacy module: the shield in the address field and the privacy panel.
 *
 * Runs in the browser window scope (privileged). Owns ui/modules/privacy/.
 *
 * Gecko APIs used (all local, nothing is sent anywhere):
 *   gBrowser.addProgressListener   onLocationChange / onSecurityChange /
 *                                  onContentBlockingEvent for the selected tab
 *   browser.getContentBlockingLog  per-page log (JSON) the counters come from
 *   gIdentityHandler._is*          connection state (secure, upgraded,
 *                                  certificate error, ...) for the current tab
 *   ContentBlockingAllowList       per-site "Block trackers on this site"
 *   amaya.fingerprinting.mode      read by amaya.cfg at startup; the effective
 *                                  mode is the default value it gave to
 *                                  privacy.resistFingerprinting
 *
 * "Report broken site" deliberately does NOT use Firefox's built-in reporter
 * (browser/components/reportbrokensite): that one submits a Glean
 * "broken-site-report" ping to Mozilla and links to webcompat.com. Ours opens
 * a prefilled issue on Amaya's own tracker, which the person reviews and
 * submits themselves.
 */
(function () {
  "use strict";

  const NAME = "privacy";
  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const { ContentBlockingAllowList } = ChromeUtils.importESModule(
    "resource://gre/modules/ContentBlockingAllowList.sys.mjs"
  );

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const WPL = Ci.nsIWebProgressListener;
  const FP_PREF = "amaya.fingerprinting.mode";
  const CATEGORY_PREF = "browser.contentblocking.category";
  const REPORT_URL =
    "https://github.com/amukherjee1991/amaya-browser/issues/new";

  // Content blocking log flags -> the three counters. An origin counts once
  // per counter; a fingerprinter is counted as a fingerprint attempt, not
  // also as a tracker.
  const FP_FLAGS =
    WPL.STATE_BLOCKED_FINGERPRINTING_CONTENT |
    WPL.STATE_BLOCKED_SUSPICIOUS_FINGERPRINTING |
    WPL.STATE_REPLACED_FINGERPRINTING_CONTENT;
  const TRACKER_FLAGS =
    WPL.STATE_BLOCKED_TRACKING_CONTENT |
    WPL.STATE_REPLACED_TRACKING_CONTENT |
    WPL.STATE_BLOCKED_SOCIALTRACKING_CONTENT |
    WPL.STATE_BLOCKED_CRYPTOMINING_CONTENT |
    WPL.STATE_BLOCKED_EMAILTRACKING_CONTENT |
    WPL.STATE_COOKIES_BLOCKED_TRACKER |
    WPL.STATE_COOKIES_BLOCKED_SOCIALTRACKER;
  const APART_FLAGS =
    WPL.STATE_COOKIES_PARTITIONED_FOREIGN |
    WPL.STATE_COOKIES_PARTITIONED_TRACKER |
    WPL.STATE_COOKIES_BLOCKED_FOREIGN;

  // Icons from the design system set (16px, 24 grid, 1.5 stroke). Used when
  // the loader's ui.icon() is not available or does not know the name.
  const ICON_PATHS = {
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>',
    warning:
      '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
    pause: '<path d="M9 6v12M15 6v12"/>',
    lock:
      '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
  };

  function icon(name, cls = "") {
    let el = null;
    try {
      let got = typeof ui.icon == "function" ? ui.icon(name) : null;
      if (got && typeof got == "object" && got.nodeType == 1) {
        el = got;
      } else if (typeof got == "string" && got.includes("<svg")) {
        el = parseSVG(got);
      }
    } catch (e) {}
    if (!el) {
      el = parseSVG(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${
          ICON_PATHS[name] || ""
        }</svg>`
      );
    }
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("class", `amaya-privacy-ico ${cls}`.trim());
    return el;
  }

  function parseSVG(markup) {
    let doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    return document.importNode(doc.documentElement, true);
  }

  function h(tag, props = {}, ...children) {
    let el = document.createElementNS(HTML_NS, tag);
    for (let [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) {
        continue;
      }
      if (k == "class") {
        el.className = v;
      } else if (k == "text") {
        el.textContent = v;
      } else if (k.startsWith("on")) {
        el.addEventListener(k.slice(2), v);
      } else {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    for (let c of children.flat()) {
      if (c !== null && c !== undefined) {
        el.append(c);
      }
    }
    return el;
  }

  /* ------------------------------------------------------------------ */

  const COOKIES_LOADED_FLAGS =
    WPL.STATE_COOKIES_LOADED |
    WPL.STATE_COOKIES_LOADED_TRACKER |
    WPL.STATE_COOKIES_LOADED_SOCIALTRACKER;

  function baseDomainOf(spec) {
    try {
      let uri = Services.io.newURI(spec);
      try {
        return Services.eTLD.getBaseDomain(uri);
      } catch (e) {
        return uri.host;
      }
    } catch (e) {
      return null;
    }
  }

  /**
   * Counts the three local counters from the selected page's content blocking
   * log ({origin: [[flag, blocked, count, reason?], ...]}).
   *
   * "Cookies kept apart": origins whose cookies were partitioned. Gecko only
   * logs an explicit "partitioned" flag on some storage paths, so with
   * Total Cookie Protection active (cookieBehavior 5) and the site not paused
   * we also count other sites that used cookies here: those cookies are
   * always kept in this site's partition.
   */
  function countBlocked(browser, { paused = false } = {}) {
    let counts = { trackers: 0, fingerprinters: 0, apart: 0 };
    let raw = null;
    try {
      raw = browser.getContentBlockingLog();
    } catch (e) {}
    if (!raw) {
      return counts;
    }
    let log;
    try {
      log = JSON.parse(raw);
    } catch (e) {
      return counts;
    }
    let partitionAll =
      !paused &&
      Services.prefs.getIntPref("network.cookie.cookieBehavior", 0) ==
        Ci.nsICookieService.BEHAVIOR_PARTITION_FOREIGN;
    let topSite = baseDomainOf(browser.currentURI?.spec || "");
    for (let [origin, actions] of Object.entries(log)) {
      let fp = false,
        tracker = false,
        apart = false,
        cookies = false;
      for (let [type, blocked] of actions) {
        fp ||= (type & FP_FLAGS) != 0;
        tracker ||= (type & TRACKER_FLAGS) != 0;
        apart ||= (type & APART_FLAGS) != 0;
        cookies ||= (type & COOKIES_LOADED_FLAGS) != 0 && blocked !== false;
      }
      if (fp) {
        counts.fingerprinters++;
      } else if (tracker) {
        counts.trackers++;
      }
      if (
        apart ||
        (cookies && partitionAll && !fp && !tracker &&
          baseDomainOf(origin) != topSite)
      ) {
        counts.apart++;
      }
    }
    return counts;
  }

  function effectiveFpMode() {
    // amaya.cfg turns privacy.resistFingerprinting on (as a default) only in
    // Uniform mode, at startup. That is what is running now.
    try {
      return Services.prefs
        .getDefaultBranch("")
        .getBoolPref("privacy.resistFingerprinting", false)
        ? "uniform"
        : "balanced";
    } catch (e) {
      return "balanced";
    }
  }

  function chosenFpMode() {
    let v = Services.prefs.getStringPref(FP_PREF, "balanced");
    return v == "uniform" ? "uniform" : "balanced";
  }

  /* ------------------------------------------------------------------ */

  class PrivacyUI {
    constructor(win) {
      this.win = win;
      this.state = null;
      this.isOpen = false;
      this.spaceName = null;
      this._pending = 0;
      this._cleanup = [];
    }

    listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      this._cleanup.push(() => target.removeEventListener(type, fn, opts));
    }

    init() {
      this.buildShield();
      this.buildPanel();
      this.mountShield();

      // Progress events for the selected tab (also replayed on tab switch).
      this.progressListener = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onLocationChange: () => this.scheduleUpdate(),
        onSecurityChange: () => this.scheduleUpdate(),
        onContentBlockingEvent: () => this.scheduleUpdate(),
        onStateChange: () => {},
        onProgressChange: () => {},
        onStatusChange: () => {},
      };
      gBrowser.addProgressListener(this.progressListener);

      this.listen(gBrowser.tabContainer, "TabSelect", () => {
        this.close({ restoreFocus: false });
        this.scheduleUpdate();
      });

      // Prefs that change what we show.
      this.prefObserver = { observe: () => this.scheduleUpdate() };
      Services.prefs.addObserver(FP_PREF, this.prefObserver);
      Services.prefs.addObserver(CATEGORY_PREF, this.prefObserver);
      // Allow-list changes made elsewhere (other windows, settings page).
      this.permObserver = {
        observe: (subject, topic, data) => {
          let perm = subject?.QueryInterface?.(Ci.nsIPermission);
          if (perm && perm.type.startsWith("trackingprotection")) {
            this.scheduleUpdate();
          }
        },
      };
      Services.obs.addObserver(this.permObserver, "perm-changed");

      // Dismiss: outside click, focus leaving, Esc, window resize.
      this.listen(window, "mousedown", e => this.onWindowMouseDown(e), true);
      this.listen(window, "focusin", e => this.onWindowFocusIn(e), true);
      this.listen(window, "keydown", e => this.onWindowKeyDown(e), true);
      this.listen(window, "resize", () => this.close({ restoreFocus: false }));

      // Space name for the status line, if the spaces module is present.
      if (typeof ui.on == "function") {
        let off = ui.on("space-changed", e => {
          let d = (e && e.detail) || e || {};
          this.spaceName = d.name || null;
          this.scheduleUpdate();
        });
        if (typeof off == "function") {
          this._cleanup.push(off);
        }
        let off2 = ui.on("register-commands", e => {
          let add = e?.detail?.add;
          if (typeof add == "function") {
            this.registerCommands(add);
          }
        });
        if (typeof off2 == "function") {
          this._cleanup.push(off2);
        }
      }
      this.registerCommands();

      // The shell may build the sidebar slot (and move #urlbar) after us.
      if (!this.shield.isConnected && typeof ui.whenAnchor == "function") {
        ui.whenAnchor("amaya-urlbar-slot", () => this.mountShield());
      }

      this.update();
    }

    uninit() {
      try {
        gBrowser.removeProgressListener(this.progressListener);
      } catch (e) {}
      Services.prefs.removeObserver(FP_PREF, this.prefObserver);
      Services.prefs.removeObserver(CATEGORY_PREF, this.prefObserver);
      try {
        Services.obs.removeObserver(this.permObserver, "perm-changed");
      } catch (e) {}
      for (let fn of this._cleanup.splice(0)) {
        try {
          fn();
        } catch (e) {}
      }
      this.shield?.remove();
      this.chip?.remove();
      this.panel?.remove();
      this.ownLayer?.remove();
      document.documentElement.removeAttribute("amaya-privacy");
    }

    /* ---------------- shield ---------------- */

    buildShield() {
      this.shieldIcon = h("span", { class: "amaya-privacy-shield__icon" });
      this.shieldText = h("span", { class: "amaya-privacy-shield__text" });
      this.shieldExtra = h("span", { class: "amaya-privacy-shield__extra" });
      this.shield = h(
        "button",
        {
          id: "amaya-privacy-shield",
          class: "amaya-privacy-shield",
          type: "button",
          "aria-haspopup": "dialog",
          "aria-expanded": "false",
          "aria-controls": "amaya-privacy-panel",
        },
        this.shieldIcon,
        this.shieldText,
        this.shieldExtra
      );
      // Keep the address field from treating these as clicks into it.
      for (let type of ["mousedown", "mouseup", "click", "dblclick"]) {
        this.listen(this.shield, type, e => {
          e.stopPropagation();
          if (type == "click" && e.button == 0) {
            this.toggle({ keyboard: e.detail == 0 });
          }
        });
      }
      this.chip = h(
        "span",
        { class: "amaya-privacy-chip", "aria-hidden": "true", hidden: true },
        icon("lock"),
        h("span", { text: "Upgraded" })
      );
      this.chip.setAttribute("title", "Upgraded to HTTPS");
    }

    /** Puts the shield at the left of the address field. */
    mountShield() {
      let urlbar = document.getElementById("urlbar");
      let container = urlbar?.querySelector(".urlbar-input-container");
      if (container) {
        // Where Firefox's own site-info icons sit (we hide those in CSS).
        let ref =
          container.querySelector(":scope > #trust-icon-container") ||
          container.querySelector(":scope > #tracking-protection-icon-container") ||
          container.querySelector(":scope > #identity-box") ||
          container.firstElementChild;
        container.insertBefore(this.shield, ref);
        this.shield.after(this.chip);
      } else {
        let slot =
          (typeof ui.anchor == "function" && ui.anchor("amaya-urlbar-slot")) ||
          document.getElementById("amaya-urlbar-slot");
        if (!slot) {
          return;
        }
        slot.prepend(this.shield, this.chip);
      }
      // Firefox's tracking-protection / trust icon is hidden while we own the
      // shield (CSS keys off this attribute), so there is only one shield.
      document.documentElement.setAttribute("amaya-privacy", "");
    }

    /* ---------------- state ---------------- */

    scheduleUpdate() {
      if (this._pending) {
        return;
      }
      // After the window's own listeners (gIdentityHandler) have run.
      this._pending = window.requestAnimationFrame(() => {
        this._pending = 0;
        this.update();
      });
      // rAF does not run in a hidden window; make sure we still update.
      window.setTimeout(() => {
        if (this._pending) {
          window.cancelAnimationFrame(this._pending);
          this._pending = 0;
          this.update();
        }
      }, 100);
    }

    computeState() {
      let browser = gBrowser.selectedBrowser;
      let id = window.gIdentityHandler || {};
      let uri = gBrowser.currentURI;
      let host = "";
      try {
        host = id.getHostForDisplay?.() || uri?.displayHost || "";
      } catch (e) {
        host = uri?.displayHost || "";
      }
      let s = {
        host,
        kind: "none",
        canHandle: false,
        paused: false,
        upgraded: false,
        // Loopback pages over http count as secure ("potentially
        // trustworthy") but are not HTTPS.
        https: uri?.scheme == "https",
        counts: { trackers: 0, fingerprinters: 0, apart: 0 },
      };

      let canHandle = false;
      try {
        canHandle = ContentBlockingAllowList.canHandle(browser);
      } catch (e) {}
      s.canHandle = canHandle;
      if (canHandle) {
        try {
          s.paused = ContentBlockingAllowList.includes(browser);
        } catch (e) {}
        s.counts = countBlocked(browser, { paused: s.paused });
      }

      if (id._isCertErrorPage || id._isCertUserOverridden) {
        s.kind = "cert";
      } else if (id._isAboutHttpsOnlyErrorPage) {
        s.kind = "insecure";
      } else if (!canHandle || !/^https?$/.test(uri?.scheme || "")) {
        s.kind = "none";
      } else {
        let secure =
          !!id._isSecureConnection ||
          (!!id._isPotentiallyTrustworthy && !id._isBrokenConnection);
        if (id._isBrokenConnection || !secure) {
          s.kind = "insecure";
        } else {
          s.kind = "protected";
          s.upgraded =
            !!id._isContentHttpsOnlyModeUpgraded ||
            !!id._isContentHttpsFirstModeUpgraded;
        }
      }
      s.total = s.counts.trackers + s.counts.fingerprinters + s.counts.apart;
      return s;
    }

    update() {
      let s = (this.state = this.computeState());
      this.renderShield(s);
      if (this.isOpen) {
        if (s.kind == "none" && !s.canHandle) {
          this.close({ restoreFocus: false });
        } else {
          this.renderPanel(s);
        }
      }
    }

    renderShield(s) {
      let sh = this.shield;
      sh.hidden = s.kind == "none";
      this.chip.hidden = !(s.kind == "protected" && s.upgraded && !s.paused);
      let variant =
        s.kind == "cert"
          ? "danger"
          : s.kind == "insecure"
            ? "warn"
            : s.paused
              ? "off"
              : "brand";
      sh.dataset.state = s.paused && s.kind == "protected" ? "paused" : s.kind;
      sh.dataset.variant = variant;

      let iconName = "shield",
        word = "",
        label = "";
      switch (s.kind) {
        case "cert":
          iconName = "warning";
          word = "Certificate error";
          label = `Certificate error. This site's identity could not be checked.`;
          break;
        case "insecure":
          iconName = "warning";
          word = "Not secure";
          label = "Not secure. This page is not encrypted.";
          break;
        default:
          if (s.paused) {
            iconName = "pause";
            word = "Off";
            label = `Protection paused for this site.`;
          } else {
            word = s.total > 0 ? String(s.total) : "";
            label =
              `Protected on ${s.host}.` +
              (s.total > 0 ? ` ${s.total} blocked.` : "") +
              (s.upgraded ? " Upgraded to HTTPS." : "");
          }
      }
      // Paused while also not secure: show both words.
      let showOff = s.paused && (s.kind == "insecure" || s.kind == "cert");
      this.shieldIcon.replaceChildren(icon(iconName));
      this.shieldText.textContent = word;
      this.shieldText.hidden = !word;
      this.shieldExtra.replaceChildren(
        ...(showOff ? [icon("pause"), h("span", { text: "Off" })] : [])
      );
      this.shieldExtra.hidden = !showOff;
      if (showOff) {
        label += " Protection paused for this site.";
      }
      sh.setAttribute("aria-label", `Privacy panel. ${label}`);
      sh.title = label;
    }

    /* ---------------- panel ---------------- */

    layer() {
      let root = ui.overlayRoot;
      if (root && root.isConnected) {
        return root;
      }
      if (!this.ownLayer) {
        this.ownLayer = h("div", { id: "amaya-privacy-layer" });
        (document.body || document.documentElement).append(this.ownLayer);
      }
      return this.ownLayer;
    }

    buildPanel() {
      let stat = (key, label) => {
        let b = h("b", { text: "0" });
        this[`stat_${key}`] = b;
        return h("div", { class: "amaya-privacy-stat" }, b, h("span", { text: label }));
      };

      this.headMark = h("span", { class: "amaya-privacy-mark" });
      this.title = h("div", { class: "amaya-privacy-title", id: "amaya-privacy-title" });
      this.sub = h("div", { class: "amaya-privacy-sub", id: "amaya-privacy-status" });

      this.segBalanced = h("button", {
        type: "button",
        role: "radio",
        "data-mode": "balanced",
        text: "Balanced",
      });
      this.segUniform = h("button", {
        type: "button",
        role: "radio",
        "data-mode": "uniform",
        text: "Uniform",
      });
      let segment = h(
        "div",
        {
          class: "amaya-privacy-segment",
          role: "radiogroup",
          "aria-labelledby": "amaya-privacy-fp-label",
          "aria-describedby": "amaya-privacy-fp-cost",
        },
        this.segBalanced,
        this.segUniform
      );
      for (let b of [this.segBalanced, this.segUniform]) {
        b.addEventListener("click", () => this.setFpMode(b.dataset.mode));
      }
      segment.addEventListener("keydown", e => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
          return;
        }
        e.preventDefault();
        let next =
          e.key == "Home"
            ? "balanced"
            : e.key == "End"
              ? "uniform"
              : chosenFpMode() == "balanced"
                ? "uniform"
                : "balanced";
        this.setFpMode(next);
        (next == "balanced" ? this.segBalanced : this.segUniform).focus();
      });

      this.restartBtn = h("button", {
        type: "button",
        class: "amaya-privacy-btn amaya-privacy-btn--quiet amaya-privacy-restart",
        text: "Restart now",
        hidden: true,
        onclick: () => this.restart(),
      });
      this.costLine = h(
        "div",
        { class: "amaya-privacy-cost" },
        h("span", {
          class: "amaya-privacy-sub",
          id: "amaya-privacy-fp-cost",
          text: "Uniform may change how some sites look. Takes effect after restart.",
        }),
        this.restartBtn
      );

      this.toggle_ = h("button", {
        type: "button",
        class: "amaya-privacy-toggle",
        role: "switch",
        "aria-checked": "true",
        "aria-labelledby": "amaya-privacy-tp-label",
        "aria-describedby": "amaya-privacy-tp-sub",
        onclick: () => this.setSiteBlocking(!this.state || this.state.paused),
      });

      this.panel = h(
        "section",
        {
          id: "amaya-privacy-panel",
          class: "amaya-privacy-panel",
          role: "dialog",
          "aria-labelledby": "amaya-privacy-title",
          "aria-describedby": "amaya-privacy-status",
          tabindex: "-1",
          hidden: true,
        },
        h(
          "div",
          { class: "amaya-privacy-head" },
          this.headMark,
          h("div", { class: "amaya-privacy-headtext" }, this.title, this.sub)
        ),
        h(
          "div",
          { class: "amaya-privacy-stats", role: "group", "aria-label": "On this page" },
          stat("trackers", "Trackers blocked"),
          stat("fingerprinters", "Fingerprint attempts"),
          stat("apart", "Cookies kept apart")
        ),
        h(
          "div",
          { class: "amaya-privacy-fp" },
          h(
            "div",
            { class: "amaya-privacy-row" },
            h(
              "div",
              {},
              h("div", {
                class: "amaya-privacy-label",
                id: "amaya-privacy-fp-label",
                text: "Fingerprint protection",
              }),
              h("div", {
                class: "amaya-privacy-sub",
                text: "Balanced mixes your values. Uniform matches everyone.",
              })
            ),
            segment
          ),
          this.costLine
        ),
        h(
          "div",
          { class: "amaya-privacy-row" },
          h(
            "div",
            {},
            h("div", {
              class: "amaya-privacy-label",
              id: "amaya-privacy-tp-label",
              text: "Block trackers on this site",
            }),
            h("div", {
              class: "amaya-privacy-sub",
              id: "amaya-privacy-tp-sub",
              text: "Turning off may fix a broken page",
            })
          ),
          this.toggle_
        ),
        h(
          "div",
          { class: "amaya-privacy-actions" },
          h("button", {
            type: "button",
            class: "amaya-privacy-btn",
            text: "See what was blocked",
            onclick: () => {
              this.close({ restoreFocus: false });
              this.openReport();
            },
          }),
          h("button", {
            type: "button",
            class: "amaya-privacy-btn amaya-privacy-btn--quiet",
            text: "Report broken site",
            onclick: () => {
              this.close({ restoreFocus: false });
              this.reportBrokenSite();
            },
          })
        )
      );
      this.panel.addEventListener("keydown", e => {
        if (e.key == "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.close({ restoreFocus: true });
        }
      });
    }

    renderPanel(s) {
      let kind = s.kind;
      let markVariant =
        kind == "cert" ? "danger" : kind == "insecure" ? "warn" : s.paused ? "off" : "brand";
      this.panel.dataset.variant = markVariant;
      this.headMark.replaceChildren(
        icon(kind == "cert" || kind == "insecure" ? "warning" : s.paused ? "pause" : "shield")
      );

      let host = s.host || "this site";
      let title, sub;
      if (kind == "cert") {
        title = `Certificate error on ${host}`;
        sub = "This site's identity could not be checked.";
      } else if (kind == "insecure") {
        title = `Not secure on ${host}`;
        sub = "This page is not encrypted. Others on your network can read what you send.";
      } else if (s.paused) {
        title = "Protection paused for this site";
        sub = `${host}. Trackers are not blocked here.`;
      } else {
        title = `Protected on ${host}`;
        let cat = Services.prefs.getStringPref(CATEGORY_PREF, "standard");
        let parts = [
          cat == "strict"
            ? "Strict blocking"
            : cat == "custom"
              ? "Custom blocking"
              : "Standard blocking",
          s.upgraded ? "Upgraded to HTTPS" : s.https ? "HTTPS" : "Local connection",
        ];
        if (this.spaceName) {
          parts.push(`${this.spaceName} space`);
        }
        sub = parts.join(" · ");
      }
      if (s.paused && (kind == "cert" || kind == "insecure")) {
        sub += " Protection paused for this site.";
      }
      this.title.textContent = title;
      this.sub.textContent = sub;
      this.panel.setAttribute("aria-label", `Privacy on ${host}`);

      this.stat_trackers.textContent = s.counts.trackers;
      this.stat_fingerprinters.textContent = s.counts.fingerprinters;
      this.stat_apart.textContent = s.counts.apart;

      let mode = chosenFpMode();
      for (let b of [this.segBalanced, this.segUniform]) {
        let on = b.dataset.mode == mode;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
        b.tabIndex = on ? 0 : -1;
      }
      this.restartBtn.hidden = mode == effectiveFpMode();

      let blocking = !s.paused;
      this.toggle_.setAttribute("aria-checked", blocking ? "true" : "false");
      this.toggle_.disabled = !s.canHandle;
    }

    position() {
      let layer = this.layer();
      let a = this.shield.getBoundingClientRect();
      let l = layer.getBoundingClientRect();
      let width = 340;
      let gap = 6;
      let margin = 8;
      let maxLeft = l.width - width - margin;
      let left = Math.max(margin, Math.min(a.left - l.left, maxLeft));
      let top = a.bottom - l.top + gap;
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
      let originX = Math.round(a.left - l.left + a.width / 2 - left);
      this.panel.style.transformOrigin = `${originX}px 0`;
    }

    toggle({ keyboard = false } = {}) {
      if (this.isOpen) {
        this.close({ restoreFocus: keyboard });
      } else {
        this.open({ animate: !keyboard, focusFirst: keyboard });
      }
    }

    open({ animate = true, focusFirst = false } = {}) {
      if (this.shield.hidden || !this.shield.isConnected) {
        return false;
      }
      let layer = this.layer();
      if (this.panel.parentNode != layer) {
        layer.append(this.panel);
      }
      this.update();
      this.renderPanel(this.state);
      this.panel.hidden = false;
      this.position();
      this.isOpen = true;
      this.shield.setAttribute("aria-expanded", "true");
      this.shield.classList.add("is-open");
      this.panel.classList.remove("is-animating");
      if (animate) {
        // Restart the CSS animation (no-op under reduced motion).
        void this.panel.offsetWidth;
        this.panel.classList.add("is-animating");
      }
      if (focusFirst) {
        let first = this.panel.querySelector(
          ".amaya-privacy-segment [aria-checked='true']"
        );
        (first || this.panel).focus();
      } else {
        this.panel.focus({ preventScroll: true });
      }
      return true;
    }

    close({ restoreFocus = false } = {}) {
      if (!this.isOpen) {
        return;
      }
      this.isOpen = false;
      this.panel.hidden = true;
      this.panel.classList.remove("is-animating");
      this.shield.setAttribute("aria-expanded", "false");
      this.shield.classList.remove("is-open");
      if (restoreFocus && !this.shield.hidden) {
        this.shield.focus();
      }
    }

    onWindowMouseDown(e) {
      if (!this.isOpen) {
        return;
      }
      let t = e.composedTarget || e.target;
      if (this.panel.contains(t) || this.shield.contains(t)) {
        return;
      }
      this.close({ restoreFocus: false });
    }

    onWindowFocusIn(e) {
      if (!this.isOpen) {
        return;
      }
      let t = e.composedTarget || e.target;
      if (this.panel.contains(t) || this.shield.contains(t)) {
        return;
      }
      this.close({ restoreFocus: false });
    }

    onWindowKeyDown(e) {
      if (this.isOpen && e.key == "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.close({ restoreFocus: true });
      }
    }

    /* ---------------- actions ---------------- */

    setFpMode(mode) {
      mode = mode == "uniform" ? "uniform" : "balanced";
      if (mode == "balanced") {
        // Default value; clear rather than store it.
        Services.prefs.clearUserPref(FP_PREF);
        if (chosenFpMode() != "balanced") {
          Services.prefs.setStringPref(FP_PREF, "balanced");
        }
      } else {
        Services.prefs.setStringPref(FP_PREF, "uniform");
      }
      if (this.isOpen) {
        this.renderPanel(this.state || this.computeState());
      }
    }

    setSiteBlocking(on) {
      let browser = gBrowser.selectedBrowser;
      if (!ContentBlockingAllowList.canHandle(browser)) {
        return;
      }
      if (on) {
        ContentBlockingAllowList.remove(browser);
      } else {
        ContentBlockingAllowList.add(browser);
      }
      this.update();
      gBrowser.reloadTab(gBrowser.selectedTab);
    }

    openReport() {
      if (window.gProtectionsHandler?.openProtections) {
        gProtectionsHandler.openProtections(true);
      } else {
        openTrustedLinkIn("about:protections", "tab");
      }
    }

    reportBrokenSite() {
      let s = this.state || this.computeState();
      let host = s.host || "";
      let body =
        `Site: ${host}\n` +
        `Tracker blocking on this site: ${s.paused ? "off" : "on"}\n` +
        `Fingerprint protection: ${effectiveFpMode()}\n` +
        `Amaya version: ${Services.appinfo.version}\n` +
        `\nWhat does not work:\n\n`;
      let params = new URLSearchParams({
        labels: "broken-site",
        title: `Broken site: ${host}`,
        body,
      });
      // Opens a prefilled form; nothing is sent until the person submits it.
      openTrustedLinkIn(`${REPORT_URL}?${params}`, "tab", {
        relatedToCurrent: true,
      });
    }

    restart() {
      let cancel = Cc["@mozilla.org/supports-PRBool;1"].createInstance(
        Ci.nsISupportsPRBool
      );
      Services.obs.notifyObservers(cancel, "quit-application-requested", "restart");
      if (!cancel.data) {
        Services.startup.quit(
          Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart
        );
      }
    }

    openConnectionDetails() {
      if (typeof BrowserCommands?.pageInfo == "function") {
        BrowserCommands.pageInfo(null, "securityTab");
      }
    }

    /**
     * Without `add`: register with the command bar (contract event). With
     * `add` (the bar's open-time "register-commands" event): hand the commands
     * to it directly. Emitting "register-command" from inside that event makes
     * the open bar rebuild its list, fire the event again, and loop forever.
     */
    registerCommands(add = null) {
      if (!add && typeof ui.emit != "function") {
        return;
      }
      let showPanel = () => this.open({ animate: false, focusFirst: true });
      // Offer only the switch that changes something for the current page.
      let site = () => {
        let s = this.computeState();
        return s.canHandle ? (s.paused ? "paused" : "on") : "none";
      };
      let cmds = [
        {
          id: "privacy.site-off",
          label: "Turn protection off for this site",
          icon: "pause",
          hint: "Privacy",
          when: () => site() == "on",
          run: () => this.setSiteBlocking(false),
        },
        {
          id: "privacy.site-on",
          label: "Turn protection on for this site",
          icon: "shield",
          hint: "Privacy",
          when: () => site() == "paused",
          run: () => this.setSiteBlocking(true),
        },
        {
          id: "privacy.report-broken-site",
          label: "Report broken site",
          icon: "warning",
          hint: "Privacy",
          run: () => this.reportBrokenSite(),
        },
        {
          id: "privacy.fp-balanced",
          label: "Fingerprint protection: Balanced",
          icon: "shield",
          hint: "Privacy",
          when: () => chosenFpMode() != "balanced",
          run: () => {
            this.setFpMode("balanced");
            showPanel();
          },
        },
        {
          id: "privacy.fp-uniform",
          label: "Fingerprint protection: Uniform",
          icon: "shield",
          hint: "Privacy",
          when: () => chosenFpMode() != "uniform",
          run: () => {
            this.setFpMode("uniform");
            showPanel();
          },
        },
        {
          id: "privacy.report",
          label: "Privacy report",
          icon: "shield",
          hint: "Privacy",
          run: () => this.openReport(),
        },
        {
          id: "privacy.panel",
          label: "Show privacy panel",
          icon: "shield",
          hint: "Privacy",
          run: showPanel,
        },
        {
          id: "privacy.connection",
          label: "Connection details",
          icon: "lock",
          hint: "Privacy",
          run: () => this.openConnectionDetails(),
        },
      ];
      for (let c of cmds) {
        if (add) {
          add(c);
        } else {
          ui.emit("register-command", c);
        }
      }
    }
  }

  let instance = null;
  ui.register(NAME, {
    init(win) {
      instance = new PrivacyUI(win || window);
      instance.init();
      window.AmayaPrivacy = instance;
    },
    uninit() {
      instance?.uninit();
      instance = null;
      delete window.AmayaPrivacy;
    },
  });
})();
