The 264px left column that holds navigation, the address field, pins, tabs, folders and the space switcher.

**You provide:** the current space, its pinned sites, its tabs and folders, and the active tab's URL and protection state.

- Order, top to bottom: collapse and back/forward, address field, pins (3 columns, 44px), divider, folders and tabs, New tab, space switcher.
- Width `layout-sidebar`, resizable between 200 and 400px; collapses to `layout-sidebar-compact` (favicons only). Background `surface-window`.
- Folders nest one level, show a count chip when collapsed, and keep their tabs in one drag-able group.
- Don't add more than these sections. Extension buttons go in a menu, not in the sidebar.
