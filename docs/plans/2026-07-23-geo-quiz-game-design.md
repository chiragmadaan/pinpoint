# Pinpoint — Design

**Date:** 2026-07-23 (updated 2026-07-24)
**Status:** Design (implementation started — web-first)
**One-liner:** A daily **general-knowledge + geography** quiz where you read a clue and tap the answer country on a world map — Wordle's daily habit + GeoGuessr's map skill, built to be shared.

> **Positioning note (why GK + geography, not geography alone):** blending general knowledge with
> geography makes the question space effectively infinite (anthems, nicknames, superlatives, history,
> culture — all resolving to a country on the map). This solves content longevity *and* is a
> genuine moat: a pure-geography clone is easy; a well-curated GK+geography question bank is not.

---

## 1. Concept & Core Loop

**Name:** **Pinpoint** (chosen). Memorable + searchable — load-bearing for the leaky funnel (§4). *TODO: trademark + domain clearance before launch.*

### The daily loop (free — the growth engine)
1. Open game → see today's date + current streak.
2. **3 shared questions** — the *same for every player worldwide* each day, in a fixed **easy → medium → hard** difficulty arc.
3. Per question: text/flag clue at top; pannable/zoomable world map below. Player selects a country, then submits (see §5).
4. After Q3: **results card** — score, per-question 🟩/🟨/⬛ grid, streak, and a **Share** button (spoiler-free grid + link).
5. "Come back tomorrow" + countdown to next daily.

### Why shared (not personalized) difficulty
Personalized difficulty maximizes skill-fit but **kills shareability** — the thing that made Wordle viral. Since growth depends on free organic sharing, everyone gets the **same** puzzle. Difficulty is expressed as an **arc within the day** (Q1 easy → everyone gets a win; Q3 hard → experts still challenged), not per-player gating.

### Scoring & XP (staggered by difficulty)
- Correct answer earns **staggered XP**: **easy 200 · medium 400 · hard 600** (`DIFFICULTY_XP` in `packages/core`).
- A **land-bordering** country is recognized as "Close — a neighbor!" but earns **0 points** (`neighborFraction: 0`). The feedback softens the miss; the score does not reward it. Adjacency is a static alpha-3 border dataset (`apps/web/public/adjacency.json`, generated from mledoze/countries). **Decision (2026-07-24): land borders only** — maritime neighbors (Japan↔South Korea, UK↔France) do **not** count as "Close", and island nations with no land borders (e.g. the Bahamas) have no neighbors at all. This is intentional, not a bug.
- **No speed bonus** (removed — XP is purely difficulty-based).
- **No per-answer XP popup.** Instead, an **XP bar** fills as you answer.

### Levels (XP bar + level-up)
- Player **starts at Level 1**. Levels are **numeric and infinite**. The XP bar shows progress within the current level; when it fills, the level goes up and the bar resets.
- **Curve:** XP to clear level `L` = `1000 + (L-1)*500` (L1→2 = 1000, L2→3 = 1500, L3→4 = 2000, …). A perfect day = 1200 XP (200+400+600), so early levels take ~1 day and later ones slow gently. Implemented as `levelForXp()` / `xpToClearLevel()` in `packages/core/levels.ts`.

### Trophies (collectible milestone badges)
- Themed **trophies** unlock at level thresholds and accumulate on a shelf — the shareable, brandable
  layer on top of the plain numeric level. Current ladder: 🐣 Noob (Lv1) · 🧭 Wanderer (Lv3) ·
  🗺️ Explorer (Lv5) · 🧗 Pathfinder (Lv8) · ⛵ Navigator (Lv11) · 🌍 Globetrotter (Lv15) ·
  🚀 Voyager (Lv19) · 📐 Cartographer (Lv23) · 📚 Geographer (Lv28) · 🌎 Continental (Lv34) ·
  🏆 Atlas (Lv40) · 👑 World Master (Lv45) · 🏅 Legend (Lv50). Add more freely — levels are infinite,
  trophies are curated milestones. `TROPHIES` / `trophiesEarned()` / `latestTrophy()` /
  `trophiesUnlockedBetween()` in `packages/core/levels.ts`.
