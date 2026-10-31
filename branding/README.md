# Amaya branding

Everything that makes the build say "Amaya" instead of "Firefox": logo, icons,
brand strings, branding prefs. Mozilla's Firefox name and logo must not appear
in an Amaya build.

> **Trademark search pending.** "Amaya" is a working name (see
> `docs/DEVELOPMENT_PLAN.md` §6). The W3C shipped a browser/editor called
> **Amaya** (1996–2012), and other marks may exist. Run a trademark search
> before any public release; the name and mark may still change.

## The mark

A pointed **archway**: an "A" with no crossbar, with a **lantern dot** where the
crossbar would be. It reads as "A", as a doorway (a safe way through) and as a
light at night. It is a flat silhouette with no fox, flame, globe, rings or
swirl, so it does not look like Firefox, Chrome, Brave, Zen, Edge, Vivaldi or
Arc. It stays legible at 16×16. A separate small-size master snaps the legs to
pixel boundaries for this.

### Palette

| Name     | Hex       | Used for |
|----------|-----------|----------|
| Rain     | `#45D0E3` | Arch gradient, top-left |
| Indigo   | `#4A55E0` | Arch gradient, bottom-right |
| Lantern  | `#FFC861` | Lantern dot |
| Midnight | `#141A3A` | Dark backgrounds (about dialog, tiles, installers), wordmark on light |
| Midnight 2 | `#232C66` | Bottom of background gradients |
| Mist     | `#F4F6FB` | Light surfaces, wordmark on dark, private-mode lantern |
| Deep Indigo | `#3346C2` | Accents (PDF band, installer progress bar, jump-list icons) |
| Dusk     | `#A88BFF` → `#5B33C9` | Private-browsing arch gradient |

Wordmark typeface: **Inter SemiBold** (SIL OFL 1.1), tracking −1 %, converted
to outlines. No font is needed at runtime.

## Layout

```
branding/
├── source/                 SVG masters (edit these)
│   ├── amaya-icon.svg          full-colour mark (≥ 64 px renders, scalable icon)
│   ├── amaya-icon-small.svg    16-grid-hinted mark (≤ 48 px renders)
│   ├── amaya-icon-private.svg  private-browsing variant
│   ├── amaya-symbolic.svg      monochrome (GNOME symbolic, macOS menu bar)
│   ├── amaya-wordmark.svg      "Amaya" wordmark
│   ├── document.svg, document_pdf.svg, newtab.svg, newwindow.svg
├── tools/
│   ├── generate.py         regenerates every raster/ico/icns/bmp/jpg (idempotent)
│   ├── rasterize.mjs       resvg wrapper used by generate.py
│   └── make_dsstore.py     writes amaya/dsstore (dmg Finder layout)
├── amaya/                  drop-in Firefox 159 branding dir → engine/browser/branding/amaya/
├── linux/                  desktop icons for packaging/ (org.amaya.Browser)
└── macos/                  AppIcon.xcassets: input for compiling amaya/Assets.car
```

### `amaya/` vs. upstream `browser/branding/unofficial/`

`tools/amaya import` copies `amaya/` verbatim to
`engine/browser/branding/amaya/`. The mozconfig selects it with
`--with-branding=browser/branding/amaya`. Every file in the upstream
`unofficial/` template exists here with the **same name**, because the build
references files by name (`browser/app/moz.build`,
`browser/branding/branding-common.mozbuild`, `python/mozbuild/mozbuild/nsis.py`,
`toolkit/moz.configure` dmg args, `content/jar.mn`). The differences:

* **Missing: `Assets.car`.** This is a compiled macOS asset catalog. Only
  Xcode's `actool` can produce it, so it cannot be built on Linux.
  `browser/app/moz.build` copies it into the `.app` on **macOS builds only**,
  so Linux builds are unaffected. For Phase M, compile it on a Mac:
  ```sh
  xcrun actool branding/macos/AppIcon.xcassets --compile branding/amaya \
      --platform macosx --minimum-deployment-target 10.15 \
      --app-icon AppIcon --output-partial-info-plist /tmp/amaya-icon.plist
  ```
  and commit `branding/amaya/Assets.car`.
* **Extra: `LICENSE`.** The official branding directory has one; ours states
  the artwork's origin and that the trademark search is pending.

Names that keep "firefox" because the build system requires them (the files
contain no Firefox branding):

