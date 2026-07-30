import { readFileSync } from "node:fs";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Single source of truth for the app version is this package.json; injected at build time below.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Short commit SHA for traceability — GitHub Actions sets GITHUB_SHA; empty locally.
const sha = (process.env.GITHUB_SHA ?? "").slice(0, 7);

// Standalone web app — no Playables constraints here. Add its own share links, later a backend.
// GitHub Pages project sites live under /<repo>/, so production assets need that base path.
// Dev stays at "/". Override the repo name via BASE_PATH env if the repo isn't named "pinpoint".
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.BASE_PATH ?? "/pinpoint/") : "/",
  // Expose via import.meta.env (Svelte/Vite recognise it — no "undefined global" warnings).
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
    "import.meta.env.VITE_BUILD_SHA": JSON.stringify(sha),
  },
  plugins: [svelte()],
}));
