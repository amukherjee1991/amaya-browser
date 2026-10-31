A 32px action button in primary, default, quiet and danger variants.

**You provide:** a label (a verb), an optional leading icon, and the click handler. Never icon-only without an accessible name.

- Use one primary button per panel. Use quiet for secondary links ("Learn more") and danger only for destructive actions ("Clear site data"), always with a confirm step.
- Height 32px, `radius-sm`, label `label` style. Focus: 2px `focus-ring` outline, 2px offset.
- Disabled buttons stay in place at 50% opacity; say why in nearby text.
- Don't stack two primaries, and don't use `brand` text for anything but links and quiet buttons.
