// Bundles the spreadsheet parser's dynamic worker (src/fork/workbook-parser-runtime.ts), SheetJS
// included, into src/generated/workbook-parser-runtime.txt. Run from build-browser-runtime.ts,
// beside the other generated runtimes; kept out of that file so the fork's build step stays one
// import there.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputFile = resolve(packageDir, "src/generated/workbook-parser-runtime.txt");

const result = await build({
  entryPoints: [resolve(packageDir, "src/fork/workbook-parser-runtime.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker"],
  target: "es2025",
  minify: true,
  external: ["cloudflare:workers"],
  write: false,
});

const contents = new TextDecoder().decode(result.outputFiles[0].contents);
if (!existsSync(outputFile) || readFileSync(outputFile, "utf8") !== contents) {
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, contents);
}
