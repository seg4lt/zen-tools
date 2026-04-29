import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      // Don't reload when files inside the Rust crate or the user-facing
      // `examples/` directory change — examples are runtime fixtures, not
      // frontend source, and editing them in-app would otherwise trigger
      // a full HMR refresh on every keystroke.
      ignored: ["**/src-tauri/**", "**/examples/**"],
    },
  },
}));