- The **latest trophy + level** are included on the share card (growth hook).

### Progression = meta-layer (not a difficulty gate)
Daily results feed **XP → rank**, a **streak**, and **country mastery** (each country you correctly involve lights up on a personal globe). Progression rewards consistency/accuracy and is the thing worth syncing to a web account. It never changes which questions you see.

### Difficulty examples
- **Easy:** "Locate France."
- **Medium:** "Country whose capital is Paris" / "Country whose flag is [image]."
- **Hard (geography):** "Country where the Ganga meets the ocean" / "Country where [figure] was born."
- **Hard (general knowledge — the moat):**
  - "Country whose national anthem starts with the word 'God'."
  - "Country with the highest Muslim population." *(superlative — time-sensitive, see below)*
  - "Country with the most glaciers." *(superlative — time-sensitive)*
  - "Country once known as the 'Pirate Republic'." *(nickname/history)*

### Clue taxonomy & the time-sensitivity rule
Two families of clue:
- **Static facts** (capital, river mouth, flag, border, nickname, historical anthem) — verify once, reuse forever.
- **Superlatives / "most-X" facts** — can change year to year. These MUST carry a **dated source
  (`asOf`)**, be flagged `timeSensitive`, and be **re-validated before reuse**. Encoded in
  `Question.timeSensitive` / `Question.asOf` in `packages/core`.

---

## 2. Content Engine (the question factory)

Nearly every clue type maps to structured, verifiable facts in **Wikidata**, so the question bank is **generated programmatically**, not hand-written.

### Clue templates → data source
| Clue | Wikidata source |
|------|-----------------|
| "Locate X" (easy) | country list |
| "Capital is X" (medium) | `capital` |
| "Flag is [img]" (medium/hard) | flag images (public domain) |
| "River X meets the ocean" (hard) | `mouth of watercourse` → country |
| "[figure] born here" (hard) | `place of birth` → country |
| currency / language / landmark / "borders both X and Y" / outline shape | respective properties |

