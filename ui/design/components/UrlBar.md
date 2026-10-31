The 36px address field: protection shield, security state, host and path.

**You provide:** the URL, the security state and the blocked count.

- The host is weight 600 in `ink`; scheme and path are `ink-muted`. The shield button at the left shows the count, or a word for non-protected states.
- States: protected, upgraded to HTTPS, not secure (`warn`), certificate error (`danger`), paused. Every state has an icon and a word.
- Background `surface-sunken`, `radius-md`. Click selects the whole URL; paste-and-go on Enter.
- Don't show full URLs while typing in a way that hides the real host, and never hide the scheme when it is not HTTPS.
