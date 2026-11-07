/** Build the credential-free validation host from the shipped renderer. */
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(desktop, ".delphi-build/artifact-validator");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(desktop, "frontend/app/artifact-validator/host.tsx")],
  outfile: resolve(output, "host.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  legalComments: "inline",
  loader: { ".woff2": "dataurl", ".ttf": "dataurl" },
  plugins: [{
    name: "local-theme-fonts",
    setup(builder) {
      // The real global stylesheet uses app-root font paths. Embed those
      // same local bytes so this isolated host never needs a font server.
      builder.onResolve({ filter: /^\/fonts\// }, args => ({ path: resolve(desktop, "frontend/public", args.path.slice(1)) }));
      // KaTeX lists woff2 first; a browser that has it never asks for the older formats.
      builder.onResolve({ filter: /KaTeX_[\w-]+\.(?:woff|ttf)$/ }, args => ({ path: args.path, external: true }));
      builder.onResolve({ filter: /^tailwindcss$/ }, args => args.kind === "import-rule"
        ? { path: resolve(desktop, "frontend/node_modules/tailwindcss/index.css") } : undefined);
    },
  }],
});
const hash = value => createHash("sha256").update(value).digest("hex");
const files = {};
const combined = createHash("sha256");
for (const name of ["host.js", "host.css"]) {
  const bytes = await readFile(resolve(output, name));
  files[name] = hash(bytes);
  combined.update(name).update("\0").update(bytes).update("\0");
}
await writeFile(resolve(output, "manifest.json"), JSON.stringify({ version: 1, runtimeHash: combined.digest("hex"), files }, null, 2) + "\n");
