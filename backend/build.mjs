// Bundles the Lambda into dist/lambda.mjs (the AWS SDK v3 clients are provided by the nodejs22.x runtime).
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
  // The runtime provides the AWS SDK clients; the S3 presigner is bundled so it does not depend on being present there.
  external: ["@aws-sdk/client-*", "@aws-sdk/lib-dynamodb"],
  banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});
