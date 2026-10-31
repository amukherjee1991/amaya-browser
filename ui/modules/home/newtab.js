/* Amaya new tab page script.  Unprivileged; reads the JSON that home.js wrote
 * into the page and renders it.  Talks back to the browser only by changing
 * its own URL fragment (#amaya-pin=..., #amaya-remove=...), which home.js
 * watches with a tabs progress listener.  No storage, no network. */
"use strict";

(function () {
  const $ = id => document.getElementById(id);

  let data = {};
  try {
    data = JSON.parse($("amaya-home-data").textContent) || {};
  } catch (e) {
    // Template opened directly (not generated): render with defaults.
  }
  const show = Object.assign({ sites: true, tally: true }, data.show);

  /* Ask the browser to do something (see home.js, "commands from the page"). */
  function command(name, value) {
    location.replace("#amaya-" + name + "=" + encodeURIComponent(value));
  }

  /* ---- Theme -------------------------------------------------------------
   * The browser tells us its real theme: under Uniform fingerprint
   * protection, content always sees prefers-color-scheme: light. */
  if (data.theme === "dark" || data.theme === "light") {
    document.documentElement.dataset.theme = data.theme;
  }

  /* ---- Greeting ---------------------------------------------------------
   * Local hour from the browser's real UTC offset (Uniform mode reports UTC
   * to pages, which would greet you at the wrong time of day). */
  function localHour() {
    const now = new Date();
    if (typeof data.tzOffset === "number") {
      const mins = now.getUTCHours() * 60 + now.getUTCMinutes() - data.tzOffset;
      return Math.floor((((mins % 1440) + 1440) % 1440) / 60);
    }
    return now.getHours();
  }
  function greet() {
    const h = localHour();
    $("amaya-nt-greeting").textContent =
      h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening";
  }
  greet();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      greet();
    }
  });

  /* ---- Search -----------------------------------------------------------
   * One field, the default engine, no suggestions: nothing is sent until
   * you press Enter. */
  const search = data.search || null;
  const q = $("amaya-nt-q");
  if (search && search.name) {
    q.placeholder = `Search with ${search.name} or enter address`;
    q.setAttribute("aria-label", q.placeholder);
  }
  if (data.cmdKey) {
    $("amaya-nt-kbd").textContent = data.cmdKey;
    $("amaya-nt-kbd").hidden = false;
  }

  function toURL(text) {
    const t = text.trim();
    if (!t) {
      return null;
    }
    if (/^https?:\/\/\S+$/i.test(t)) {
      return t;
    }
    if (/\s/.test(t)) {
      return null;
    }
    if (/^(localhost|\[[0-9a-f:]+\]|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(t) ||
        /^[^\s/:?#]+\.[a-z][a-z0-9-]{1,62}(:\d+)?([/?#].*)?$/i.test(t)) {
      return "https://" + t;
    }
    return null;
  }

  $("amaya-nt-search").addEventListener("submit", e => {
    e.preventDefault();
    const text = q.value.trim();
    if (!text) {
      return;
    }
    let url = toURL(text);
    if (!url && search && search.template) {
      url = search.template.replace("{searchTerms}", encodeURIComponent(text).replace(/%20/g, "+"));
    }
    if (url) {
      location.href = url;
    } else {
      // Engine needs a POST request, or no engine data: let the browser search.
      command("search", text);
    }
  });

  /* ---- Sites ------------------------------------------------------------ */
  const sitesWrap = $("amaya-nt-sites-wrap");
  const list = $("amaya-nt-sites");
  const sites = Array.isArray(data.sites) ? data.sites : [];

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) {
      n.className = cls;
    }
    if (text != null) {
      n.textContent = text;
    }
    return n;
  }

  function tile(site) {
    const li = el("li", "amaya-nt-site");
    const a = el("a", "amaya-nt-tile");
    a.href = site.url;
    const fav = el("span", "amaya-nt-fav");
    if (site.icon && site.icon.startsWith("data:image/")) {
      const img = el("img");
      img.src = site.icon;
      img.alt = "";
      fav.append(img);
    } else {
      fav.textContent = (site.label || "?").charAt(0).toUpperCase();
    }
    a.append(fav, el("span", "amaya-nt-label", site.label));
    a.title = site.title || site.url;
    const x = el("button", "amaya-nt-x");
    x.type = "button";
    x.setAttribute("aria-label", `Remove ${site.label}`);
    x.innerHTML = '<svg class="amaya-nt-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener("click", () => command("remove", site.url));
    li.append(a, x);
    return li;
  }

  const addForm = $("amaya-nt-add");
  function addTile() {
    const li = el("li", "amaya-nt-site");
    const b = el("button", "amaya-nt-tile amaya-nt-tile--add");
    b.type = "button";
    const fav = el("span", "amaya-nt-fav");
    fav.innerHTML = '<svg class="amaya-nt-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
    b.append(fav, el("span", "amaya-nt-label", "Add site"));
    b.addEventListener("click", () => {
      list.hidden = true;
      $("amaya-nt-empty").hidden = true;
      addForm.hidden = false;
      $("amaya-nt-add-url").focus();
    });
    li.append(b);
    return li;
  }

  function closeAdd() {
    addForm.hidden = true;
    addForm.reset();
    list.hidden = false;
    $("amaya-nt-empty").hidden = sites.length > 0;
    list.querySelector(".amaya-nt-tile--add")?.focus();
  }
  $("amaya-nt-add-cancel").addEventListener("click", closeAdd);
  addForm.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAdd();
    }
  });
  addForm.addEventListener("submit", e => {
    e.preventDefault();
    const url = toURL($("amaya-nt-add-url").value);
    if (!url) {
      $("amaya-nt-add-url").setCustomValidity("Enter a web address, such as example.org");
      $("amaya-nt-add-url").reportValidity();
      return;
    }
    const name = $("amaya-nt-add-name").value.trim();
    command("pin", JSON.stringify({ url, title: name }));
  });
  $("amaya-nt-add-url").addEventListener("input", e => e.target.setCustomValidity(""));

  if (show.sites) {
    for (const s of sites.slice(0, 7)) {
      list.append(tile(s));
    }
    list.append(addTile());
    $("amaya-nt-empty").hidden = sites.length > 0;
  } else {
    sitesWrap.hidden = true;
  }

  /* ---- Weekly tally ----------------------------------------------------- */
  if (show.tally && typeof data.tally === "number") {
    const n = data.tally;
    let fmt = String(n);
    try {
      fmt = new Intl.NumberFormat(data.locale || undefined).format(n);
    } catch (e) {}
    $("amaya-nt-tally-text").textContent =
      n === 0 ? "No trackers blocked this week" :
      n === 1 ? "1 tracker blocked this week" :
      `${fmt} trackers blocked this week`;
    $("amaya-nt-tally").hidden = false;
  }
})();
