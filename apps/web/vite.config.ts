import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Standalone web app — no Playables constraints here. Add its own share links, later a backend.
// GitHub Pages project sites live under /<repo>/, so production assets need that base path.
// Dev stays at "/". Override the repo name via BASE_PATH env if the repo isn't named "pinpoint".
export default defineConfig(({ command }) => ({
  base: command === "build" ? (process.env.BASE_PATH ?? "/pinpoint/") : "/",
  plugins: [svelte()],
}));
