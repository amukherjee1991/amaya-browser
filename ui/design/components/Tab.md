A 36px sidebar row showing one tab, with favicon, title, close button and state.

**You provide:** the page title, favicon (or its first letter), and flags for active, loading, playing sound and suspended.

- States: default; hover (`surface-page`); active (`surface-raised` with `shadow-tab`); loading (ring around the favicon); playing (sound icon in `brand`); suspended (title in `ink-muted`, dashed favicon outline, tab keeps its place and reloads on click).
- The close button appears on hover and on the active tab. Middle-click closes; drag to reorder, drop on a folder to file, drop on a pane edge to split.
- Titles truncate with an ellipsis; the full title and URL show in a tooltip after a short delay.
- Don't colour tabs by space: the space dot lives in the switcher.