| File / identifier | Why it keeps the name |
|---|---|
| `firefox.ico`, `firefox64.ico` | `browser/app/moz.build` (`FIREFOX_ICO`), `desktop-launcher`, `nsis.py`/`stub.nsi` |
| `firefox.icns` | `browser/app/moz.build`, `Info.plist.in` `CFBundleIconFile`, `package-manifest.in` |
| `firefox.VisualElementsManifest.xml` | `branding-common.mozbuild`, `package-manifest.in` |
| `pref/firefox-branding.js` | `branding-common.mozbuild` |
| `content/firefox-wordmark.svg` | `chrome://branding/content/firefox-wordmark.svg` in `aboutPrivateBrowsing.css`. It contains the *Amaya* wordmark |
| `FirefoxBranding()` in `moz.build` | template function defined in upstream `branding-common.mozbuild` |

The MPL headers mention "Mozilla Public License". That is the licence, not
branding, so it stays.

### Brand strings

`locales/en-US/brand.ftl` keeps the template's Fluent ids:
`-brand-shorter-name`, `-brand-short-name`, `-brand-shortcut-name`, and
`-brand-product-name` are all "Amaya". `-brand-full-name` is "Amaya Browser",
`-vendor-short-name` is "Amaya", and `trademarkInfo` is a blank string.
`brand.properties` mirrors these. Mozilla service names such as
`-mozilla-vpn-brand-name` are not defined in branding. They live in
`toolkit/locales` and still refer to Mozilla's products.

## Regenerating

```sh
python3 branding/tools/generate.py          # rewrite generated files
python3 branding/tools/generate.py --check  # CI: exit 1 if anything is stale
```

Requirements: `node` ≥ 18 and `npm`, plus `python3` with Pillow
(`python3-pil`). On first run the script installs `@resvg/resvg-js@2.6.2` into
`~/.cache/amaya-branding/` (override this with `AMAYA_BRANDING_CACHE`, or point
`AMAYA_RESVG_NODE_PATH` at an existing install). Nothing is installed into the
repo. ICO and ICNS containers are written with the standard library. ICO
entries below 256 px are 32-bit DIBs, and the 256 px entry is a PNG. ICNS
entries are PNG (`icp4`…`ic10`). Output is byte-for-byte reproducible with the
same resvg and Pillow versions. The current files were made with Pillow 10.2.0
and node 22.

`generate.py` does not touch the hand-written files (`configure.sh`,
`moz.build`, `jar.mn`, `brand.*`, prefs, CSS, `branding.nsi`, manifests). It
also skips `dsstore`, which is regenerated with:

```sh
python3 -m venv /tmp/dsenv && /tmp/dsenv/bin/pip install ds_store mac_alias
/tmp/dsenv/bin/python branding/tools/make_dsstore.py
```

The dsstore expects the dmg volume to be named **Amaya** (=
`MOZ_APP_DISPLAYNAME`), the app to be **Amaya.app** at (209, 190), and the
Applications link at (472, 190). `background.png` is drawn for that layout.

## Placeholder URLs (replace before release)

All of these use the reserved `.invalid` TLD, so they can never resolve:

| Where | Key | Placeholder |
|---|---|---|
| `amaya/pref/firefox-branding.js` | `app.update.url.manual` | `https://amaya-browser.invalid/download/` |
| ″ | `app.update.url.details` | `https://amaya-browser.invalid/releases/` |
| ″ | `app.releaseNotesURL`, `.aboutDialog`, `.prompt` | `https://amaya-browser.invalid/releases/%VERSION%/` |
| `amaya/branding.nsi` | `URLInfoAbout` | `https://amaya-browser.invalid/` |
| ″ | `HelpLink` | `https://amaya-browser.invalid/support/` |
| ″ | `URLStubDownload{X86,AMD64,AArch64}` | `https://amaya-browser.invalid/download/?os=…&lang=${AB_CD}` |
| ″ | `URLManualDownload` | `https://amaya-browser.invalid/download/?installer_lang=${AB_CD}` |
| ″ | `URLSystemRequirements` | `https://amaya-browser.invalid/system-requirements/` |
| ″ | `CertNameDownload` / `CertIssuerDownload` | `Amaya` (set to the real Windows signing cert) |

Removed from the template: every `mozilla.org`, `firefox.com` and
`nightly.mozilla.org` URL, and `utm_*` tracking parameters. The welcome and
"what's new" pages (`startup.homepage_*`) are empty, so nothing opens on first
run or after an update.

The support URL (`app.support.baseURL`, which points at support.mozilla.org) is
**not** a branding pref. It is set in `browser/app/profile/firefox.js`, and
`settings/` is the place to override it.
