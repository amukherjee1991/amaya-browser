# Chrome spec: layout and behaviour

Screen-level rules for the AmayaBrowser window. Values are token names from `tokens.json`.

## Window anatomy

| Region | Rule |
| --- | --- |
| Sidebar (left) | Width `layout-sidebar` (264px, resizable 200 to 400). Holds back/forward, the address field, pinned tiles, tabs, folders, new tab, space switcher. Background `surface-window`. |
| Web view | Fills the rest. Inset by `layout-pane-gap` from the sidebar with `radius-md` corners and a `border-subtle` outline, so the page reads as one card. |
| Top bar (optional) | Height `layout-toolbar`. Shown only when the user chooses "Top toolbar" instead of the sidebar address field. Same controls, same order. |
| Compact mode | Sidebar collapses to `layout-sidebar-compact` (52px, favicons only) and slides out over the page on edge hover. The address field appears on `Ctrl+L` or `Cmd+L`. |
| Window controls | Native on every OS, in the sidebar's top-left on macOS and Linux, top-right on Windows. |

## Sidebar order, top to bottom

1. Top row: collapse button, then back and forward at the right.
2. Address field (see UrlBar). Click selects all; typing opens suggestions in the command bar style.
3. Pinned tiles: a 3-column grid, 44px tall, shared across the space.
4. Divider (`border-subtle`).
5. Folders and tabs, newest at the bottom. Folders nest one level and show a count chip when collapsed.
6. "New tab" row.
7. Space switcher, pinned to the bottom: active space shows its name; others show only a colour dot.

## Spaces

- A space owns its tabs, pins, folders and, by default, its own storage (cookies, local storage, cache) so logins never mix. Switch with `Ctrl+1` to `9`, or by swiping the space row.
- Each space has a name, a colour from the six `space-*` tokens, an "isolated storage" switch (default on) and an optional proxy.
- Switching a space is instant; tabs from the previous space are suspended after 5 minutes (setting).

## Split view

- Up to four panes in a grid (two side by side, two stacked, or 2 by 2). Gap `layout-pane-gap`; the active pane has a 2px `brand` outline.
- Create: drag a tab onto a pane edge, or right-click a tab and choose "Split with...". Each pane has its own back/forward and address.
- Resize by dragging the gap; double-click the gap to reset to equal. Close a pane with its tab, or "Un-split" in the tab menu.

## Glance

- `Alt+click` (or long-press) on a link opens it in a floating preview at 92% of the page width and 80% of its height over a 45% scrim.
- The bar offers "Open as tab", "Split", and close. `Esc` or a click on the scrim closes it. The preview runs in the same space, with the same protection.

## Command bar

- `Ctrl+K` / `Cmd+K`. Centred, 560px wide, `radius-lg`, `shadow-popover`, over a lightly dimmed page.
- Groups, in order: Tabs, Spaces, Actions, History, Settings, Web search. Arrow keys move, `Enter` runs, `Esc` closes. The selected row uses `brand-soft`.
- Typing a URL puts "Go to" first. Typing plain text puts the web search last, never first, unless nothing else matches.

## New tab page

- A calm `surface-page` page: `display-lg` greeting, a single search field, pinned sites as flat tiles. No news, no sponsored tiles, no recommendations.
- A small line shows the privacy tally for the week ("1,248 trackers blocked this week") linking to the privacy report.

## Settings and onboarding

- Settings are a single scrolling page with a left list of sections: Privacy, Spaces, Appearance, Search, Sync, Extensions, Advanced. Each setting has a one-line description and the cost of turning it off.
- Onboarding is four short steps: import from another browser, choose the protection level, choose a search engine (no default is pre-selected for a sponsor), and pick the sidebar or top toolbar.

## Responsive and accessibility

- Minimum window 480 by 360. Below 720px wide, the sidebar starts in compact mode.
- Every control is reachable by keyboard in sidebar order. Touch targets are at least 28px; the sidebar rows are 36px.
- Text contrast is at least 4.5:1 in both themes; focus rings, control borders and icons at least 3:1.
