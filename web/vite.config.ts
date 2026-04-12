import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
