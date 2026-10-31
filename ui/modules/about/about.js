/* Amaya about module: the "About Amaya" card.  Owns ui/modules/about/.
 *
 * Firefox's own About dialog and `--version` only know the Gecko version.
 * This card shows the Amaya release from <ui dir>/version.json (written by
 * `tools/amaya stage`; missing in a development run, which shows
 * "Development build"), the Gecko version, build date and platform, the
 * update status (checks and updates are handed to the update module through
 * AmayaUI.update) and a few links.
 *
 * Entry points:
 *   - window.openAboutDialog (Help > About, the app menu's Help view) is
 *     replaced while the module is loaded and restored in uninit.
 *   - "About Amaya" in the command bar (actions).
 *   - "About Amaya" near the bottom of the app menu main view.
 *
 * AmayaUI.about = { open(), close(), isOpen, info(), versionText() } for tests.
 */
(function () {
  "use strict";

  const NAME = "about";
  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  const doc = document;
  const h = ui.h;
  const log = (...a) => ui.log(NAME, ...a);

  const REPO = "https://github.com/amukherjee1991/amaya-browser";
  const NOTES_URL = REPO + "/releases/tag/v";
  const VERSION_RE = /^\d+(?:\.\d+)*-\d+$/;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];

  /* ---------------------------------------------------------------- *
   * Version and build info
   * ---------------------------------------------------------------- */

  // Same approach as the update module: <ui dir>/version.json.
  let versionPromise = null;
  function amayaVersion() {
    versionPromise ||= (async () => {
      try {
        const dir = Services.io.newURI(ui.dirURL).QueryInterface(Ci.nsIFileURL).file.path;
        const data = await IOUtils.readJSON(PathUtils.join(dir, "version.json"));
        const v = String(data?.version ?? "").trim();
        return VERSION_RE.test(v) ? v : null;
      } catch (e) {
        return null; // development run
      }
    })();
    return versionPromise;
  }

  function buildDate(id) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(id || "");
    if (!m) {
      return null;
    }
    const month = MONTHS[Number(m[2]) - 1];
    return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
  }

  function platform() {
    const os = Services.appinfo.OS; // "Linux", "Darwin", "WINNT"
    const abi = String(Services.appinfo.XPCOMABI || "").split("-")[0]; // "x86_64"
    const osName = { Linux: "Linux", Darwin: "macOS", WINNT: "Windows" }[os] || os;
    const bits = /64/.test(abi) ? "64-bit" : abi ? "32-bit" : "";
    return { osName, abi, label: [bits, osName].filter(Boolean).join(" ") };
  }

  async function info() {
    const version = await amayaVersion();
    const p = platform();
    return {
      version,
      gecko: Services.appinfo.version,
      buildID: Services.appinfo.appBuildID,
      built: buildDate(Services.appinfo.appBuildID),
      platform: p.label,
      os: p.osName,
      abi: p.abi,
    };
  }

  function versionText(i) {
    const rel = i.version ? `Amaya ${i.version}` : "Amaya (development build)";
    const plat = [i.os, i.abi].filter(Boolean).join(" ");
    return `${rel} (Gecko ${i.gecko}, build ${i.buildID}${plat ? ", " + plat : ""})`;
  }

  /* ---------------------------------------------------------------- *
   * The card
   * ---------------------------------------------------------------- */

  let host = null; // scrim + card while open
  let returnFocus = null;
  let lastCopied = null;
  let updateView = { kind: "idle" }; // idle | checking | latest | available | message
  let current = null; // info() of the open card

  function openLink(url) {
    close();
    window.openTrustedLinkIn(url, "tab", {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }

  function button(label, kind, run, extra = {}) {
    return h("button", {
      type: "button",
      class: ["amaya-about__btn", kind && `amaya-about__btn--${kind}`],
      onclick: run,
      ...extra,
    }, label);
  }

  function updateFromModule() {
    // The update module loads after us, so look it up lazily.
    const s = ui.update?.state;
    if (s?.available && current?.version) {
      updateView = { kind: "available", version: s.available };
    }
  }

  async function checkForUpdates() {
    if (!ui.update) {
      updateView = { kind: "message", text: "Couldn't check for updates. Try again later." };
      renderUpdate();
      return;
    }
    updateView = { kind: "checking" };
    renderUpdate();
    let r;
    try {
      r = await ui.update.check();
    } catch (e) {
      log(`check: ${e}`);
    }
    const res = r?.result;
    if (res === "available") {
      updateView = { kind: "available", version: r.version };
    } else if (res === "latest") {
      updateView = { kind: "latest" };
    } else if (res === "offline") {
      updateView = { kind: "message", text: "You're offline. Check again when you're connected." };
    } else if (res === "busy") {
      updateView = { kind: "message", text: "Already checking. Try again in a moment." };
    } else {
      updateView = { kind: "message", text: "Couldn't check for updates. Try again later." };
    }
    renderUpdate();
  }

  function startUpdate() {
    // The update module shows download progress in the sidebar.
    close();
    ui.update?.update()?.catch?.(e => log(`update: ${e}`));
  }

  function renderUpdate() {
    const row = host?.querySelector(".amaya-about__update");
    if (!row) {
      return;
    }
    const text = h("p", { class: "amaya-about__update-text", role: "status" });
    const actions = [];
    if (!current?.version) {
      text.textContent = "Development builds don't check for updates.";
    } else if (updateView.kind === "checking") {
      text.textContent = "Checking for updates…";
    } else if (updateView.kind === "latest") {
      text.textContent = "You're on the latest version";
      actions.push(button("Check again", "quiet", checkForUpdates));
    } else if (updateView.kind === "available") {
      text.textContent = `Version ${updateView.version} is available`;
      actions.push(button("Update", "primary", startUpdate));
    } else if (updateView.kind === "message") {
      text.textContent = updateView.text;
      actions.push(button("Check again", "quiet", checkForUpdates));
    } else {
      text.textContent = "";
      actions.push(button("Check for updates", "quiet", checkForUpdates));
    }
    const hadFocus = row.contains(doc.activeElement);
    row.replaceChildren(...(text.textContent ? [text] : []), ...actions);
    if (hadFocus && !row.contains(doc.activeElement)) {
      (row.querySelector("button") || host.querySelector(".amaya-about__card")).focus();
    }
  }

  async function copyInfo(btn) {
    const text = versionText(current);
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
      lastCopied = text;
      btn.textContent = "Copied";
      setTimeout(() => {
        if (btn.isConnected) {
          btn.textContent = "Copy version info";
        }
      }, 2000);
    } catch (e) {
      log(`copy: ${e}`);
    }
  }

  function build(i) {
    const titleId = "amaya-about-title";
    const link = (label, url) =>
      h("li", null, h("a", {
        class: "amaya-about__link",
        href: url,
        onclick: e => {
          e.preventDefault();
          openLink(url);
        },
      }, label));

    const notes = i.version ? NOTES_URL + encodeURIComponent(i.version) : REPO + "/releases";
    const second = [`Gecko ${i.gecko}`, i.built && `built ${i.built}`, i.platform]
      .filter(Boolean).join(" · ");

    const closeBtn = h("button", {
      type: "button",
      class: "amaya-about__close",
      "aria-label": "Close",
      title: "Close",
      onclick: close,
    }, ui.icon("close"));

    const copyBtn = button("Copy version info", "quiet", e => copyInfo(e.currentTarget), {
      class: "amaya-about__btn amaya-about__btn--quiet amaya-about__copy",
    });

    const card = h("div", {
      class: "amaya-about__card",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": titleId,
      tabindex: "-1",
    },
      closeBtn,
      h("img", {
        class: "amaya-about__mark",
        src: ui.dirURL + "modules/about/amaya-mark.svg",
        alt: "",
        width: "56",
        height: "56",
      }),
      h("h1", { class: "amaya-about__title", id: titleId }, "Amaya"),
      h("p", { class: "amaya-about__version" },
        i.version ? `Version ${i.version}` : "Development build"),
      h("p", { class: "amaya-about__build" }, second),
      h("div", { class: "amaya-about__update" }),
      h("ul", { class: "amaya-about__links" },
        link("Release notes", notes),
        link("Privacy report", "about:protections"),
        link("Source code", REPO),
        link("Licence (MPL 2.0)", "about:license")),
      copyBtn,
      h("p", { class: "amaya-about__footer" },
        "Amaya is independent and not affiliated with Mozilla. Built on Gecko, the engine behind Firefox."));

    const scrim = h("div", { class: "amaya-about__scrim", onclick: close });
    return h("div", { id: "amaya-about", class: "amaya-about" }, scrim, card);
  }

  function focusables() {
    return [...host.querySelectorAll(".amaya-about__card :is(button, a[href])")]
      .filter(el => !el.disabled && el.getClientRects().length);
  }

  function onKey(e) {
    if (!host) {
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      const list = focusables();
      if (!list.length) {
        return;
      }
      const card = host.querySelector(".amaya-about__card");
      const at = list.indexOf(doc.activeElement);
      let next;
      if (e.shiftKey) {
        next = at <= 0 ? list[list.length - 1] : list[at - 1];
      } else {
        next = at < 0 || at === list.length - 1 ? list[0] : list[at + 1];
      }
      if (at < 0 && !card.contains(doc.activeElement) && !e.shiftKey) {
        next = list[0];
      }
      e.preventDefault();
      e.stopPropagation();
      next.focus();
    }
  }

  // Keep focus inside the card (clicks elsewhere in the chrome, a popup closing).
  function onFocusIn(e) {
    if (host && !host.contains(e.target)) {
      host.querySelector(".amaya-about__card")?.focus();
    }
  }

  let opening = null;
  async function open() {
    if (host) {
      host.querySelector(".amaya-about__card").focus();
      return;
    }
    if (opening) {
      return opening;
    }
    opening = (async () => {
      returnFocus = doc.activeElement;
      current = await info();
      if (updateView.kind === "idle" || updateView.kind === "message") {
        updateView = { kind: "idle" };
      }
      updateFromModule();
      host = build(current);
      (ui.overlayRoot || doc.body).append(host);
      renderUpdate();
      window.addEventListener("keydown", onKey, true);
      doc.addEventListener("focusin", onFocusIn, true);
      // Let the command bar (or a menu) finish closing before taking focus.
      await new Promise(r => setTimeout(r, 0));
      if (host) {
        host.querySelector(".amaya-about__card").focus();
      }
    })().finally(() => {
      opening = null;
    });
    return opening;
  }

  function close() {
    if (!host) {
      return;
    }
    window.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    host.remove();
    host = null;
    const back = returnFocus;
    returnFocus = null;
    try {
      if (back?.isConnected && back !== doc.body && back !== doc.documentElement) {
        back.focus();
      } else {
        gBrowser.selectedBrowser.focus();
      }
    } catch (e) {}
  }

  /* ---------------------------------------------------------------- *
   * Entry points
   * ---------------------------------------------------------------- */

  const command = {
    id: "about.open",
    label: "About Amaya",
    group: "actions",
    keywords: ["version", "about", "build", "licence", "license"],
    run: () => {
      open();
    },
  };

  let savedOpenAbout = null;
  let savedAboutLabel = null;
  let menuItem = null;

  // A top-level "About Amaya" item in the app menu, above Quit (or at the end).
  function onViewShowing(e) {
    if (e.target?.id !== "appMenu-mainView" || menuItem?.isConnected) {
      return;
    }
    const view = e.target;
    const body = view.querySelector(".panel-subview-body") || view;
    menuItem = doc.createXULElement("toolbarbutton");
    menuItem.id = "amaya-appMenu-about";
    menuItem.className = "subviewbutton";
    menuItem.setAttribute("label", "About Amaya");
    menuItem.addEventListener("command", () => {
      try {
        PanelUI.hide();
      } catch (err) {}
      open();
    });
    const quit = body.querySelector("#appMenu-quit-button2");
    const sep = quit?.previousElementSibling?.localName === "toolbarseparator"
      ? quit.previousElementSibling : null;
    if (sep) {
      body.insertBefore(menuItem, sep);
    } else if (quit) {
      body.insertBefore(menuItem, quit);
    } else {
      body.append(menuItem);
    }
  }

  ui.register(NAME, {
    init() {
      if (typeof window.openAboutDialog === "function") {
        savedOpenAbout = window.openAboutDialog;
      }
      window.openAboutDialog = () => {
        open();
      };

      const help = doc.getElementById("aboutName");
      if (help && help.getAttribute("label") !== "About Amaya") {
        savedAboutLabel = {
          label: help.getAttribute("label"),
          l10n: help.getAttribute("data-l10n-id"),
          args: help.getAttribute("data-l10n-args"),
        };
        help.removeAttribute("data-l10n-id");
        help.removeAttribute("data-l10n-args");
        help.setAttribute("label", "About Amaya");
      }

      window.addEventListener("ViewShowing", onViewShowing, true);
      (ui.commands ||= []).push(command);
    },

    uninit() {
      close();
      if (savedOpenAbout) {
        window.openAboutDialog = savedOpenAbout;
      } else {
        delete window.openAboutDialog;
      }
      const help = doc.getElementById("aboutName");
      if (help && savedAboutLabel) {
        if (savedAboutLabel.label != null) {
          help.setAttribute("label", savedAboutLabel.label);
        }
        if (savedAboutLabel.l10n) {
          help.setAttribute("data-l10n-id", savedAboutLabel.l10n);
        }
        if (savedAboutLabel.args) {
          help.setAttribute("data-l10n-args", savedAboutLabel.args);
        }
      }
      window.removeEventListener("ViewShowing", onViewShowing, true);
      menuItem?.remove();
      menuItem = null;
      if (ui.commands) {
        const i = ui.commands.indexOf(command);
        if (i >= 0) {
          ui.commands.splice(i, 1);
        }
      }
      ui.emit("unregister-command", { id: command.id });
      delete ui.about;
    },
  });

  ui.about = {
    open: () => open(),
    close: () => close(),
    get isOpen() {
      return !!host;
    },
    info: () => info(),
    versionText: async () => versionText(await info()),
    get lastCopied() {
      return lastCopied;
    },
  };
})();
