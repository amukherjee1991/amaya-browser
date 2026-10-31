# Amaya workflow UI (Phase 2)

The Amaya interface — sidebar with address field, pinned tiles, spaces, split
view, Glance, command bar, privacy shield/panel, new tab and first run — built
as a layer on top of Gecko's own browser UI. **No engine patches and no
recompiling:** the UI is plain chrome JS + CSS, installed into the app by
`tools/amaya stage` and loaded into every browser window at startup.

Design source of truth: [`design/`](design/) (copied from the AmayaBrowser
design system) — `README.md` (principles, voice), `chrome-spec.md` (layout and
behaviour), `privacy-ui.md`, `tokens.json`, `components/*.md` +
`*.preview.html` (component specs and reference markup/CSS), and
`mockups/*.dc.html` (the four approved screen mockups).

## How it loads

```
amaya.cfg (autoconfig, privileged)
  └─ loads <appdir>/amaya-ui/loader.js   (or $AMAYA_UI_DIR/loader.js in development)
       └─ for each browser window (chrome://browser/content/browser.xhtml),
          after "browser-delayed-startup-finished":
            1. tokens.css                     (author sheet on the window)
            2. for name in modules.json:      (in order)
                 modules/<name>/<name>.css    (if present)
                 modules/<name>/<name>.js     (loadSubScript into the window)
```

* `$AMAYA_UI_DIR` overrides the UI directory, so every developer/agent can run
  the same built app with **their own** `ui/` checkout. No copy, no rebuild.
* One module failing must never break others: the loader wraps each in
  try/catch and logs `[amaya-ui:<name>]` to the browser console.

## Module contract

Each module lives in `modules/<name>/` and owns only that folder.

```js
// modules/<name>/<name>.js — runs in the browser window's scope (privileged)
(function () {
  const ui = window.AmayaUI;            // created by the loader
  ui.register("<name>", {
    init(win) { /* build DOM, add listeners */ },
    uninit(win) { /* remove everything you added */ },
  });
})();
```

`window.AmayaUI` (from the loader):

| Member | What |
|---|---|
| `register(name, {init, uninit})` | Loader calls `init(window)` right away (DOM ready) and `uninit` on window unload |
| `dirURL` | `file://` URL of the UI dir (for icons/assets: `ui.dirURL + "modules/<name>/x.svg"`) |
| `anchor(id)` | Returns the element for a shared anchor id (below) or `null` |
| `whenAnchor(id, cb)` | Calls `cb(el)` once the anchor exists (shell may build it after you) |
| `overlayRoot` | A full-window `html:div#amaya-overlay-root` above the content area for floating UI (command bar, Glance, popovers). Pointer-events none by default; children set their own. |
| `h(tag, props, ...children)` | Small HTML element helper (`html:` namespace) |
| `icon(name)` | Inline SVG from the design system icon set (`shield, lock, plus, close, search, split, folder, chevron, sidebar, open-in-tab, sound, gear, arrow, clock, grid, back, forward, warning, pause, puzzle`) |
| `prefs` | `Services.prefs` |
| `store(name)` | `{ async read(), async write(obj) }` JSON file at `<profile>/amaya/<name>.json` |
| `emit(type, detail)` / `on(type, fn)` | Window-level events between modules, `amaya:<type>` |
| `log(name, ...)` | Console log with module prefix |

## Shared DOM anchors (created by the **shell** module)

