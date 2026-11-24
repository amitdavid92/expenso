import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In development the API runs in `wrangler dev`; in production the Worker
    // serves both the API and these built assets from one origin.
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
