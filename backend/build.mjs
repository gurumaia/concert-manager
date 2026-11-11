// Bundles the Lambda into dist/lambda.mjs (AWS SDK v3 is provided by the nodejs22.x runtime).
import { build } from "esbuild";
import { rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  loader: { ".html": "text" },
  external: ["@aws-sdk/*"],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
