import type { HmrOptions } from "vite";
import { defineConfig } from "vite";
import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function getHmrOptions(host: string | undefined): HmrOptions | undefined {
  if (host !== undefined && host !== "") {
    return { host, port: 1421, protocol: "ws" };
  }
  return undefined;
}

const hmr = getHmrOptions(process.env.TAURI_DEV_HOST);

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        recording: path.resolve(import.meta.dirname, "recording.html"),
      },
    },
  },
  clearScreen: false,
  plugins: [
    react({
      babel: {
        plugins: [["babel-plugin-react-compiler", { panicThreshold: "none", target: "19" }]],
      },
    }),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    hmr,
    host: hmr?.host ?? false,
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
