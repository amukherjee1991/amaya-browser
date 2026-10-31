# cmdbar: the command bar

`Ctrl+K` (`Cmd+K` on macOS) opens a 560px palette in `AmayaUI.overlayRoot`
over a lightly dimmed page. It finds and runs tabs, spaces, actions, history,
settings and, last, a web search. Spec: `ui/design/chrome-spec.md` (Command
bar) and `ui/design/components/CommandBar.md`.

## Behaviour

* Groups, in order: **Go to** (only when the text is an address), **Tabs**,
  **Spaces**, **Actions**, **History**, **Settings**, **Web search**. The web
  search row is always last, so it is only first when nothing local matches.
* Matching: prefix, then word prefix, then substring; labels also match as a
  subsequence ("nwtb" finds "New tab"). Keywords, hosts and URLs need a prefix
  or substring. When anything matches strongly, subsequence-only matches are
  dropped.
* Keys: `↑`/`↓` move, `Tab`/`Shift+Tab` jump between groups, `Enter` runs,
  `Ctrl+Enter` (`Cmd+Enter`) opens addresses, history, and web searches in a new
  tab, `Esc` closes, and `Ctrl+K` again closes. Pointer hover selects; a click runs.
* Firefox's own `Ctrl+K` (focus web search, `key_search`) is taken over
  while this module is loaded and restored in `uninit`.
* Privacy: nothing goes to the network while you type. Tabs and commands are
  in memory, history comes from the local Places database (read-only), and
  favicons come from the local favicon store. The search engine URL is only
  built when you choose the web search row.
* No open, close or hover animation (keyboard-triggered UI).

## Registering commands (for other modules)

A command is a plain object:

```js
{
  id: "split.with",            // unique; registering the same id replaces it
  label: "Split with current tab",
  run({ newTab, window }) {},  // newTab: Ctrl/Cmd+Enter was held
  group: "actions",            // "actions" (default) | "spaces" | "settings"
  icon: "split",               // design icon name, or an SVG/HTML element
  hint: "Research",            // optional right-aligned text (string or () => string)
  shortcut: "Accel+Shift+S",   // optional; or ["Ctrl", "2"]; or () => either
  keywords: ["pane", "side by side"], // optional extra match terms
  when: () => true,            // optional; hide the command when it returns false
}
```

Use any of these. All three work whether your module loads before or after
the command bar:

```js
// 1. Push to the shared registry (an array; it may not exist yet).
(AmayaUI.commands ||= []).push(cmd);

// 2. Emit the contract event (reaches the bar only if it has loaded).
AmayaUI.emit("register-command", cmd);
AmayaUI.emit("unregister-command", { id: "split.with" });

// 3. Add commands each time the bar opens (for state-dependent ones).
window.addEventListener("amaya:register-commands", e => {
  if (isSplit()) e.detail.add({ id: "split.off", label: "Un-split", run: unsplit });
});
```

Prefer 1 for fixed commands (the spaces module lists each space as
`group: "spaces"`), and 3 for commands that depend on state.

After the bar is loaded, `AmayaUI.cmdbar` also offers
`open(query?)`, `close()`, `toggle()`, `isOpen`, `register(cmd)` and
`unregister(id)`. `AmayaUI.emit("open-cmdbar", { query })` opens it too.

## Events it fires

| Event | Detail | When |
|---|---|---|
| `amaya:command` | `{ id }` | After any row runs: the command id (`tab.new`, `split.with`, ...), or `tab:<panel>`, `place:<url>`, `go:<url>`, `web` |
| `amaya:toggle-compact` | `{}` | "Toggle compact mode" was chosen (the shell owns compact mode) |
| `amaya:cmdbar-opened` / `amaya:cmdbar-closed` | `{}` | Bar opens or closes |
| `amaya:register-commands` | `{ add(cmd) }` | Each time the bar opens |

## Spaces integration

For each tab the bar shows the space name as the hint and switches space before
selecting a tab in another space. It uses the first of these that exists:

1. `AmayaUI.spaces.spaceForTab(tab)` returning `{ id, name }`, and
   `AmayaUI.spaces.switchTo(id)` (or `activate`/`select`) with
   `AmayaUI.spaces.activeId`.
2. The tab attributes `amaya-space-name` and `amaya-space-id`.
3. The tab's container name (`userContextId`).

Without a spaces API it simply selects the tab.

## Built-ins

Actions: New tab, New window, New private window, Close tab, Reopen closed tab
(only when there is one), Toggle compact mode, Bookmark this page, Print,
Downloads, Find in page, Toggle reader view (only on readable pages), Reload
page, Duplicate tab, Mute or unmute tab, Full screen, Clear recent history,
Developer tools. Shortcut hints are read from Firefox's `<key>` elements, so
they match the platform.

Settings: Privacy and protection, Tracker blocking, Fingerprint protection
(Balanced or Uniform; sets `amaya.fingerprinting.mode`, applies after
restart), Passwords, Site permissions, Encrypted DNS, Search engine, Home and
new tab, General settings, Network and proxy, DRM content, Extensions and
themes (about:addons), All settings.
