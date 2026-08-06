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
pnpm content:gen          # generate/refresh the question bank from Wikidata (writes data/ + apps/web/public/)
#   PINPOINT_FETCH=curl pnpm content:gen   # if Node can't open sockets (some sandboxes)
#   Responses are cached in tools/content-gen/.cache/ — delete it to force a refresh.
#   Curated fact-obscurity questions live in data/trivia.curated.json and are merged in.
pnpm dev:web             # run the web app locally
pnpm dev:playable        # run the Playable locally
pnpm test                # unit tests
pnpm og                  # regenerate the social share card (apps/web/public/og.png)
```

## Tests
```bash
pnpm test                                  # everything (core + map + content-gen)
pnpm --filter @pinpoint/core test          # game rules, scoring, streaks, trophies
pnpm --filter @pinpoint/map test           # hit-testing, labels, zoom, distance/bearing, reveal colours
pnpm --filter @pinpoint/content-gen test   # question building + the validator's own checks

# one file, while iterating
cd packages/map && node --test --experimental-strip-types src/render.test.ts
```
`apps/web` has no test script — the Svelte view has no test harness, so game logic is deliberately
kept in `packages/core` / `packages/map` where it can be tested. Its cover is `svelte-check`.

The full pre-commit sweep:
```bash
pnpm test && \
  pnpm --filter @pinpoint/web exec svelte-check --tsconfig ./tsconfig.json && \
  pnpm --filter @pinpoint/web build && \
  pnpm validate
```

## Validating the question bank
`pnpm validate` checks the *content* rather than the code, and only ever reports — it never exits
non-zero, so it will not block anything.

```bash
pnpm validate                                 # structural checks only, no network, ~1s
PINPOINT_NO_CACHE=1 pnpm validate --drift     # also re-fetch every source and diff (~20 min)
```

**Structure (14 checks)** — the invariants that would otherwise be re-verified by hand after each
regeneration: 3 questions a day in easy→medium→hard order, every day has a bonus, no duplicate ids,
no repeated answer country per day, every answer (and every `acceptedIso`) is drawn on the map so it
can actually be tapped, no internal fields leaked into the shipped JSON, prompts start with a
capital, flag questions have their SVG, the per-day category rule holds, dates are contiguous, and
the calendar still covers today with runway to spare (WARN under 180 days, FAIL under 60 — the game
breaks silently once it runs out).

**Drift** — rebuilds the candidate pool from source and diffs it against what shipped. Question ids
encode `${clueType}-${slug(value)}-${iso}`, so an answer that has changed appears as a live clue
prefix pointing at a *different* country (FAIL), as distinct from a clue that is simply no longer
generated (WARN). `PINPOINT_NO_CACHE=1` is required: without it the run compares fresh output
against the same cached rows and always reports "no change". A rate-limited source degrades to a
warning rather than failing the run — retry later.

## Dev tools (web app, `pnpm dev` only — stripped from production builds)
A **⚙ Dev** button in the header opens a dev menu with:
- **Reset progress** — wipes local XP/streak/history so you can replay.
- **Unlimited questions** — bypasses the daily 3-question limit and replays endlessly (XP still accrues), for testing leveling/trophies. The toggle persists across resets.

The map also has **＋/－ zoom buttons** (desktop only; touch devices use pinch).

**Hosted dev build:** CI publishes a second build with dev tools enabled to `/<repo>/dev/`
(e.g. `https://chiragmadaan.github.io/pinpoint/dev/`) alongside the clean production site at
`/<repo>/`. The dev build is flagged via `VITE_DEV_TOOLS=1` and uses a **separate `localStorage`
key** (`pinpoint.player.dev`) so testing there never touches real progress on the prod site.

## Key platform constraints (why the map is self-contained)
YouTube Playables forbids **all external network calls** except Google/YouTube APIs, forbids
external links and off-platform payments, and forbids accounts/PII. So the Playable is a
self-contained SPA with a **vector** map (no tiles/Street View), progress saved via the YouTube
SDK, and it funnels out only via `openYTContent()` → a YouTube video whose description links to
the web app. See the research doc above for the full sourced list.
