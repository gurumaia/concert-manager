import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The MCP App page: the Shows page bundled with its JS and CSS inlined into ONE html file
// (dist-app/app.html), which the MCP server serves as ui://show-manager/triage.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: "dist-app",
    emptyOutDir: true,
    rollupOptions: { input: "app.html" },
  },
});
