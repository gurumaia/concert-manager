/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API runs separately (`npm run dev` in backend/, port 8787) with header-based auth.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": "http://localhost:8787" } },
  test: { environment: "jsdom" },
});
