# Amaya Browser

A privacy-first browser built as a thin, auditable layer on Firefox's Gecko engine.
Zero telemetry, strict tracking protection, uBlock Origin built in, and (later) a
workspace-centric UI. Debian/Linux first, then macOS.

* Plan: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md)
* Upstream pin: [upstream.json](upstream.json)

## Quick start (Debian / Ubuntu, x86_64)

```sh
tools/amaya fetch       # download + verify Firefox source into engine/
tools/amaya bootstrap   # install Mozilla toolchains into ~/.mozbuild (once)
tools/amaya import      # apply branding, settings and patches/ to engine/
tools/amaya build       # compile (≈1 h on 24 cores the first time)
tools/amaya run         # launch the built browser
tools/amaya package     # produce dist/*.deb and dist/*.tar.xz
```

## License

Amaya's own code is under the Mozilla Public License 2.0, same as Firefox.
"Firefox" and the Firefox logo are Mozilla trademarks and are not used in Amaya builds.
