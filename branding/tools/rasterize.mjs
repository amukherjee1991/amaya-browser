// Rasterise SVG documents to PNG with resvg (deterministic, no system fonts).
//
// Usage: node rasterize.mjs <jobs.json>
//   jobs.json: [{"svg": "<svg ...>", "width": 256, "height": 256, "out": "/abs/file.png"}, ...]
//
// @resvg/resvg-js is resolved from $AMAYA_RESVG_NODE_PATH (a directory that
// contains node_modules/@resvg/resvg-js); generate.py sets this up in a cache
// directory outside the repository.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const base = process.env.AMAYA_RESVG_NODE_PATH;
if (!base) {
  console.error("AMAYA_RESVG_NODE_PATH is not set");
  process.exit(2);
}
const require = createRequire(join(base, "package.json"));
const { Resvg } = require("@resvg/resvg-js");

const jobs = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const job of jobs) {
  const resvg = new Resvg(job.svg, {
    fitTo: { mode: "width", value: job.width },
    font: { loadSystemFonts: false },
    shapeRendering: 2, // geometricPrecision (anti-aliased)
  });
  const img = resvg.render();
  if (img.width !== job.width || img.height !== job.height) {
    console.error(
      `${job.out}: rendered ${img.width}x${img.height}, expected ${job.width}x${job.height}`
    );
    process.exit(1);
  }
  mkdirSync(dirname(job.out), { recursive: true });
  writeFileSync(job.out, img.asPng());
}
