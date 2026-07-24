# Geo Quiz — Daily Geography Map Game

Read a clue → tap the answer country on a world map. Wordle's daily habit + GeoGuessr's map skill.

- **Design:** [`docs/plans/2026-07-23-geo-quiz-game-design.md`](docs/plans/2026-07-23-geo-quiz-game-design.md)
- **Platform research (read this before touching the Playable):** [`docs/research/2026-07-24-youtube-playables-and-geoguessr-research.md`](docs/research/2026-07-24-youtube-playables-and-geoguessr-research.md)

## MVP scope (v0)
Free daily loop only: 3 shared questions/day (easy→medium→hard) + local XP/streak.
No accounts, payments, PvP, or backend. **Running cost: ~$0** (static hosting).

## Structure
```
packages/core        Shared TS engine: types, scoring, daily-picker (no framework)
packages/map         d3-geo + topojson world map: Canvas render + tap hit-testing
apps/playable        YouTube Playable — Svelte + Vite + ytgame SDK (lean SPA)
apps/web             Standalone web app — Svelte + Vite (own share links, monetization later)
tools/content-gen    Node script: Wikidata SPARQL → data/questions.json (run offline)
data/                Static question calendar shipped as an asset
```

## Getting started
```bash
pnpm install
pnpm content:gen          # generate/refresh data/questions.json from Wikidata
pnpm dev:web             # run the web app locally
pnpm dev:playable        # run the Playable locally
pnpm test                # unit tests (scoring, daily-picker)
```

## Key platform constraints (why the map is self-contained)
YouTube Playables forbids **all external network calls** except Google/YouTube APIs, forbids
external links and off-platform payments, and forbids accounts/PII. So the Playable is a
self-contained SPA with a **vector** map (no tiles/Street View), progress saved via the YouTube
SDK, and it funnels out only via `openYTContent()` → a YouTube video whose description links to
the web app. See the research doc above for the full sourced list.
