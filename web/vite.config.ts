import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 44470,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:44471", changeOrigin: false },
      "/media": { target: "http://127.0.0.1:44471", changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
