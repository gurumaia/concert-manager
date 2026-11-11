// Local dev server: in-memory data, header-based auth.  `DEV_AUTH=1 npm run dev`
import { serve } from "@hono/node-server";
import { composeApp } from "./compose.js";
import { loadConfig } from "./infra/config.js";

process.env.DEV_AUTH ??= "1";
const port = Number(process.env.PORT ?? 8787);
const cfg = loadConfig();
const { app } = composeApp({ ...cfg, publicBaseUrl: cfg.publicBaseUrl || `http://localhost:${port}` });
serve({ fetch: app.fetch, port }, () => console.log(`show-manager api on http://localhost:${port} (dev auth: send x-dev-user)`));