| Id | Where | Used by |
|---|---|---|
| `amaya-sidebar` | The left sidebar column (Gecko's vertical-tabs sidebar, restyled) | shell |
| `amaya-sidebar-top` | Top row: collapse, pinned extensions, Extensions button, back, forward, menu | shell, extensions |
| `amaya-urlbar-slot` | Where the address field lives in the sidebar | shell (moves `#urlbar` here), privacy (shield) |
| `amaya-pins` | 3-column pinned tiles grid | shell |
| `amaya-sidebar-footer` | Bottom of the sidebar | spaces (switcher) |

Modules must work (degraded) if an anchor is missing: e.g. the spaces switcher
falls back to the nav-bar if `amaya-sidebar-footer` does not exist.

## Events

| Event | Fired by | Detail |
|---|---|---|
| `amaya:space-changed` | spaces | `{ id, userContextId, name, color }` |
| `amaya:open-glance` | anyone | `{ url, triggeringPrincipal? }` |
| `amaya:split` | anyone | `{ tabs: [tab, ...] }` |
| `amaya:command` | cmdbar | `{ id }` — modules may `ui.on("register-commands")` to add actions |

Command bar actions: modules register with
`ui.emit("register-command", { id, label, icon, hint, run })`; the cmdbar listens.

## Keyboard (reserved)

`Ctrl/Cmd+K` command bar · `Ctrl+1…9` switch space · `Alt+click` Glance ·
`Ctrl+L` address field · `Ctrl+Alt+arrows` move split-pane focus · `Ctrl+Shift+S`
toggle compact mode. Never animate keyboard-triggered UI.

## Extensions and themes

* The **extensions** module moves Firefox's own Extensions button
  (`#unified-extensions-button`, puzzle icon) into the sidebar top row. It
  opens the native extensions panel and is the anchor for install and
  permission prompts and for extension popups.
* Extensions the user pins ("Pin to toolbar") live in the hidden nav-bar for
  Firefox; their real toolbar buttons are shown as up to three icons in the
  top row (`#amaya-ext-pins`), as many as fit the sidebar width. The rest show
  in the extensions panel with popups anchored to the Extensions button. The
  nav-bar is therefore only `display: none`, never `collapsed`.
* The command bar gets "Extensions", "Find extensions" (addons.mozilla.org)
  and one "<name> sidebar" entry per extension sidebar (the native sidebar
  launcher icons are hidden by the shell).
* **Themes**: Amaya's tokens stay authoritative. A Firefox theme only decides
  light or dark (Firefox maps it to the chrome's `prefers-color-scheme`,
  which `tokens.css` follows); its colours are overridden in `shell.css`, so a
  theme can never leave theme-coloured text on an Amaya background. Web
  content pages such as about:addons still use the theme's accent.

## Style rules

* Every value from `tokens.css` variables (`--amaya-*`); no raw hex outside it.
* Light and dark both; respect `prefers-reduced-motion` (instant changes).
* Motion per design README: 120ms hover/toggles, 180ms popovers/Glance, 200ms
  sidebar collapse; ease-out `cubic-bezier(0.23, 1, 0.32, 1)`; no bounce.
* Copy per design README voice: plain, sentence case, no exclamation marks.
* Prefix every class/id you add with `amaya-`.

## Developing and testing

```sh
# Run the built app with your ui/ checkout and a fresh profile:
ui/tools/dev.sh                       # headful, AMAYA_UI_DIR=$PWD/ui
# Screenshot the browser window (headless), optionally after running chrome JS:
ui/tools/shot.py --out /tmp/x.png [--size 1440x900] [--url https://example.org] [--js 'AmayaUI...']
```

The built app is `dist/stage/amaya/amaya` in the main checkout
(`/home/arghya/Documents/Amaya Browser/dist/stage/amaya/amaya`); treat it as read-only.

## Ownership

| Path | Owner |
|---|---|
| `loader.js`, `tokens.css`, `modules.json`, `tools/`, `settings/amaya.cfg` (loader block), `settings/autoconfig.js`, `tools/amaya_tool/stage.py` | foundation |
| `modules/shell/` | shell |
| `modules/spaces/` | spaces |
| `modules/split/` | split |
| `modules/glance/` | glance |
| `modules/cmdbar/` | cmdbar |
| `modules/privacy/` | privacy |
| `modules/home/` | home (new tab + first run) |
| `modules/extensions/` | extensions (Extensions button, pinned extension icons, extension command bar entries) |
| `modules/update/` | update (Linux update check and prompt; reads `amaya-ui/version.json` written by `tools/amaya stage`) |
