// Builds the extension into dist/ (load it unpacked from there).
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "dist");
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
