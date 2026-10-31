AmayaBrowser is a cross-platform browser (macOS, Windows, Linux) built on Firefox's Gecko engine. It combines Zen's workspace workflow, Firefox's tracking protection, Mullvad's anti-fingerprinting, and Orion's zero-telemetry promise. Privacy is the product: the interface makes protection visible and calm, never alarming.

## Principles

- **Quiet by default.** The browser frame recedes; the page is the subject. Use `surface-window` for the frame and `surface-page` or `surface-raised` for content. One accent only: `brand`.
- **Privacy is visible, not loud.** Show protection with the shield and a count in the address field. Reserve `warn` and `danger` for real problems (not secure, certificate error), and always pair them with a word and an icon.
- **Native feeling on every OS.** Chrome UI uses the system font (`font-ui`), the same sizes everywhere. Window controls, menus and file dialogs stay native.
- **Keyboard first.** Every action is reachable from the command bar (`Ctrl+K`, `Cmd+K` on macOS). Every control has a visible focus ring.
- **No dark patterns.** No upsells, no sponsored tiles, no nags. Settings say what they do and what it costs (for example "may break some sites").

## Content fundamentals

- Speak plainly, in the second person ("Your tabs stay private"), present tense, sentence case everywhere. No exclamation marks, no emoji.
- Say what happened, then what the person can do: "Blocked 14 trackers on this page. See what was blocked."
- Name technical things once in plain words, then keep the term: "Fingerprint protection: Balanced mixes your values, Uniform matches everyone."
- Never use fear language ("danger", "hackers", "threat") for routine blocking. Use "blocked", "kept apart", "upgraded to HTTPS".
- Buttons are verbs: "New space", "Report broken site", "Open as tab".

## Visual foundations

- **Colour.** `surface-window` frames the browser, `surface-page` is the ground of internal pages, `surface-raised` is for anything that floats or is selected. Text is `ink`, then `ink-muted`, then `ink-subtle` (placeholders only). Use `brand` for the shield, primary buttons, links and the selected state; use `brand-soft` with `on-brand-soft` for selected rows and the protected chip. Space colours (`space-moss`, `space-clay`, `space-sky`, `space-sand`, `space-plum`, `space-slate`) are marks only: dots, icons, outlines. Never use them as large fills or text.
- **Themes.** Light and dark are both first-class. Both pass 4.5:1 for text and 3:1 for control borders, focus rings and icons. Match the system theme by default.
- **Type.** `tab-title` 13/16 and `url` 14/20 for chrome; `body` 15/22 and `heading` 22/28 for internal pages; `display-lg` and `display-md` (serif, `font-display`) only for the new-tab greeting, onboarding and marketing. Hostnames in the address field are weight 600; the path is regular and `ink-muted`.
- **Spacing and radius.** A 4px grid (`space-1` to `space-7`). Tabs, the address field and split panes use `radius-md`; popovers, the command bar and Glance use `radius-lg`; buttons and inputs use `radius-sm`; toggles and space dots use `radius-pill`.
- **Elevation.** Borders and surface contrast first, shadow second. The active tab uses `shadow-tab`; popovers `shadow-popover`; Glance `shadow-glance` over a 45% scrim.
- **Borders.** Hairlines between regions use `border-subtle` (decorative). Control outlines use `border-strong`. No coloured left-border cards.
- **Focus.** 2px solid `focus-ring`, 2px offset, on every interactive element, on every surface.
- **Motion.** Short and functional: 120ms ease-out for hover and toggles, 180ms for popovers and Glance, 200ms for sidebar collapse. No bounce, no parallax. Respect the system "reduce motion" setting by switching to instant changes.
- **Imagery.** None in the chrome. Internal pages may use flat tile compositions in the palette, never photographs or illustrations of people.

## Iconography

- 16px stroke icons on a 24px grid, 1.5px stroke, round caps and joins, `currentColor`. Icons are always paired with a label or an accessible name.
- The set in the previews (shield, lock, plus, close, search, split, folder, chevron, sidebar, open-in-tab, sound, gear, arrow, clock, grid, back, warning, pause) is drawn for this system. Extend it in the same style; do not mix in another icon set.
- Site favicons are shown as fetched. Where none exists, show a neutral square with the first letter.

## How to build with this system

- Read `tokens.json` for every value; use the token name, never the raw hex.
- Components are described in `components/<Name>/README.md`, with live previews in both themes. Dimensions come from the `layout` tokens.
- The shell layout, screens and behaviours are in `chrome-spec.md`; privacy states and wording are in `privacy-ui.md`.
