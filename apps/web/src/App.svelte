<script lang="ts">
  // Web surface reuses the exact same @pinpoint/core engine and @pinpoint/map as the Playable.
  // Differences to add here (not in the Playable): direct share links to this domain,
  // localStorage persistence, and — post-traction — accounts/leaderboards/payments (Supabase).
  import { buildShareText } from "@pinpoint/core";

  // Placeholder wiring; mirror apps/playable/src/App.svelte for the game loop.
  const demoShare = buildShareText("2026-07-24", ["correct", "neighbor", "wrong"], 5, "https://geoquiz.example");
</script>

<main>
  <h1>🌍 Geo Quiz</h1>
  <p>Same engine as the Playable, plus accounts &amp; monetization live here.</p>
  <pre>{demoShare}</pre>
</main>
