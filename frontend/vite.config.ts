/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Link-preview tags. Crawlers (WhatsApp, iMessage, Slack) do not run scripts and need an absolute image URL, so the site's
 * origin is baked in at build time from SITE_ORIGIN (deploy.sh and CI set it from env/<env>.params). Without it (local builds) no tags are added.
 */
const linkPreview = (): Plugin => ({
  name: "link-preview",
  transformIndexHtml(html) {
    const origin = loadEnv("", ".", "SITE_ORIGIN").SITE_ORIGIN?.replace(/\/+$/, "");
    if (!origin) return html;
    const tags = [
      ["og:type", "website"], ["og:site_name", "Show Manager"], ["og:title", "Show Manager"],
      ["og:description", "Keep track of the concerts you go to, and relive them in a recap."],
      ["og:image", `${origin}/og-image.png`], ["og:image:width", "1200"], ["og:image:height", "630"],
    ].map(([k, v]) => `    <meta property="${k}" content="${v}" />`);
    tags.push(`    <meta name="twitter:card" content="summary_large_image" />`, `    <meta name="twitter:image" content="${origin}/og-image.png" />`);
    return html.replace("</title>", `</title>\n${tags.join("\n")}`);
  },
});

// In dev the API runs separately (`npm run dev` in backend/, port 8787) with header-based auth.
export default defineConfig({
  plugins: [react(), linkPreview()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  test: { environment: "jsdom" },
});
