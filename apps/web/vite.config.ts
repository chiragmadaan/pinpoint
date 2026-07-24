import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Standalone web app — no Playables constraints here. Add its own share links, later a backend.
export default defineConfig({
  plugins: [svelte()],
});
