import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error type error without @types/node package
import { join } from "node:path";
const host = process.env.TAURI_DEV_HOST;

// public/help.html is copied without transformation, so fill in the app
// version from package.json when the page is served in dev or written to dist.
function helpVersion(): Plugin {
  const version: string = JSON.parse(readFileSync("package.json", "utf8")).version;
  const fill = (html: string) => html.replaceAll("%APP_VERSION%", version);
  return {
    name: "dbdock-help-version",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        // Without @types/node the request type has no `url`.
        const url = (request as { url?: string }).url;
        if (url?.split(/[?#]/)[0] !== "/help.html") return next();
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(fill(readFileSync("public/help.html", "utf8")));
      });
    },
    writeBundle(options) {
      const file = join(options.dir ?? "dist", "help.html");
      writeFileSync(file, fill(readFileSync(file, "utf8")));
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), helpVersion()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
