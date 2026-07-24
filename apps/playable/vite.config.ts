import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Playables require a single self-contained bundle, no code obfuscation, small size.
export default defineConfig({
  plugins: [svelte()],
  build: {
    target: "es2020",
    minify: "esbuild", // minify OK; obfuscation is NOT (would fail certification)
    rollupOptions: {
      output: { inlineDynamicImports: true }, // single bundle
    },
  },
});
