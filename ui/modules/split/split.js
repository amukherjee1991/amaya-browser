/* Amaya split view: up to four panes in a grid.
 *
 * Built on Firefox's native split view (<tab-split-view-wrapper>,
 * gBrowser.addTabSplitView, tabpanels' split-view panels and session restore
 * of splitViewId). The native implementation lays out two panels with a
 * flexbox and one splitter. This module keeps the native data model and
 * activation logic and replaces only the layout: #tabbrowser-tabpanels
 * becomes a CSS grid (columns, rows, or 2 by 2), each pane gets a 28px header,
 * and gutters drawn over the gaps resize the tracks.
 *
 * Runs in the browser window scope (loaded by ui/loader.js).
 */
(function () {
  "use strict";

  const NAME = "split";
  const MAX_PANES = 4;
  const MIN_PANE_PX = 160;
  const STORE_LIMIT = 64;
  const LAYOUT_LABELS = {
    columns: "Side by side",
    rows: "Stacked",
    grid: "Grid",
  };
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const TAB_TYPE = "application/x-moz-tabbrowser-tab";

  const ui = window.AmayaUI;
  if (!ui) {
    return;
  }

  /** splitViewId -> { layout, cols: number[], rows: number[] } */
  let views = new Map();
  /** Ids un-split in this window, dropped from the store on the next save. */
  let removedIds = new Set();
  let store = null;
  let saveTimer = 0;

  let tabpanels = null;
  let layer = null; // container for gutters and drop zones
  let gutters = [];
  let dropOverlay = null;
  let draggedTab = null;
  /** Tab the user was looking at before the drag selected the dragged tab. */
  let dragRestoreTab = null;
  let prevSelected = null;
  let resizeObserver = null;
  let styledPanels = new Set();
  let applyQueued = false;
  let progressListener = null;
  let cleanups = [];

  // ---------------------------------------------------------------- helpers

  function el(tag, attrs, ...kids) {
    if (ui.h) {
      return ui.h(tag, attrs, ...kids);
    }
    const e = document.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") {
        e.className = v;
      } else if (v != null && v !== false) {
        e.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const c of kids.flat()) {
      if (c != null) {
        e.append(c);
      }
    }
    return e;
  }

  function icon(name) {
    try {
      const i = ui.icon && ui.icon(name);
      if (i) {
        return i;
      }
    } catch (e) {}
    return el("span", { class: "amaya-split-ico-fallback", "aria-hidden": "true" });
  }

  function log(...args) {
    if (ui.log) {
      ui.log(NAME, ...args);
    }
  }

  function listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function on(type, fn) {
    // The loader's `on` hands listeners the CustomEvent.
    const off = ui.on(type, e => fn(e && e.detail));
    if (typeof off === "function") {
      cleanups.push(off);
    }
  }

  function panelOf(tab) {
    return tab && tab.linkedPanel ? document.getElementById(tab.linkedPanel) : null;
  }

  function isSplittable(tab) {
    return (
      tab &&
      tab.isConnected &&
      !tab.closing &&
      !tab.pinned &&
      !tab.hidden &&
      !tab.hasAttribute("customizemode")
    );
  }

  // ---------------------------------------------------------- layout model

  /**
   * Grid geometry for `n` panes in `layout`.
   * Returns { cols, rows, areas: [[rowStart, colStart, rowEnd, colEnd], ...] }.
   */
  function geometry(n, layout) {
    if (n <= 1) {
      return { cols: 1, rows: 1, areas: [[1, 1, 2, 2]] };
    }
    if (layout === "rows") {
      return {
        cols: 1,
        rows: n,
        areas: Array.from({ length: n }, (_, i) => [i + 1, 1, i + 2, 2]),
      };
    }
    if (layout === "grid" && n >= 3) {
      if (n === 3) {
        // First pane spans the left column; two panes stack on the right.
        return {
          cols: 2,
          rows: 2,
          areas: [
            [1, 1, 3, 2],
            [1, 2, 2, 3],
            [2, 2, 3, 3],
          ],
        };
      }
      return {
        cols: 2,
        rows: 2,
        areas: [
          [1, 1, 2, 2],
          [1, 2, 2, 3],
          [2, 1, 3, 2],
          [2, 2, 3, 3],
        ],
      };
    }
    return {
      cols: n,
      rows: 1,
      areas: Array.from({ length: n }, (_, i) => [1, i + 1, 2, i + 2]),
    };
  }

  function defaultLayout(n) {
    return n >= 3 ? "grid" : "columns";
  }

  function layoutsFor(n) {
    return n >= 3 ? ["columns", "rows", "grid"] : ["columns", "rows"];
  }

  function stateFor(sv) {
    const id = sv.splitViewId;
    let st = views.get(id);
    if (!st) {
      // `auto`: follow the pane count (2 side by side, 3+ as a grid) until
      // the user picks a layout.
      st = { layout: defaultLayout(sv.tabs.length), auto: true, cols: [], rows: [] };
      views.set(id, st);
    }
    return st;
  }

  function normalize(st, n) {
    if (st.auto && st.layout !== defaultLayout(n)) {
      st.layout = defaultLayout(n);
      st.cols = [];
      st.rows = [];
    }
    if (!layoutsFor(n).includes(st.layout)) {
      st.layout = defaultLayout(n);
    }
    const g = geometry(n, st.layout);
    if (st.cols.length !== g.cols || st.cols.some(f => !(f > 0))) {
      st.cols = new Array(g.cols).fill(1);
    }
    if (st.rows.length !== g.rows || st.rows.some(f => !(f > 0))) {
      st.rows = new Array(g.rows).fill(1);
    }
    return g;
  }

  // ------------------------------------------------------------ persistence

  async function loadStore() {
    if (!ui.store) {
      return;
    }
    try {
      store = ui.store(NAME);
      const data = (await store.read()) || {};
      for (const [id, st] of Object.entries(data.views || {})) {
        if (
          st &&
          typeof st.layout === "string" &&
          Array.isArray(st.cols) &&
          Array.isArray(st.rows)
        ) {
          // Keep layouts this window already changed; replace defaults.
          if (!views.has(+id) || views.get(+id).auto) {
            views.set(+id, {
              layout: st.layout,
              auto: !!st.auto,
              cols: st.cols.map(Number),
              rows: st.rows.map(Number),
            });
          }
        }
      }
      scheduleApply();
    } catch (e) {
      log("could not read layout store", e);
    }
  }

  function save() {
    if (!store) {
      return;
    }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const existing = (await store.read()) || {};
        const merged = Object.assign({}, existing.views || {});
        for (const id of removedIds) {
          if (!views.has(id)) {
            delete merged[id];
          }
        }
        removedIds.clear();
        for (const [id, st] of views) {
          delete merged[id];
          merged[id] = st;
        }
        const ids = Object.keys(merged);
        for (const id of ids.slice(0, Math.max(0, ids.length - STORE_LIMIT))) {
          delete merged[id];
        }
        await store.write({ version: 1, views: merged });
      } catch (e) {
        log("could not save layout", e);
      }
    }, 500);
  }

  // ------------------------------------------------------------ apply layout

  function scheduleApply() {
    if (applyQueued) {
      return;
    }
    applyQueued = true;
    Promise.resolve().then(() => {
      applyQueued = false;
      apply();
    });
  }

  function clearPanel(panel) {
    panel.style.removeProperty("grid-area");
    panel.removeAttribute("amaya-pane-index");
    styledPanels.delete(panel);
  }

  function apply() {
    if (!tabpanels) {
      return;
    }
    markSidebar();
    const sv = gBrowser.activeSplitView;
    const tabs = sv ? sv.tabs.filter(t => !t.closing) : [];
    const keep = new Set();

    if (!sv || tabs.length < 2) {
      tabpanels.removeAttribute("amaya-split");
      tabpanels.style.removeProperty("--amaya-split-cols");
      tabpanels.style.removeProperty("--amaya-split-rows");
      for (const p of [...styledPanels]) {
        clearPanel(p);
      }
      updateGutters(null);
      return;
    }

    const st = stateFor(sv);
    const g = normalize(st, tabs.length);
    tabpanels.setAttribute("amaya-split", st.layout);
    tabpanels.setAttribute("amaya-panes", String(tabs.length));
    tabpanels.style.setProperty(
      "--amaya-split-cols",
      st.cols.map(f => `minmax(0, ${f}fr)`).join(" ")
    );
    tabpanels.style.setProperty(
      "--amaya-split-rows",
      st.rows.map(f => `minmax(0, ${f}fr)`).join(" ")
    );

    tabs.forEach((tab, i) => {
      const panel = panelOf(tab);
      if (!panel) {
        return;
      }
      const [r0, c0, r1, c1] = g.areas[i];
      panel.style.setProperty("grid-area", `${r0} / ${c0} / ${r1} / ${c1}`);
      panel.setAttribute("amaya-pane-index", String(i));
      // The native split keeps custom widths from its own splitter; the grid
      // owns sizing now.
      panel.removeAttribute("width");
      panel.style.removeProperty("width");
      styledPanels.add(panel);
      keep.add(panel);
      ensureHeader(tab, panel, i, tabs.length);
    });
    for (const p of [...styledPanels]) {
      if (!keep.has(p)) {
        clearPanel(p);
      }
    }
    updateGutters({ sv, st, g, tabs });
  }

  // ----------------------------------------------------------- pane headers

  function ensureHeader(tab, panel, index, count) {
    const container = panel.querySelector(".browserContainer");
    if (!container) {
      return;
    }
    let bar = container.querySelector(":scope > .amaya-pane-bar");
    if (!bar) {
      bar = el(
        "div",
        { class: "amaya-pane-bar", role: "toolbar" },
        el(
          "button",
          { class: "amaya-pane-btn amaya-pane-back", type: "button", "aria-label": "Back", title: "Back" },
          icon("back")
        ),
        el(
          "button",
          { class: "amaya-pane-btn amaya-pane-forward", type: "button", "aria-label": "Forward", title: "Forward" },
          icon("forward")
        ),
        el(
          "button",
          { class: "amaya-pane-title", type: "button" },
          el("span", { class: "amaya-pane-fav", "aria-hidden": "true" }),
          el("span", { class: "amaya-pane-label" })
        )
      );
      bar.addEventListener("click", onHeaderClick);
      bar.addEventListener("dblclick", e => e.stopPropagation());
      container.prepend(bar);
    }
    updateHeader(tab, bar, index, count);
  }

  function onHeaderClick(event) {
    const panel = event.currentTarget.closest(".browserSidebarContainer");
    const tab = panel && gBrowser.getTabForBrowser(panel.querySelector("browser"));
    if (!tab) {
      return;
    }
    const btn = event.target.closest("button");
    const browser = tab.linkedBrowser;
    if (btn?.classList.contains("amaya-pane-back")) {
      if (browser.canGoBack) {
        browser.goBack();
      }
    } else if (btn?.classList.contains("amaya-pane-forward")) {
      if (browser.canGoForward) {
        browser.goForward();
      }
    }
    if (gBrowser.selectedTab !== tab) {
      gBrowser.selectedTab = tab;
    }
    if (btn?.classList.contains("amaya-pane-title")) {
      browser.focus();
    }
  }

  function updateHeader(tab, bar, index, count) {
    const browser = tab.linkedBrowser;
    const label = tab.label || tab.getAttribute("label") || "";
    let url = "";
    try {
      url = browser.currentURI.displaySpec;
    } catch (e) {}
    const active = tab.selected;
    bar.toggleAttribute("active", active);
    if (index !== undefined) {
      bar.setAttribute(
        "aria-label",
        `Pane ${index + 1} of ${count}${active ? ", active" : ""}: ${label}`
      );
    }
    bar.querySelector(".amaya-pane-label").textContent = label;
    const title = bar.querySelector(".amaya-pane-title");
    title.setAttribute("title", url ? `${label}\n${url}` : label);
    title.setAttribute("aria-label", `Focus pane: ${label}`);
    const fav = bar.querySelector(".amaya-pane-fav");
    const image = tab.getAttribute("image");
    if (image) {
      let img = fav.querySelector("img");
      if (!img) {
        fav.textContent = "";
        img = el("img", { alt: "" });
        fav.append(img);
      }
      if (img.getAttribute("src") !== image) {
        img.setAttribute("src", image);
      }
      fav.removeAttribute("letter");
    } else {
      fav.textContent = (label.trim()[0] || "·").toUpperCase();
      fav.setAttribute("letter", "");
    }
    const back = bar.querySelector(".amaya-pane-back");
    const fwd = bar.querySelector(".amaya-pane-forward");
    back.disabled = !browser?.canGoBack;
    fwd.disabled = !browser?.canGoForward;
  }

  function refreshHeaderFor(tab) {
    const panel = panelOf(tab);
    const bar = panel?.querySelector(".browserContainer > .amaya-pane-bar");
    if (bar && tab.splitview) {
      const tabs = tab.splitview.tabs;
      updateHeader(tab, bar, tabs.indexOf(tab), tabs.length);
    }
  }

  function removeHeaders() {
    for (const bar of document.querySelectorAll(".amaya-pane-bar")) {
      bar.remove();
    }
  }

  // ---------------------------------------------------------------- gutters

  function ensureLayer() {
    if (layer) {
      return layer;
    }
    const root = ui.overlayRoot;
    layer = el("div", { id: "amaya-split-layer" });
    if (root) {
      root.append(layer);
    } else {
      layer.setAttribute("standalone", "");
      document.body.append(layer);
    }
    return layer;
  }

  function contentBox() {
    const r = tabpanels.getBoundingClientRect();
    const cs = getComputedStyle(tabpanels);
    const pl = parseFloat(cs.paddingLeft) || 0;
    const pr = parseFloat(cs.paddingRight) || 0;
    const pt = parseFloat(cs.paddingTop) || 0;
    const pb = parseFloat(cs.paddingBottom) || 0;
    const gap = parseFloat(cs.columnGap) || 0;
    const rgap = parseFloat(cs.rowGap) || gap;
    return {
      left: r.left + pl,
      top: r.top + pt,
      width: r.width - pl - pr,
      height: r.height - pt - pb,
      gap,
      rgap,
    };
  }

  function updateGutters(ctx) {
    for (const g of gutters) {
      g.remove();
    }
    gutters = [];
    if (!ctx) {
      return;
    }
    ensureLayer();
    const { st, g, tabs } = ctx;
    for (let i = 0; i < g.cols - 1; i++) {
      gutters.push(makeGutter("col", i, st));
    }
    for (let i = 0; i < g.rows - 1; i++) {
      gutters.push(makeGutter("row", i, st, g, tabs));
    }
    for (const gu of gutters) {
      layer.append(gu);
    }
    positionGutters();
  }

  function makeGutter(axis, index, st) {
    const gu = el("div", {
      class: "amaya-split-gutter",
      axis,
      role: "separator",
      tabindex: "0",
      "aria-orientation": axis === "col" ? "vertical" : "horizontal",
      "aria-label": axis === "col" ? "Resize panes side to side" : "Resize panes up and down",
      title: "Drag to resize. Double-click to reset.",
    });
    gu._axis = axis;
    gu._index = index;
    gu.addEventListener("pointerdown", onGutterDown);
    gu.addEventListener("dblclick", () => resetSizes(axis));
    gu.addEventListener("keydown", onGutterKey);
    updateGutterAria(gu, st);
    return gu;
  }

  function updateGutterAria(gu, st) {
    const arr = gu._axis === "col" ? st.cols : st.rows;
    const total = arr.reduce((a, b) => a + b, 0);
    const before = arr.slice(0, gu._index + 1).reduce((a, b) => a + b, 0);
    gu.setAttribute("aria-valuemin", "0");
    gu.setAttribute("aria-valuemax", "100");
    gu.setAttribute("aria-valuenow", String(Math.round((before / total) * 100)));
  }

  function positionGutters() {
    const sv = gBrowser.activeSplitView;
    if (!gutters.length || !sv) {
      return;
    }
    const tabs = sv.tabs;
    const rects = tabs.map(t => panelOf(t)?.getBoundingClientRect()).filter(Boolean);
    if (!rects.length) {
      return;
    }
    const box = contentBox();
    const st = stateFor(sv);
    const g = geometry(tabs.length, st.layout);
    const HIT = 12;
    for (const gu of gutters) {
      const i = gu._index;
      if (gu._axis === "col") {
        // Boundary after column i: right edge of panels ending at column i+2.
        const leftEdges = [];
        const rightEdges = [];
        g.areas.forEach((a, k) => {
          if (!rects[k]) {
            return;
          }
          if (a[3] === i + 2) {
            rightEdges.push(rects[k].right);
          }
          if (a[1] === i + 2) {
            leftEdges.push(rects[k].left);
          }
        });
        const x =
          rightEdges.length && leftEdges.length
            ? (Math.max(...rightEdges) + Math.min(...leftEdges)) / 2
            : box.left;
        Object.assign(gu.style, {
          left: `${x - HIT / 2}px`,
          top: `${box.top}px`,
          width: `${HIT}px`,
          height: `${box.height}px`,
        });
      } else {
        const tops = [];
        const bottoms = [];
        let minX = Infinity;
        let maxX = -Infinity;
        g.areas.forEach((a, k) => {
          if (!rects[k]) {
            return;
          }
          if (a[2] === i + 2) {
            bottoms.push(rects[k].bottom);
            minX = Math.min(minX, rects[k].left);
            maxX = Math.max(maxX, rects[k].right);
          }
          if (a[0] === i + 2) {
            tops.push(rects[k].top);
          }
        });
        const y =
          bottoms.length && tops.length
            ? (Math.max(...bottoms) + Math.min(...tops)) / 2
            : box.top;
        Object.assign(gu.style, {
          left: `${isFinite(minX) ? minX : box.left}px`,
          top: `${y - HIT / 2}px`,
          width: `${isFinite(maxX) ? maxX - minX : box.width}px`,
          height: `${HIT}px`,
        });
      }
    }
  }

  function resizeTrack(axis, index, pointerPos) {
    const sv = gBrowser.activeSplitView;
    if (!sv) {
      return;
    }
    const st = stateFor(sv);
    const arr = axis === "col" ? st.cols : st.rows;
    const box = contentBox();
    const gap = axis === "col" ? box.gap : box.rgap;
    const start = axis === "col" ? box.left : box.top;
    const size = (axis === "col" ? box.width : box.height) - gap * (arr.length - 1);
    if (size <= 0) {
      return;
    }
    const total = arr.reduce((a, b) => a + b, 0);
    const pxPer = size / total;
    // Pixel start of track `index`.
    let trackStart = start;
    for (let k = 0; k < index; k++) {
      trackStart += arr[k] * pxPer + gap;
    }
    const pairPx = (arr[index] + arr[index + 1]) * pxPer;
    let firstPx = pointerPos - trackStart - gap / 2;
    const min = Math.min(MIN_PANE_PX, pairPx / 2);
    firstPx = Math.max(min, Math.min(pairPx - min, firstPx));
    const pair = arr[index] + arr[index + 1];
    arr[index] = (firstPx / pairPx) * pair;
    arr[index + 1] = pair - arr[index];
    applySizes(st);
  }

  function applySizes(st) {
    tabpanels.style.setProperty(
      "--amaya-split-cols",
      st.cols.map(f => `minmax(0, ${f}fr)`).join(" ")
    );
    tabpanels.style.setProperty(
      "--amaya-split-rows",
      st.rows.map(f => `minmax(0, ${f}fr)`).join(" ")
    );
    for (const gu of gutters) {
      updateGutterAria(gu, st);
    }
    // Layout flushes on the next read; keep gutters on the gaps.
    positionGutters();
    save();
  }

  function resetSizes(axis) {
    const sv = gBrowser.activeSplitView;
    if (!sv) {
      return;
    }
    const st = stateFor(sv);
    if (!axis || axis === "col") {
      st.cols = st.cols.map(() => 1);
    }
    if (!axis || axis === "row") {
      st.rows = st.rows.map(() => 1);
    }
    applySizes(st);
  }

  function onGutterDown(event) {
    if (event.button !== 0) {
      return;
    }
    const gu = event.currentTarget;
    event.preventDefault();
    gu.setPointerCapture(event.pointerId);
    gu.setAttribute("dragging", "");
    tabpanels.setAttribute("amaya-split-resizing", "");
    const move = e => {
      resizeTrack(gu._axis, gu._index, gu._axis === "col" ? e.clientX : e.clientY);
    };
    const up = () => {
      gu.removeEventListener("pointermove", move);
      gu.removeEventListener("pointerup", up);
      gu.removeEventListener("lostpointercapture", up);
      gu.removeAttribute("dragging");
      tabpanels.removeAttribute("amaya-split-resizing");
    };
    gu.addEventListener("pointermove", move);
    gu.addEventListener("pointerup", up);
    gu.addEventListener("lostpointercapture", up);
  }

  function onGutterKey(event) {
    const gu = event.currentTarget;
    const horiz = gu._axis === "col";
    const keys = horiz ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (event.key === "Enter" || event.key === "Home") {
      event.preventDefault();
      resetSizes(gu._axis);
      return;
    }
    const dir = keys.indexOf(event.key);
    if (dir === -1 || event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    event.preventDefault();
    const r = gu.getBoundingClientRect();
    const center = horiz ? r.left + r.width / 2 : r.top + r.height / 2;
    const step = event.shiftKey ? 64 : 16;
    resizeTrack(gu._axis, gu._index, center + (dir ? step : -step));
  }

  // --------------------------------------------------- create / un-split

  /**
   * Put `tabs` in one split. If the first tab is already in a split, the
   * others join it. Tabs beyond four stay normal tabs.
   */
  function splitTabs(tabs, { select = null, layout = null } = {}) {
    tabs = [...new Set(tabs.filter(isSplittable))];
    if (!tabs.length) {
      return null;
    }
    const existing = tabs.find(t => t.splitview)?.splitview;
    let sv = existing;
    if (sv) {
      const room = MAX_PANES - sv.tabs.length;
      const add = tabs.filter(t => !t.splitview).slice(0, Math.max(0, room));
      if (add.length) {
        sv.addTabs(add);
      }
    } else {
      const chosen = tabs.slice(0, MAX_PANES);
      if (chosen.length < 2) {
        return null;
      }
      sv = gBrowser.addTabSplitView(chosen, { insertBefore: chosen[0] });
    }
    if (!sv) {
      return null;
    }
    if (layout && layout !== defaultLayout(sv.tabs.length)) {
      const st = stateFor(sv);
      st.layout = layout;
      st.auto = false;
      normalize(st, sv.tabs.length);
      save();
    }
    if (select && sv.tabs.includes(select)) {
      gBrowser.selectedTab = select;
    } else if (!sv.tabs.includes(gBrowser.selectedTab)) {
      gBrowser.selectedTab = sv.tabs[0];
    }
    scheduleApply();
    return sv;
  }

  function unsplit(sv) {
    sv = sv || gBrowser.activeSplitView || gBrowser.selectedTab.splitview;
    if (!sv) {
      return;
    }
    views.delete(sv.splitViewId);
    removedIds.add(sv.splitViewId);
    sv.unsplitTabs("menu_separate");
    save();
    scheduleApply();
  }

  function setLayout(layout, sv) {
    sv = sv || gBrowser.activeSplitView;
    if (!sv || !layoutsFor(sv.tabs.length).includes(layout)) {
      return;
    }
    const st = stateFor(sv);
    st.layout = layout;
    st.auto = false;
    st.cols = [];
    st.rows = [];
    normalize(st, sv.tabs.length);
    save();
    apply();
  }

  function recentOtherTab(exclude) {
    return gBrowser.visibleTabs
      .filter(t => isSplittable(t) && !t.splitview && !exclude.includes(t))
      .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }

  /** Command bar: "Split with current tab". */
  function splitWithCurrent() {
    const cur = gBrowser.selectedTab;
    if (!isSplittable(cur)) {
      return;
    }
    if (cur.splitview && cur.splitview.tabs.length >= MAX_PANES) {
      return;
    }
    const other = recentOtherTab(cur.splitview ? cur.splitview.tabs : [cur]);
    if (other) {
      splitTabs([cur, other], { select: cur });
    } else {
      splitWithNewTab(cur);
    }
  }

  /** Native picker: about:opentabs in a new pane lets you choose a tab. */
  function splitWithNewTab(tab) {
    tab = tab || gBrowser.selectedTab;
    if (!isSplittable(tab) || (tab.splitview && tab.splitview.tabs.length >= MAX_PANES)) {
      return;
    }
    const newTab = gBrowser.addTrustedTab("about:opentabs");
    splitTabs([tab, newTab], { select: newTab });
  }

  /** `amaya:split` from other modules: { tabs: [tab | url, ...], select? }. */
  function onSplitEvent(detail) {
    const items = (detail && detail.tabs) || [];
    const tabs = [];
    for (const item of items) {
      if (!item) {
        continue;
      }
      if (typeof item === "string" || item instanceof URL) {
        tabs.push(
          gBrowser.addTrustedTab(String(item), {
            userContextId: gBrowser.selectedTab.userContextId,
            inBackground: true,
          })
        );
      } else if (item.localName === "tab") {
        tabs.push(item);
      }
    }
    if (!tabs.length) {
      return;
    }
    if (tabs.length === 1 && tabs[0] !== gBrowser.selectedTab) {
      // One tab: split it with the current one.
      tabs.unshift(gBrowser.selectedTab);
    }
    const sv = splitTabs(tabs, { select: detail && detail.select });
    // Anything that did not fit (a fifth pane) opens as a normal tab.
    const extra = tabs.filter(t => isSplittable(t) && (!sv || !sv.tabs.includes(t)));
    if (extra.length && extra[0] !== gBrowser.selectedTab) {
      gBrowser.selectedTab = extra[0];
    }
  }

  // ------------------------------------------------------------ tab close

  function onTabClose(event) {
    const tab = event.target;
    const sv = tab.splitview;
    if (!sv || sv.tabs.length < 3) {
      return; // Native split handles 2 -> 1 by un-splitting.
    }
    const id = sv.splitViewId;
    const st = views.get(id);
    // The native wrapper keeps a private list of its tabs that is not updated
    // when one closes. Rebuild it from the remaining tabs once the tab is gone.
    setTimeout(() => {
      const remaining = sv.tabs.filter(t => t !== tab && !t.closing);
      const wasActive = remaining.includes(gBrowser.selectedTab);
      const selected = gBrowser.selectedTab;
      if (remaining.length < 2) {
        return;
      }
      if (st) {
        st.cols = [];
        st.rows = [];
      }
      sv.unsplitTabs();
      const nsv = gBrowser.addTabSplitView(remaining, { id, insertBefore: remaining[0] });
      if (nsv && st) {
        views.set(nsv.splitViewId, st);
      }
      if (wasActive) {
        gBrowser.selectedTab = selected;
      }
      scheduleApply();
    }, 0);
  }

  // ------------------------------------------------- keyboard: pane focus

  function onKeyDown(event) {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) {
      return;
    }
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[event.key];
    const sv = gBrowser.activeSplitView;
    if (!d || !sv) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusDirection(d[0], d[1]);
  }

  function focusDirection(dx, dy) {
    const sv = gBrowser.activeSplitView;
    if (!sv) {
      return false;
    }
    const cur = gBrowser.selectedTab;
    const cr = panelOf(cur)?.getBoundingClientRect();
    if (!cr) {
      return false;
    }
    const cx = cr.left + cr.width / 2;
    const cy = cr.top + cr.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const t of sv.tabs) {
      if (t === cur) {
        continue;
      }
      const r = panelOf(t)?.getBoundingClientRect();
      if (!r) {
        continue;
      }
      const ox = r.left + r.width / 2 - cx;
      const oy = r.top + r.height / 2 - cy;
      const along = dx ? ox * dx : oy * dy;
      if (along <= 1) {
        continue;
      }
      // Prefer panes that overlap on the cross axis.
      const overlap = dx
        ? Math.min(r.bottom, cr.bottom) - Math.max(r.top, cr.top)
        : Math.min(r.right, cr.right) - Math.max(r.left, cr.left);
      const cross = dx ? Math.abs(oy) : Math.abs(ox);
      const score = along + (overlap > 0 ? 0 : 10000) + cross * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) {
      return false;
    }
    gBrowser.selectedTab = best;
    best.linkedBrowser.focus();
    return true;
  }

  // --------------------------------------------- drag a tab to a pane edge

  function draggedTabFrom(event) {
    const dt = event.dataTransfer;
    if (!dt || !dt.types.includes(TAB_TYPE)) {
      return null;
    }
    try {
      const t = dt.mozGetDataAt(TAB_TYPE, 0);
      return t && t.localName === "tab" ? t : null;
    } catch (e) {
      return null;
    }
  }

  function onTabDragStart(event) {
    const tab = draggedTabFrom(event) || event.target.closest?.("tab");
    if (!tab || tab.ownerDocument !== document || !isSplittable(tab)) {
      return;
    }
    // Pressing on a tab selects it, so the page under the pointer would be the
    // dragged tab itself. Show the page the user was on and split with that.
    const anchor = tab.selected ? prevSelected : gBrowser.selectedTab;
    if (!anchor || anchor === tab || !anchor.isConnected || anchor.closing || anchor.hidden) {
      return;
    }
    draggedTab = tab;
    dragRestoreTab = null;
    // Show the drop zones a beat later so the tab strip's own drag starts cleanly.
    setTimeout(() => {
      if (draggedTab !== tab) {
        return;
      }
      if (tab.selected) {
        dragRestoreTab = tab;
        gBrowser.selectedTab = anchor;
      }
      showDropOverlay();
    }, 0);
  }

  function onDragEnd() {
    const restore = dragRestoreTab;
    const wasDragging = !!draggedTab;
    hideDropOverlay();
    // Dropped elsewhere (for example reordered in the sidebar): select the
    // dragged tab, as the tab strip would have.
    if (wasDragging && restore?.isConnected && !restore.splitview) {
      gBrowser.selectedTab = restore;
    }
  }

  function showDropOverlay() {
    const sv = gBrowser.activeSplitView;
    if (sv && sv.tabs.includes(draggedTab)) {
      return; // Dragging a pane's own tab: nothing to split.
    }
    if (sv && sv.tabs.length >= MAX_PANES) {
      return;
    }
    ensureLayer();
    const box = tabpanels.getBoundingClientRect();
    if (!dropOverlay) {
      dropOverlay = el(
        "div",
        { id: "amaya-split-drop", "aria-hidden": "true" },
        el("div", { class: "amaya-split-drop-zone" })
      );
      dropOverlay.addEventListener("dragover", onDropOver);
      dropOverlay.addEventListener("dragleave", e => {
        if (e.target === dropOverlay && !dropOverlay.contains(e.relatedTarget)) {
          dropOverlay.removeAttribute("zone");
        }
      });
      dropOverlay.addEventListener("drop", onDrop);
    }
    Object.assign(dropOverlay.style, {
      left: `${box.left}px`,
      top: `${box.top}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    dropOverlay.removeAttribute("zone");
    layer.append(dropOverlay);
  }

  function hideDropOverlay() {
    draggedTab = null;
    dragRestoreTab = null;
    dropOverlay?.remove();
  }

  /** Which pane and edge the pointer is over. */
  function dropTarget(clientX, clientY) {
    const sv = gBrowser.activeSplitView;
    const tabs = sv ? sv.tabs : [gBrowser.selectedTab];
    for (const t of tabs) {
      const r = panelOf(t)?.getBoundingClientRect();
      if (!r || clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
        continue;
      }
      const fx = (clientX - r.left) / r.width;
      const fy = (clientY - r.top) / r.height;
      const edges = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
      const [edge, dist] = Object.entries(edges).sort((a, b) => a[1] - b[1])[0];
      if (dist > 0.33) {
        return null;
      }
      return { tab: t, edge, rect: r };
    }
    return null;
  }

  function onDropOver(event) {
    if (!draggedTab) {
      return;
    }
    const tgt = dropTarget(event.clientX, event.clientY);
    const zone = dropOverlay.firstElementChild;
    if (!tgt) {
      dropOverlay.removeAttribute("zone");
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const o = dropOverlay.getBoundingClientRect();
    const r = tgt.rect;
    const half = { left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[tgt.edge];
    Object.assign(zone.style, {
      left: `${r.left - o.left + r.width * half[0]}px`,
      top: `${r.top - o.top + r.height * half[1]}px`,
      width: `${r.width * half[2]}px`,
      height: `${r.height * half[3]}px`,
    });
    dropOverlay.setAttribute("zone", tgt.edge);
  }

  function onDrop(event) {
    const tab = draggedTab;
    const tgt = dropTarget(event.clientX, event.clientY);
    hideDropOverlay();
    if (!tab || !tgt) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dropTabOnPane(tab, tgt.tab, tgt.edge);
  }

  /** Split `tab` into the pane showing `target`, on `edge`. */
  function dropTabOnPane(tab, target, edge) {
    const sv = target.splitview;
    if (sv) {
      if (sv.tabs.length >= MAX_PANES) {
        gBrowser.selectedTab = tab;
        return;
      }
      const before = edge === "left" || edge === "top";
      const idx = sv.tabs.indexOf(target) + (before ? 0 : 1);
      if (tab.splitview) {
        return;
      }
      const ref = sv.tabs[idx];
      sv.addTabs([tab]);
      // Move into position within the wrapper (DOM order = pane order).
      if (ref && ref !== tab) {
        gBrowser.handleTabMove(tab, () => sv.insertBefore(tab, ref));
      }
      const st = stateFor(sv);
      if (!st.auto && st.layout === "columns" && (edge === "top" || edge === "bottom")) {
        st.layout = "grid";
      } else if (!st.auto && st.layout === "rows" && (edge === "left" || edge === "right")) {
        st.layout = "grid";
      }
      st.cols = [];
      st.rows = [];
      gBrowser.selectedTab = tab;
      scheduleApply();
      return;
    }
    const before = edge === "left" || edge === "top";
    const layout = edge === "top" || edge === "bottom" ? "rows" : "columns";
    splitTabs(before ? [tab, target] : [target, tab], { select: tab, layout });
  }

  // ------------------------------------------------------- tab context menu

  let menuItems = [];
  let hiddenNative = [];

  function buildContextMenu() {
    const menu = document.getElementById("tabContextMenu");
    if (!menu) {
      return;
    }
    const xul = tag => document.createXULElement(tag);
    const splitWith = xul("menu");
    splitWith.id = "amaya-split-with";
    splitWith.setAttribute("label", "Split with…");
    splitWith.setAttribute("accesskey", "S");
    const popup = xul("menupopup");
    popup.id = "amaya-split-with-popup";
    splitWith.append(popup);
    popup.addEventListener("popupshowing", fillSplitWithPopup);
    popup.addEventListener("command", onSplitWithCommand);

    const layoutMenu = xul("menu");
    layoutMenu.id = "amaya-split-layout";
    layoutMenu.setAttribute("label", "Split layout");
    const lpopup = xul("menupopup");
    for (const key of ["columns", "rows", "grid"]) {
      const mi = xul("menuitem");
      mi.setAttribute("type", "radio");
      mi.setAttribute("name", "amaya-split-layout");
      mi.setAttribute("label", LAYOUT_LABELS[key]);
      mi.value = key;
      mi.id = "amaya-split-layout-" + key;
      lpopup.append(mi);
    }
    lpopup.addEventListener("command", e => {
      const tab = TabContextMenu.contextTab;
      setLayout(e.target.value, tab?.splitview);
    });
    layoutMenu.append(lpopup);

    const unsplitItem = xul("menuitem");
    unsplitItem.id = "amaya-unsplit";
    unsplitItem.setAttribute("label", "Un-split");
    unsplitItem.addEventListener("command", () => unsplit(TabContextMenu.contextTab?.splitview));

    // Firefox arranges this menu into declared sections the first time it
    // opens and rejects unknown items placed between them; items trailing the
    // menu are allowed. So our items wait at the end and move next to the
    // native split items only while the menu is open (after the arrange,
    // which runs in a popupshowing listener nearer the target than window).
    const items = [splitWith, layoutMenu, unsplitItem];
    menu.append(...items);
    menuItems = items;
    listen(window, "popupshowing", onTabMenuShowing);
    listen(menu, "popuphidden", e => {
      if (e.target === menu) {
        menu.append(...menuItems);
      }
    });
    const svMenu = document.getElementById("split-view-menu");
    if (svMenu) {
      listen(svMenu, "popupshowing", () => {
        const rev = svMenu.querySelector('[command="splitViewCmd_reverseTabs"], [id*="reverse" i]');
        const n = gBrowser.activeSplitView?.tabs.length || 0;
        if (rev) {
          rev.hidden = n > 2;
        }
      });
    }
  }

  function onTabMenuShowing(event) {
    if (event.target.id !== "tabContextMenu") {
      return;
    }
    const anchor =
      document.getElementById("context_reverseSplitView") ||
      document.getElementById("context_moveTabToSplitView");
    if (anchor && anchor.parentNode === event.target) {
      anchor.after(...menuItems);
    }
    const tab = TabContextMenu.contextTab;
    const sv = tab?.splitview;
    const n = sv ? sv.tabs.length : 0;
    const splitWith = document.getElementById("amaya-split-with");
    const layoutMenu = document.getElementById("amaya-split-layout");
    const unsplitItem = document.getElementById("amaya-unsplit");
    splitWith.hidden = !isSplittable(tab) || (TabContextMenu.contextTabs?.length || 1) > 1;
    splitWith.disabled = n >= MAX_PANES;
    splitWith.setAttribute("label", sv ? "Add to split…" : "Split with…");
    unsplitItem.hidden = !sv;
    layoutMenu.hidden = !sv;
    if (sv) {
      const st = stateFor(sv);
      for (const key of ["columns", "rows", "grid"]) {
        const mi = document.getElementById("amaya-split-layout-" + key);
        mi.hidden = !layoutsFor(n).includes(key);
        mi.toggleAttribute("checked", st.layout === key);
      }
    }
    // Our items replace the native two-pane ones.
    hiddenNative = [];
    for (const id of ["context_moveTabToSplitView", "context_separateSplitView"]) {
      const item = document.getElementById(id);
      if (item && !item.hidden) {
        item.hidden = true;
        hiddenNative.push(item);
      }
    }
    const rev = document.getElementById("context_reverseSplitView");
    if (rev && n > 2) {
      rev.hidden = true; // Native reverse only understands two panes.
    }
  }

  function fillSplitWithPopup(event) {
    const popup = event.target;
    if (popup.id !== "amaya-split-with-popup") {
      return;
    }
    popup.textContent = "";
    const ctx = TabContextMenu.contextTab;
    const candidates = gBrowser.visibleTabs.filter(
      t => t !== ctx && isSplittable(t) && !t.splitview
    );
    for (const t of candidates.slice(0, 30)) {
      const mi = document.createXULElement("menuitem");
      mi.className = "menuitem-iconic";
      mi.setAttribute("label", t.label);
      if (t.getAttribute("image")) {
        mi.setAttribute("image", t.getAttribute("image"));
      }
      mi._amayaTab = t;
      popup.append(mi);
    }
    if (candidates.length) {
      popup.append(document.createXULElement("menuseparator"));
    }
    const pick = document.createXULElement("menuitem");
    pick.setAttribute("label", "New tab");
    pick._amayaNew = true;
    popup.append(pick);
  }

  function onSplitWithCommand(event) {
    const ctx = TabContextMenu.contextTab;
    const mi = event.target;
    if (mi._amayaNew) {
      splitWithNewTab(ctx);
    } else if (mi._amayaTab) {
      splitTabs([ctx, mi._amayaTab], { select: ctx });
    }
  }

  function removeContextMenu() {
    for (const i of menuItems) {
      i.remove();
    }
    menuItems = [];
    for (const i of hiddenNative) {
      i.hidden = false;
    }
  }

  // ----------------------------------------------------- sidebar grouping

  function markSidebar() {
    const seen = new Set();
    for (const sv of gBrowser.splitViews || []) {
      const tabs = sv.tabs;
      sv.setAttribute("amaya-panes", String(tabs.length));
      sv.classList.add("amaya-split-group");
      tabs.forEach((t, i) => {
        t.classList.add("amaya-split-member");
        t.classList.toggle("amaya-split-first", i === 0);
        t.classList.toggle("amaya-split-last", i === tabs.length - 1);
        seen.add(t);
      });
    }
    for (const t of gBrowser.tabContainer.querySelectorAll(".amaya-split-member")) {
      if (!seen.has(t)) {
        t.classList.remove("amaya-split-member", "amaya-split-first", "amaya-split-last");
      }
    }
  }

  function unmarkSidebar() {
    for (const t of document.querySelectorAll(".amaya-split-member")) {
      t.classList.remove("amaya-split-member", "amaya-split-first", "amaya-split-last");
    }
    for (const sv of document.querySelectorAll(".amaya-split-group")) {
      sv.classList.remove("amaya-split-group");
      sv.removeAttribute("amaya-panes");
    }
  }

  // ---------------------------------------------------------- commands

  const inSplit = () => !!gBrowser.selectedTab?.splitview;
  const canGrow = () => {
    const t = gBrowser.selectedTab;
    return isSplittable(t) && (!t.splitview || t.splitview.tabs.length < MAX_PANES);
  };
  const hasLayout = layout => () =>
    inSplit() && layoutsFor(gBrowser.selectedTab.splitview.tabs.length).includes(layout);

  const COMMANDS = [
    { id: "split-with-current", label: "Split with current tab", icon: "split", when: canGrow, run: () => splitWithCurrent() },
    { id: "split-new-tab", label: "Split with new tab", icon: "split", when: canGrow, run: () => splitWithNewTab() },
    { id: "split-unsplit", label: "Un-split", icon: "split", when: inSplit, run: () => unsplit(gBrowser.selectedTab.splitview) },
    { id: "split-layout-columns", label: "Split layout: side by side", icon: "split", hint: "Split view", when: hasLayout("columns"), run: () => setLayout("columns", gBrowser.selectedTab.splitview) },
    { id: "split-layout-rows", label: "Split layout: stacked", icon: "split", hint: "Split view", when: hasLayout("rows"), run: () => setLayout("rows", gBrowser.selectedTab.splitview) },
    { id: "split-layout-grid", label: "Split layout: grid", icon: "grid", hint: "Split view", when: hasLayout("grid"), run: () => setLayout("grid", gBrowser.selectedTab.splitview) },
    { id: "split-reset-sizes", label: "Reset split pane sizes", icon: "split", hint: "Split view", when: inSplit, run: () => resetSizes() },
  ].map(c => Object.assign({ group: "actions" }, c));

  /** Command bar: same id replaces, `when()` hides actions that do not apply. */
  function registerCommands() {
    const list = (ui.commands ||= []);
    for (const c of COMMANDS) {
      const i = list.findIndex(x => x && x.id === c.id);
      if (i === -1) {
        list.push(c);
      } else {
        list[i] = c;
      }
    }
  }

  function unregisterCommands() {
    const list = ui.commands;
    if (!Array.isArray(list)) {
      return;
    }
    for (const c of COMMANDS) {
      const i = list.indexOf(c);
      if (i !== -1) {
        list.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------- lifecycle

  function onSplitChange() {
    scheduleApply();
  }

  function init() {
    tabpanels = gBrowser.tabpanels;
    if (!Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false)) {
      // Our UI depends on the native split view machinery.
      Services.prefs.setBoolPref("browser.tabs.splitView.enabled", true);
    }
    const tc = gBrowser.tabContainer;
    for (const type of [
      "TabSplitViewActivate",
      "TabSplitViewDeactivate",
      "SplitViewTabChange",
      "SplitViewCreated",
      "SplitViewRemoved",
      "TabMove",
    ]) {
      listen(tc, type, onSplitChange);
    }
    listen(tc, "TabClose", onTabClose);
    listen(tc, "TabSelect", e => {
      prevSelected = e.detail?.previousTab || prevSelected;
      const sv = gBrowser.activeSplitView;
      if (sv) {
        for (const t of sv.tabs) {
          refreshHeaderFor(t);
        }
      }
    });
    listen(tc, "TabAttrModified", e => {
      if (e.target.splitview) {
        refreshHeaderFor(e.target);
      }
    });
    listen(tc, "dragstart", onTabDragStart, true);
    listen(window, "dragend", onDragEnd, true);
    listen(window, "drop", () => setTimeout(onDragEnd, 0), true);
    listen(window, "keydown", onKeyDown, true);
    listen(window, "resize", () => positionGutters());

    progressListener = {
      onLocationChange(browser) {
        const tab = gBrowser.getTabForBrowser(browser);
        if (tab?.splitview) {
          refreshHeaderFor(tab);
        }
      },
    };
    gBrowser.addTabsProgressListener(progressListener);

    resizeObserver = new ResizeObserver(() => positionGutters());
    resizeObserver.observe(tabpanels);

    buildContextMenu();
    on("split", onSplitEvent);
    registerCommands();

    // Expose a small API for other modules and tests.
    ui.split = {
      split: (tabs, opts) => splitTabs(tabs, opts),
      unsplit: sv => unsplit(sv),
      setLayout: (layout, sv) => setLayout(layout, sv),
      resetSizes: () => resetSizes(),
      focusDirection: (dx, dy) => focusDirection(dx, dy),
      dropTabOnPane: (tab, target, edge) => dropTabOnPane(tab, target, edge),
      resize: (axis, index, pos) => resizeTrack(axis, index, pos),
      state: sv => {
        sv = sv || gBrowser.activeSplitView;
        return sv ? JSON.parse(JSON.stringify(stateFor(sv))) : null;
      },
      MAX_PANES,
    };

    loadStore();
    apply();
  }

  function uninit() {
    for (const fn of cleanups.splice(0)) {
      try {
        fn();
      } catch (e) {}
    }
    if (progressListener) {
      gBrowser.removeTabsProgressListener(progressListener);
      progressListener = null;
    }
    resizeObserver?.disconnect();
    removeContextMenu();
    hideDropOverlay();
    updateGutters(null);
    if (layer) {
      layer.remove();
      layer = null;
    }
    removeHeaders();
    for (const p of [...styledPanels]) {
      clearPanel(p);
    }
    if (tabpanels) {
      tabpanels.removeAttribute("amaya-split");
      tabpanels.removeAttribute("amaya-panes");
      tabpanels.style.removeProperty("--amaya-split-cols");
      tabpanels.style.removeProperty("--amaya-split-rows");
    }
    unmarkSidebar();
    unregisterCommands();
    clearTimeout(saveTimer);
    if (ui.split) {
      delete ui.split;
    }
  }

  ui.register(NAME, { init, uninit });
})();
