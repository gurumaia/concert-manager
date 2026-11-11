// Local dev server: in-memory data, header-based auth.  `DEV_AUTH=1 npm run dev`
import { existsSync, readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { composeApp } from "./compose.js";
import { loadConfig } from "./infra/config.js";

process.env.DEV_AUTH ??= "1";
const port = Number(process.env.PORT ?? 8787);
const cfg = loadConfig();
// The MCP App page, if the frontend has been built (`npm run build:app` in frontend/).
const triagePath = new URL("../../frontend/dist-app/app.html", import.meta.url);
const triageHtml = existsSync(triagePath) ? readFileSync(triagePath, "utf8") : undefined;
const { app } = composeApp({ ...cfg, publicBaseUrl: cfg.publicBaseUrl || `http://localhost:${port}` }, { triageHtml });
serve({ fetch: app.fetch, port }, () => console.log(`show-manager api on http://localhost:${port} (dev auth: send x-dev-user)`));
