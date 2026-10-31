// Amaya Browser: load settings/amaya.cfg as an autoconfig file.
// Installed as <appdir>/defaults/pref/autoconfig.js.
pref("general.config.filename", "amaya.cfg");
pref("general.config.obscure_value", 0);
// Run amaya.cfg unsandboxed (privileged). Needed to load the Amaya workflow
// UI (amaya-ui/loader.js, see ui/README.md) into browser windows. amaya.cfg
// and amaya-ui/ are our own files in the install directory, writable only by
// whoever can already replace the browser binary, so this adds no new attack
// surface. Set explicitly: Firefox sandboxes it on release/beta channels.
pref("general.config.sandbox_enabled", false);
