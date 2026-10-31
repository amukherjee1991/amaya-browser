A 560px centred search that finds tabs, spaces, actions, history and settings, and runs them.

**You provide:** the query, grouped results, and the selected index. Each result has an icon, a label and an optional hint (shortcut or space name).

- Opens with `Ctrl+K` or `Cmd+K`; `Esc` closes; arrows move; `Enter` runs. The selected row uses `brand-soft`.
- Group order: Tabs, Spaces, Actions, History, Settings, then the web search. Plain text never puts web search first when something local matches.
- Width 560px, `radius-lg`, `shadow-popover`; the input row is 52px, results rows 36px.
- Don't show ads or suggestions from a search engine until the person chooses to.
