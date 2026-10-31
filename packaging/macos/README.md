# macOS packaging (Phase M plan)

Nothing here runs yet. macOS work starts after Debian passes Gate 1 (see
`docs/DEVELOPMENT_PLAN.md`). It needs an Apple Silicon Mac as build host and an
Apple Developer ID (team ID, "Developer ID Application" certificate,
App Store Connect API key for notarization).

## 1. Build

`tools/amaya build` with `configs/macos/mozconfig`, then `./mach package`
produces `dist/Amaya.app`. arm64 comes first; x86_64 next. A universal build
can be made later by `lipo`-merging the two (as Mozilla does).

## 2. Code signing (hardened runtime)

Every Mach-O must be signed from the inside out (dylibs, helper apps,
`plugin-container`, then the main bundle), with `--options runtime` and a
secure timestamp. Mozilla's own entitlement files are in the engine at
`security/mac/hardenedruntime/production/`. The ones Amaya needs, checked
against Firefox 159.0:

**Main browser executable** (`Contents/MacOS/amaya`), from `firefox.browser.xml`:

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | JIT: executable pages with `MAP_JIT` (needed on arm64) |
| `com.apple.security.cs.disable-library-validation` | Load third-party PKCS#11 modules (smart cards, corporate CAs) |
| `com.apple.security.device.audio-input` | Microphone, for sites the user allows |
| `com.apple.security.device.camera` | Camera, for sites the user allows |
| `com.apple.security.device.usb` | WebSerial over USB |
| `com.apple.security.personal-information.location` | Geolocation, for sites the user allows |
| `com.apple.security.smartcard` | SmartCardServices |
| `com.apple.application-identifier` = `<TEAMID>.org.amaya.Browser` | Required by the passkey entitlement below |
| `com.apple.developer.web-browser.public-key-credential` | Platform passkeys (WebAuthn). Needs a provisioning profile with this capability from Apple; drop it until we have one |

**Child processes**

| Binary | Entitlements | Source file |
|---|---|---|
| `plugin-container.app` (content, GPU, socket, RDD, utility) | `cs.allow-jit` | `plugin-container.xml` |
| media plugin helper (GMP / Widevine) | `cs.disable-library-validation` | `media-plugin-helper.xml` |
| security module helper | `cs.disable-library-validation`, `smartcard` | `security-module-helper.xml` |

Keep a copy of these as `packaging/macos/entitlements/*.plist` with
`43AQ936H96.org.mozilla.firefox` replaced by our team ID + `org.amaya.Browser`.
**Do not add** `cs.allow-unsigned-executable-memory`, `cs.disable-executable-page-protection`
or `get-task-allow` to release builds. They weaken the hardened runtime, and
the plan forbids weakening the sandbox.

Sketch:

```sh
IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
ENT=packaging/macos/entitlements
APP=dist/Amaya.app
# inner code first
find "$APP/Contents" -type f \( -name '*.dylib' -o -perm -u+x \) ! -path '*/MacOS/amaya' \
  -exec codesign --force --options runtime --timestamp --sign "$IDENTITY" {} \;
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  --entitlements "$ENT/plugin-container.plist" "$APP/Contents/MacOS/plugin-container.app"
# … media-plugin-helper / security-module-helper likewise …
codesign --force --options runtime --timestamp --sign "$IDENTITY" \
  --entitlements "$ENT/browser.plist" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
```

Mozilla's signing configuration lists the exact order and paths. Follow it
rather than this sketch once we have a Mac.

## 3. Disk image

Either `create-dmg` (`brew install create-dmg`), which gives a background image
and an `/Applications` symlink:

```sh
create-dmg --volname "Amaya" --window-size 540 380 --icon-size 128 \
  --icon "Amaya.app" 140 190 --app-drop-link 400 190 \
  dist/Amaya-159.0-1-arm64.dmg dist/Amaya.app
```

or plain `hdiutil`:

```sh
hdiutil create -volname Amaya -srcfolder dist/Amaya.app -ov -format UDZO \
  dist/Amaya-159.0-1-arm64.dmg
```

Sign the dmg too: `codesign --sign "$IDENTITY" --timestamp dist/*.dmg`.

## 4. Notarization

```sh
xcrun notarytool store-credentials amaya-notary \
  --key AuthKey_XXXX.p8 --key-id <KEY_ID> --issuer <ISSUER_UUID>   # once
xcrun notarytool submit dist/Amaya-159.0-1-arm64.dmg \
  --keychain-profile amaya-notary --wait
xcrun stapler staple dist/Amaya-159.0-1-arm64.dmg
spctl --assess --type open --context context:primary-signature -vv dist/Amaya-159.0-1-arm64.dmg
```

Gate M: a clean macOS VM opens the stapled dmg with no Gatekeeper warning,
Amaya launches, and the idle-traffic test (`tests/privacy/run.sh`) passes.

## 5. Updates and distribution

* Homebrew cask: template in [`amaya.rb.template`](amaya.rb.template). Publish
  it in our own tap (`<owner>/homebrew-amaya`). A cask in `homebrew/cask` comes
  after 1.0.
* In-app updates: Mozilla's updater pointed at an Amaya-hosted static update
  manifest with no identifiers in the request (plan §3).
* A `macos-arm64` build runner can be added later, once CI exists. Builds are
  manual until then.
