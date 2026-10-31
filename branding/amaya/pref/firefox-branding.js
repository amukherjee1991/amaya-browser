/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This file contains branding-specific prefs for Amaya.
// It is NOT preprocessed (non-official branding uses JS_PREFERENCE_FILES), so
// no #if/#ifdef here.
//
// Every URL below is a placeholder on the reserved .invalid TLD so nothing can
// resolve until real Amaya pages exist. See branding/README.md for the list.

// No welcome / "what's new" pages are opened automatically (no network).
pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");

// The time interval between checks for a new version (in seconds).
// (The app updater is compiled out on Linux; updates come from apt.)
pref("app.update.interval", 86400); // 24 hours
// Give the user x seconds to react before showing the big UI. default=192 hours
pref("app.update.promptWaitTime", 691200);
// URL user can browse to manually if for some reason all update installation
// attempts fail.
pref("app.update.url.manual", "https://amaya-browser.invalid/download/");
// A default value for the "More information about this update" link
// supplied in the "An update is available" page of the update wizard.
pref("app.update.url.details", "https://amaya-browser.invalid/releases/");
// Release notes links (Help menu, About dialog, update prompt).
pref("app.releaseNotesURL", "https://amaya-browser.invalid/releases/%VERSION%/");
pref("app.releaseNotesURL.aboutDialog", "https://amaya-browser.invalid/releases/%VERSION%/");
pref("app.releaseNotesURL.prompt", "https://amaya-browser.invalid/releases/%VERSION%/");

// The number of days a binary is permitted to be old
// without checking for an update.  This assumes that
// app.update.checkInstallTime is true.
pref("app.update.checkInstallTime.days", 63);

// Give the user x seconds to reboot before showing a badge on the hamburger
// button. default=4 days
pref("app.update.badgeWaitTime", 345600);

// Number of usages of the web console.
// If this is less than 5, then pasting code into the web console is disabled
// (self-XSS protection stays on, as in release builds).
pref("devtools.selfxss.count", 0);
