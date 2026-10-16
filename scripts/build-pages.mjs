// Builds a drag-and-drop bundle for Cloudflare Pages (dashboard → Workers & Pages → Create → Pages → Upload assets).
// Output: dist-pages/ (static files + _worker.js in advanced mode) and jaad-franchise-pages.zip.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "dist-pages");
const zip = join(root, "jaad-franchise-pages.zip");
rmSync(out, { recursive: true, force: true });
if (existsSync(zip)) rmSync(zip);
mkdirSync(out, { recursive: true });

cpSync(join(root, "public"), out, { recursive: true });
await build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(out, "_worker.js"),
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  minify: true,
  legalComments: "none",
});
// Only API and form requests run the Worker; everything else is served as a static file.
writeFileSync(join(out, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*", "/apply"], exclude: [] }, null, 2));
execFileSync("zip", ["-qr", zip, "."], { cwd: out });
console.log(`built ${out} and ${zip}`);