### Pipeline (implemented — `tools/content-gen`)
1. **Generate** candidates by querying Wikidata per template (`sparql()` with on-disk cache; Node `fetch` by default, `PINPOINT_FETCH=curl` fallback for sandboxes).
2. **Validate automatically** — a value is kept only if it maps to **exactly one country**; a value shared by 2+ countries is dropped. A country may appear in multiple questions (South Africa's 3 capitals → 3 questions). Answers are also **intersected with the map dataset** (`countries.geo.json`, ~168 usable) so every answer is tappable.
3. **Rank difficulty** by **country obscurity** (Wikipedia **sitelink count** as the fame signal) combined with a per-clue-type weight, split into easy/medium/hard **terciles**.
4. **Curated trivia** (`data/trivia.curated.json`) is merged in with **author-set difficulty** — this is how *fact-obscurity* questions (e.g. "Where was the Boer War fought?" → ZAF) get graded, since fact obscurity can't be auto-derived.
5. **Schedule** into a no-repeat daily calendar (`assembleCalendar`): 1 easy + 1 medium + 1 hard/day, **every question used at most once**, no country repeated within a 45-day window, 3 distinct countries per day. Stops when a tier runs dry (never silently repeats).

**Auto clue types (Wikidata):**
- *Country-attribute* (one per country): locate, flag (emoji), capital (P36), currency *unit* (P38), official language (P37), calling code (P474), internet TLD (P78, ASCII ccTLDs only), highest point (P610).
- *Entity → country* (scale to thousands, fame-ranked difficulty): **birthplace** of world-famous people (P19→P17, filtered to ≥80 Wikipedia language editions, fetched per-country to dodge the WDQS timeout), **landmark** (UNESCO World Heritage Sites, P31 Q9259), **dish** (P495 country of origin).
- Plus curated trivia/nickname/landmark/dish/superlative.

**Excluded on purpose:** `deathplace` (morbid) and anything matching a **sensitivity blocklist** (genocide, massacre, disaster, atrocity, terror, assassination, famine, apartheid, slavery, …) — kept out to preserve a light tone. `war` is allowed (historical, educational).

**Pipeline robustness:** the SPARQL cache is keyed by **query text** (editing a query auto-refreshes it), and fetches use **retry + linear back-off** at gentle concurrency (WDQS 429-rate-limits bursts). No hard timer on questions (casual-daily feel; speed is reserved for a future PvP mode).

**Anti-leak filter (`leaksCountryName`):** drop any clue whose text contains the answer country's name or a demonym prefix — kills "United Arab Emirates dirham", "Estonian → Estonia", "Kinyarwanda → Rwanda", "Kuwait City → Kuwait", etc. Currency is reduced to its **unit** ("dirham", "naira") so it neither leaks nor collides. (`locate` is exempt — naming the country is its whole point.)

**Current output:** ~2,678 questions (incl. 1,322 birthplaces) → **400-day** calendar (capacity cap). Regenerate with `pnpm content:gen`.

### Flags = emoji (not images)
Flag questions render the country's **flag emoji** (🇫🇷), derived from its alpha-2 code — no image assets or licensing. The clue emoji is rendered **unselectable** (no copy/drag/right-click) because the emoji's characters encode the alpha-2 code and would otherwise leak the answer. **Caveat:** Windows Chrome renders flag emoji as the 2-letter code rather than a flag — fine for the mobile-first audience, but swap to SVGs if desktop-web becomes important.

### Licensing guardrails
- Flags = public domain, safe.
- **Never** use scraped celebrity photos — text clues or Wikimedia-CC images only.

### Anti-cheat
Free daily: googling is self-defeating; render clue text so it isn't trivially copyable, and stop there. Hardening (timers, obfuscated clues) is a PvP-era concern.

---

## 3. Monetization

Layered model. **All monetization lives on the web app** (Playables cannot process payment — see §4).

- **"Pro" subscription** → Multiplayer/PvP + Endless/Practice mode + ad-free + deep stats. (Recurring revenue.)
- **Cosmetics & streak insurance** → skins, globe themes, badges, streak-freeze — one-time/consumable. (Impulse revenue; streak-freeze monetizes loss-aversion.)

**Do NOT** headline "pay to remove the 3/day limit" — scarcity *is* the habit loop; removing it fights retention. (Extra plays are folded into Endless mode instead.)

**Build order:** free shared-daily loop → Endless/Practice → cosmetics/streak insurance → PvP last (matchmaking, real-time, anti-cheat = most complex).

---

## 4. Platform Strategy & The Funnel

### Hard constraints (YouTube Playables, official docs, 2026)
- **No external links/redirects.** Games "MUST NOT make external calls to any URLs or services" except Google/YouTube APIs, and MUST NOT circumvent this. A "play on our site" button is **impossible / won't certify**.
- **No off-platform monetization.** No IAP, no own payment gateway, no developer-served ads. Monetization "not supported" today.
- **No accounts / no PII** inside the Playable. No login/account-creation screens.
- **Must be a single-page app**, no code obfuscation; WASM / `eval()` / web-workers risk rejection; ads only via YouTube's own SDK functions.
- Only outbound action: `openYTContent()` → opens **another YouTube video or Playable** by content ID (not an arbitrary URL).

### Chosen GTM: **Playables-first, indirect funnel**
Lead acquisition on Playables for reach; leak players to the web via the only legal path plus brand recall.

**The compliant funnel:**
`Playable → "watch"/"leaderboard" button (openYTContent) → your own YouTube video → website link in video description/pinned comment → web app.`

Plus two surviving free levers: a **memorable, searchable brand name**, and **shareable result cards**.

> **Reality check:** conversion will be leaky (low %). "Playables-first" leads *acquisition* there but does **not** avoid building the full web app — 100% of revenue and all accounts/PvP/Endless/cosmetics live on web regardless.

---

## 5. Architecture — Two Surfaces, One Core

### Surface A — The Playable (acquisition)
- Self-contained SPA; no backend calls except Google/YouTube APIs.
- Free daily loop only (3 shared questions + results card).
- Progress via YouTube-managed save if the SDK offers it (no PII) — else `localStorage`.
- Funnel CTAs use `openYTContent()` → your own YouTube channel video.

### Surface B — The web app (product + revenue)
- Same daily loop **plus** accounts, PvP, Endless/Practice, cosmetics, subscription, real leaderboards, cross-device sync.
- **Its own share links** (direct to your domain) — a second, unrestricted viral loop independent of YouTube.

### Shared core
One game engine + one content/question service power both surfaces — build map, scoring, and question bank once.

---

## 6. Map & Interaction UX

### Rendering
- Vector world map (GeoJSON/TopoJSON) of **country polygons only** — no tiles, no streets, **no labels, no search box** (labels leak answers). Lightweight, self-contained (no external map service — which Playables blocks anyway).
- Pan + pinch-zoom + double-tap-to-zoom; snap-zoom into a region for hard questions.

### Interaction: two-tap **select-then-guess** (eliminates fat-finger errors)
1. **Tap a country** → highlights (fill + outline). Nothing submitted.
2. **Re-tap anywhere** → selection moves freely, zero penalty, unlimited changes.
3. **Tap "Guess" button** → submits & reveals.

Rules:
- Guess button **disabled until a country is selected** (no empty submit).
- **Button always reads "Guess"** — the country name is never shown (a name would leak the answer on
  "locate" questions; showing it only for some types was rejected). *(Supersedes the earlier conditional-label rule.)*
- **Tap tolerance / nearest-country snapping** on selection — harmless because selection is reversible.
- **Zoom & pan** (`packages/map`): scroll / pinch to zoom, drag to pan, double-tap to zoom in — the
  real fix for tapping micro-nations. Tap-vs-drag is distinguished by a movement threshold.
- **Reveal auto-fit:** on submit, the map zooms/pans so **both the guessed and correct countries fit
  in view** (padded). Far-apart picks zoom out; adjacent ones zoom in — fixes the "correct country too
  small to see" problem (e.g. Bahamas). `fitToCountries()` in `packages/map`.
- **Map resets after each question** — highlight cleared and zoom returned to the full world view.
- The reveal text also **names the correct country** ("the answer was The Bahamas") as a text backstop.
- Guess button separated from the map area so panning can't trigger it.

### Feedback
- On submit: correct → country flashes green; wrong → your pick flashes red, correct one pulses green, distance arc drawn; partial (neighbor) shown explicitly ("Close! Half points").
- Speed bonus shown as a small ticking meter.

### Accessibility & feel
- Colorblind-safe results (shapes/patterns in the share grid, not just red/green).
- Big tap targets, haptics, smooth 60fps pan, minimal text screens.

---

## 7. Open Questions / To Verify
- ~~Does the Playables SDK offer YouTube-managed save?~~ **CONFIRMED** — YouTube's blog states Playables "save your game progress and track your all-time best scores." XP/streak can persist per-player with no PII and no backend. (Verify exact SDK save API surface when building.)
- Confirm Playables **bundle size limits** and the submission/onboarding process (developer portal; invite vs. open) firsthand before committing.
- Final **name** (must be memorable + searchable + trademark-clear).
- Exact **partial-credit** rule (neighbors only? distance bands?).
- ~~"Daily" boundary~~ **DECIDED — LOCAL midnight** (matches Wordle & GeoGuessr; Australia gets the puzzle before California). Accepted tradeoff: exploitable by changing the device clock to replay past/future days — the same exploit those games tolerate. If competitive leaderboards are ever added, gate them server-side. Encoded in `packages/core/daily.ts` (`dateKey`/`todayKey`, local).
- ~~Answer model~~ **DECIDED** (see §11).

## 9. MVP (v0) Scope & Stack

**Scope — deliberately tiny:** the free daily loop only.
- 3 shared questions/day (easy→medium→hard) + results/share card.
- Per-player **XP** (+ streak) stored **locally** (localStorage on web; YouTube-managed save on the Playable).
- **No** accounts, payments, PvP, Endless, cosmetics, or leaderboards in v0. (Those are post-traction, and all live on web.)

**Cheapest backend = no backend ($0).**
- **Content:** a static `questions.json` (6–12 months of dailies) pre-generated offline via Wikidata; client picks today's entry by date.
- **Persistence:** local only.
- **Hosting:** free static tier (Cloudflare Pages recommended). Playable bundle hosted by YouTube once accepted.
- Add **Supabase free tier** only when accounts/leaderboards/payments/PvP arrive.

**Stack:** pnpm monorepo — `packages/core` (TS: scoring, daily-picker, types) · `packages/map` (d3-geo + topojson, Canvas + geoContains) · `apps/playable` (Svelte + Vite + ytgame SDK) · `apps/web` (Svelte + Vite) · `tools/content-gen` (Node → Wikidata SPARQL → JSON). No tiles/WebGL/external calls (Playables-safe).

## 10. Prior Art — GeoGuessr on Playables (validation)
- **GeoGuessr runs as "GeoGuessr – Daily Game" on Playables** — a daily format, confirming this model works on the platform.
- It serves **Street View inside the sandbox** only because Street View is a **Google-owned API** (the one exception to Playables' no-external-calls rule). **We avoid this dependency entirely** with a self-contained vector map — so our build is *simpler* than GeoGuessr's, not harder.
- Onboarding is via a **developer portal**; big brands may be invited. Treat Playables acceptance as **not guaranteed** → build web-first so nothing is blocked if the Playable is rejected.
- Full sourced research: `docs/research/2026-07-24-youtube-playables-and-geoguessr-research.md`.

## 11. Answer Model
- **MVP:** ship **only single-answer questions** (`acceptedIso.length === 1`). Content-gen enforces
  this via `mvpSingleAnswerOnly()`. Simpler UX (tap one country → Guess) and no partial-credit edge cases.
- **Full product:** support **multi-answer** questions (e.g. the Ganga delta → India **and** Bangladesh).
  The player may **select multiple countries** before submitting:
  - **Full XP** if the selected set exactly matches the accepted set.
  - **Partial XP** if only a subset is selected.
  - **Wrong picks dilute** the score (Jaccard: `|correct ∩ selected| / |correct ∪ selected|`), so
    "select everything" can't game it. Implemented + tested as `scoreMultiSelect()` in `packages/core`.
- The data model already carries `acceptedIso: Iso3[]` everywhere, so no schema change is needed to
  flip on multi-answer later — only content-gen's filter and the map's multi-select UI.

## 12. Build Order (revised)
**Web-first.** Build and launch the standalone web app first (full control, direct share links,
monetization later). The Playable is deferred — its scaffold exists (`apps/playable`) but is not the
current focus. This also de-risks the *not-guaranteed* Playables acceptance (§10).

---

## 8. Decisions Log
- **Daily format:** shared (Wordle-style), not personalized. → shareability > skill-fit.
- **Monetization:** Pro subscription (PvP + Endless + ad-free + stats) + à-la-carte cosmetics; NOT pay-to-remove-daily-limit.
- **GTM:** Playables-first, indirect funnel (openYTContent → YouTube video → description link).
- **Interaction:** two-tap select-then-guess with conditional button label.
- **Frontend:** Svelte + Vite (smallest bundle for Playables).
- **MVP backend:** none — static JSON + local storage on free static hosting ($0). Supabase later.
- **Name:** **Pinpoint**.
- **Genre:** general-knowledge + geography (not geography alone) → infinite content + a moat.
- **Daily boundary:** LOCAL midnight (Wordle/GeoGuessr convention; device-clock exploit accepted).
- **Answer model:** MVP single-answer only; full product adds multi-select (Jaccard-scored).
- **Map engine:** dependency-free equirectangular + Canvas + custom hit-testing (no d3, no tiles); zoom/pan added.
- **Build order:** web-first; Playable deferred.
- **XP:** staggered by difficulty (200/400/600), no speed bonus, no per-answer popup.
- **Progression:** numeric infinite levels (XP bar; start at Level 1; clear(L) = 1000 + (L-1)*500) + collectible **trophies** unlocked at level milestones.
- **Guess button:** always reads "Guess" (country name never shown).
- **Map data:** real country GeoJSON keyed by ISO alpha-3 (`apps/web/public/countries.geo.json`).
