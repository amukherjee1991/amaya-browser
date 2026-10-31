// Amaya Browser: load settings/amaya.cfg as an autoconfig file.
// Installed as <appdir>/defaults/pref/autoconfig.js.
pref("general.config.filename", "amaya.cfg");
pref("general.config.obscure_value", 0);
// Run amaya.cfg in the restricted autoconfig sandbox (only pref functions,
// no XPCOM). Firefox enables it by default only for the release/beta update
// channels, so set it explicitly.
pref("general.config.sandbox_enabled", true);
