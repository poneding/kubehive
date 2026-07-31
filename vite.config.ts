import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const appVersion = process.env.npm_package_version ?? "0.1.0";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  define: { __KUBEHIVE_VERSION__: JSON.stringify(appVersion) },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
