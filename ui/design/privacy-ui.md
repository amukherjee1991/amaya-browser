# Privacy UI: states, wording and defaults

How AmayaBrowser shows protection. The shield sits at the left of the address field; its colour, icon and word change with the state.

## Address field states

| State | Shield | Wording | Colour pair |
| --- | --- | --- | --- |
| Protected | Shield with a count of what was blocked | "Protected on example.org" | `brand-soft` / `on-brand-soft` |
| Upgraded | Shield and chip | "Upgraded to HTTPS" | `brand-soft` / `on-brand-soft` |
| Not secure | Warning triangle, the words "Not secure" | "This page is not encrypted. Others on your network can read what you send." | `warn-soft` / `warn` |
| Certificate problem | Warning triangle, the words "Certificate error" | "This site's identity could not be checked." Full-page interstitial, no easy bypass. | `danger-soft` / `danger` |
| Paused for this site | Pause icon, the word "Off" | "Protection paused for this site" | none / `ink-muted` |

Colour never carries the state alone: every state has an icon and a word.

## The privacy panel

Opens from the shield. In order: a header with the site and one status line; three counters (trackers blocked, fingerprint attempts, cookies kept apart); fingerprint mode (Balanced or Uniform); a switch for tracker blocking on this site; two buttons ("See what was blocked", "Report broken site").

- **Balanced** (default): mixes values that sites use to identify a device, so sites still work. **Uniform**: reports the same values as everyone else, for higher-risk use; some sites may look or behave differently.
- Turning protection off for a site is per site, per space, and always shown in the address field.
- The counters are local. Nothing about browsing is sent anywhere.

## The privacy report

A page listing, by site and by day, what was blocked, with hostnames in `code`. It can be cleared and exported. It never leaves the device.

## Defaults (all on at first run)

- No telemetry, no studies, no sponsored content, no account required.
- Strict tracker blocking, cookies separated per site and per space, HTTPS-only mode with a clear interstitial when a site cannot be upgraded.
- Encrypted DNS with a resolver the person chooses at onboarding.
- uBlock Origin installed and enabled.
- No built-in AI assistant. Any future assistant is opt-in and clearly labelled.

## Wording rules

- Say "blocked", "kept apart", "upgraded". Avoid "danger", "threat", "attack" for routine events.
- Always state the cost of a stricter setting in the same place as the setting.
- When something breaks because of protection, offer "Report broken site" and "Turn off for this site" together, never only the second.
