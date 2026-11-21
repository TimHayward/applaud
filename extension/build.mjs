// Builds the extension into dist/ (load it unpacked from there).
// `node build.mjs automation` builds the automation extension for the browser
// container into dist-automation/ instead; the desktop build is unaffected.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const automation = process.argv[2] === "automation";
const out = path.join(here, automation ? "dist-automation" : "dist");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  target: "chrome116",
  logLevel: "info",
  legalComments: "none",
  minify: false,
  sourcemap: false,
};
if (automation) {
  await build({
    ...common,
    entryPoints: [path.join(here, "src/automation/worker.ts")],
    outfile: path.join(out, "worker.js"),
    format: "esm",
  });
  await build({
    ...common,
    entryPoints: [path.join(here, "src/content.ts")],
    outfile: path.join(out, "content.js"),
    format: "iife",
  });
  cpSync(path.join(here, "static", "icons"), path.join(out, "icons"), { recursive: true });
  cpSync(path.join(here, "static-automation"), out, { recursive: true });
  // Applaud's credential arrives here from the volume the browser container mounts.
  mkdirSync(path.join(out, "secret"), { recursive: true });
  setVersion();
  process.exit(0);
}

await build({
  ...common,
  entryPoints: [path.join(here, "src/background.ts")],
  outfile: path.join(out, "background.js"),
  format: "esm",
});
// Content scripts and the popup's classic <script> can't be modules.
await build({
  ...common,
  entryPoints: [path.join(here, "src/content.ts")],
  outfile: path.join(out, "content.js"),
  format: "iife",
});
await build({
  ...common,
  entryPoints: [path.join(here, "src/popup.ts")],
  outfile: path.join(out, "popup.js"),
  format: "iife",
});
cpSync(path.join(here, "static"), out, { recursive: true });

setVersion();

// The extension carries the version of the Applaud release it was built with.
function setVersion() {
  const { version } = JSON.parse(readFileSync(path.join(here, "package.json"), "utf8"));
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
