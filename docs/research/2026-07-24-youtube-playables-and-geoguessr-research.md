# Research Dossier: YouTube Playables Constraints & GeoGuessr Prior Art

> **Purpose of this file:** A self-contained, LLM-readable reference capturing every hard
> constraint of YouTube Playables and how GeoGuessr operates there, for a project building a
> **map-based daily geography quiz game** (read a clue → tap the answer country on a world map).
> Any LLM or engineer should be able to read this file *alone* and understand the platform rules
> that shape the architecture. Compiled 2026-07-24.

---

## 0. Context: what we're building (so constraints make sense)
- A **daily geography quiz**: 3 shared questions/day (same for everyone), easy→medium→hard.
- Player reads a text/flag clue, then **taps a country on a vector world map** and submits.
- Growth strategy: **Playables-first** for reach, funneling players to a **standalone web app**
  where all monetization (subscription, PvP, cosmetics) lives.
- Key architectural consequence of the research below: the game is a **self-contained SPA with a
  vector map** (no external map tiles/Street View), because Playables forbids external network calls.

---

## 1. YouTube Playables — what it is
- YouTube's platform for **lightweight HTML5 games** playable directly inside YouTube (web + mobile app).
- Games appear on a Playables shelf/destination, via Search, and in the "You" tab.
- Players can **save game progress and track all-time best scores** (platform-managed).
  - Source: https://blog.youtube/news-and-events/youtube-playables/
- Grew from a handful of launch titles to **75+ games** (e.g., Angry Birds Showdown, Cut the Rope,
  Words of Wonders, Trivia Crack, GeoGuessr).
  - Source: https://9to5google.com/2024/05/28/youtube-playables-games/

## 2. HARD CONSTRAINTS (official Google developer docs, pages updated 2026-06)

### 2.1 No external network calls / no redirects (the biggest one)
- "Game **MUST NOT make external calls to any URLs or services**, except where explicitly required
  to comply with other Technical Requirements (i.e., to call **APIs owned by Google or YouTube**)."
- "Game **MUST NOT attempt to circumvent** external call prevention."
- **Implication:** No calling your own backend, no analytics beacons, no third-party map tiles,
  no "phone home." Only Google/YouTube-owned APIs are allowed.
- Source: https://developers.google.com/youtube/gaming/playables/certification/requirements_privacydata

### 2.2 No arbitrary outbound links — `openYTContent()` only opens YouTube content
- The SDK's `openYTContent(content)` takes `content = {id, contentType}` where `contentType` is an
  enum of **VIDEO or PLAYABLE** — i.e., a **YouTube content ID, not a URL**.
- Web: opens a new tab. Mobile: opens the video in a mini-player, or replaces the current Playable.
- **You cannot link to a third-party website.** You can only deep-link to another YouTube video or
  another Playable.
- Source: https://developers.google.com/youtube/gaming/playables/reference/sdk

### 2.3 No off-platform monetization
- "**MUST NOT offer in-app purchases of any kind using off-platform services.**"
- "**MUST NOT implement monetization using off-platform services.**"
- Ads: allowed **only** via YouTube's own SDK functions — `ytgame.ads.requestInterstitialAd()`,
  `ytgame.ads.requestRewardedAd(rewardId)` — YouTube-served, **not** developer-served.
  "MUST NOT display in-game advertising of any kind using off-platform services."
- Docs currently state **"Monetization is not supported within YouTube Playables."** The portal's
  ad/IAP toggles are non-functional and exist "to gauge developer interest" — **no published
  revenue-share or payout program yet** (early access).
- Games are effectively **ad-free to players today**.
- Source: https://developers.google.com/youtube/gaming/playables/certification/requirements_monetization

### 2.4 No accounts / no PII inside the Playable
- **No login or account-creation screens.**
- **No PII collection.**
- Clipboard access only on **explicit paste**.
- **Implication:** All accounts, sign-in, and payment must happen on your **separate web app**,
  never inside the Playable.
- Source: https://developers.google.com/youtube/gaming/playables/certification/requirements_privacydata

### 2.5 Technical requirements
- Must be a **single-page application (SPA)**.
- **No code obfuscation.**
- **WASM, `eval()`, and web workers may cause YouTube to decline approval** — avoid them.
- **No QR codes.**
- **Implication:** keep the bundle small, plain, and inspectable. Favor small frameworks (Svelte).
- Source: https://developers.google.com/youtube/gaming/playables/certification/requirements_privacydata

### 2.6 Onboarding / distribution
- Distribution is via a **Developer Portal**. Big/known brands appear to be invited partners.
- **Acceptance is not guaranteed for a small dev** — treat it as a risk. Verify the current
  submission process and any bundle-size limits firsthand before over-investing.
- Source: https://developers.google.com/youtube/gaming/playables/developer_portal

## 3. GeoGuessr on Playables (prior art)
- **Live as "GeoGuessr – Daily Game"** on Playables — a **daily** format.
  - Listing: https://www.youtube.com/playables/UgkxAbBmW6nhPIhKwP-MwXXNUo_5Oejh7Eyw
  - Description: "GeoGuessr drops you into Street View. Analyze, guess your spot, and score
    big—the closer you are, the higher the points." (proximity scoring, like our plan)
- **How it serves Street View despite the no-external-calls rule:** Street View / Google Maps are
  **Google-owned APIs**, which are the *explicit exception* in §2.1. GeoGuessr rides that exception.
- **Our advantage:** we use a **self-contained vector world map** (TopoJSON), so we need **zero**
  external calls — we sidestep the exact dependency GeoGuessr had to rely on. Our build is simpler.
- **Monetization/funnel:** GeoGuessr's *main site* uses Paddle for payments and third-party ads
  (snigel/adinplay) — but **none of that can run inside the Playable** (§2.3). The Playable is a
  reach/brand asset; real monetization is off-platform on geoguessr.com.

## 4. What this means for our project (decisions locked)
1. **Self-contained vector map** (d3-geo + TopoJSON, Canvas). No tiles, no Street View, no external calls.
2. **Two surfaces, one core engine:**
   - *Playable* = free daily loop only; progress via YouTube-managed save; funnel via
     `openYTContent()` → our own YouTube video → website link in the video description.
   - *Web app* = full product + all monetization + accounts + its own direct share links.
3. **Playables cannot be the monetization surface** — it's acquisition only. Build **web-first**
   so a Playables rejection doesn't block launch.
4. **MVP = $0 backend:** static `questions.json` + local storage + free static hosting.
5. **The indirect funnel is leaky** — compensate with a memorable/searchable brand name and
   strong shareable result cards (Wordle-style).

## 5. Still to verify firsthand before/at build time
- Exact **YouTube-managed save API** surface (confirmed it exists; confirm method names & quotas).
- Current **bundle-size limits** and the **submission/onboarding** process for new/independent devs.
- Whether `ytgame.ads` reward/interstitial functions are usable (currently non-functional per docs).

## 6. Source list
- YouTube Playables monetization requirements — https://developers.google.com/youtube/gaming/playables/certification/requirements_monetization
- YouTube Playables privacy/data (external calls, PII, SPA, technical rules) — https://developers.google.com/youtube/gaming/playables/certification/requirements_privacydata
- YouTube Playables SDK reference (`openYTContent`, save) — https://developers.google.com/youtube/gaming/playables/reference/sdk
- YouTube Playables developer portal — https://developers.google.com/youtube/gaming/playables/developer_portal
- YouTube blog (Playables intro, save progress) — https://blog.youtube/news-and-events/youtube-playables/
- 9to5Google (75+ games) — https://9to5google.com/2024/05/28/youtube-playables-games/
- GeoGuessr Daily Game on Playables — https://www.youtube.com/playables/UgkxAbBmW6nhPIhKwP-MwXXNUo_5Oejh7Eyw
- Third-party Playables/monetization guide — https://playgama.com/blog/main/youtube-playables/

## 7. Post-Traction Roadmap (deferred — NOT in MVP)

> These are intentionally out of scope for the v0 web MVP (which is only: daily 3 questions +
> local XP/streak, static hosting, $0). They are recorded here **verbosely** so any future LLM or
> engineer picking up the project has the full intended trajectory and rationale without re-deriving
> it. Nothing here should be built until the free daily loop shows real retention/growth.

### 8.1 Accounts & cross-device sync
- **Why deferred:** MVP stores XP/streak locally (localStorage on web, YouTube-managed save on the
  Playable). That's enough to prove the loop. Accounts add friction and cost.
- **When to add:** once players ask to keep progress across devices, or before any paid tier (you
  can't sell to an anonymous local profile).
- **How:** Supabase Auth (free tier). Migrate the local `PlayerState` into a server row on first
  sign-in. Keep anonymous local play as the default; sign-in is optional and additive.

### 8.2 Real leaderboards
- **Why deferred:** leaderboards need accounts + anti-cheat + a server; and the local-midnight daily
  boundary is device-clock-exploitable (§4/§design), which is fine socially but **not** for ranked play.
- **How:** server-authoritative daily (server decides "today" and validates submissions server-side),
  friends leaderboards first (higher signal, less cheating pressure) then global.

### 8.3 Monetization (all of it lives on the WEB app — never in the Playable, per §2.3)
- **"Pro" subscription:** Multiplayer/PvP + Endless/Practice mode + ad-free + deep stats. Recurring revenue.
- **Cosmetics & streak insurance:** skins, globe themes, badges, "streak freeze" (monetizes loss-aversion).
- **Explicitly NOT** "pay to remove the 3/day limit" — scarcity is the habit loop; removing it hurts retention.
- **Payments:** Stripe (subscription + one-time). GeoGuessr uses Paddle on its own site — either works.
- **Build order once monetizing:** Endless/Practice → cosmetics/streak insurance → PvP last (hardest).

### 8.4 Multi-answer questions (full-product content model)
- MVP ships single-answer only. Full product enables clues with several correct countries (e.g. the
  Ganga delta → India + Bangladesh). Player selects multiple countries; scoring is Jaccard-based
  (full XP for exact match, partial for a subset, wrong picks dilute). Already implemented + tested
  as `scoreMultiSelect()` in `packages/core`; only the content filter and multi-select map UI remain.

### 8.5 PvP / team play & anti-cheat
- **Realtime:** Colyseus (purpose-built game rooms) or Supabase Realtime for lighter needs.
- **Anti-cheat (only matters here + leaderboards):** timers, server-validated answers, clue text
  rendered to resist copy/search, rate limiting. Irrelevant for the casual free daily.

### 8.6 The YouTube Playable itself (deferred surface)
- Build web-first; the Playable is a port used purely for reach. Its scaffold exists (`apps/playable`).
- Before investing: **verify developer-portal onboarding (invite vs. open) and bundle-size limits.**
- Compliant funnel: `openYTContent()` → your own YouTube video → website link in the description.
- Persist progress via the YouTube-managed save API (confirm exact surface at build time, §5).

### 8.7 Internationalization
- MVP is English clues; the **map is language-neutral**, which suits YouTube's global audience.
- Localizing clue text multiplies content-gen + validation work — defer until a region justifies it.

### 8.8 Measurement / analytics
- **Web app:** privacy-friendly analytics (e.g. Plausible) — funnel, retention, share-CTR.
- **Playable:** external calls are banned, so you're limited to YouTube-provided metrics. Plan the
  funnel measurement around that asymmetry.

## 8. Confidence & caveats
- §2 constraints are from **official Google docs** (high confidence), read 2026-06/07.
- §3 GeoGuessr specifics (partnership vs. open submission, exact tech) are **partially inferred**
  from public listings + platform rules; the Street-View-as-Google-API reasoning is deductive.
- Platform ToS change frequently — **re-verify §2 and §5 before committing engineering effort.**
- Tooling note during research: `WebSearch`/`WebFetch` were gated; findings gathered via `curl`
  against official docs + DuckDuckGo HTML. Some third-party detail is lightly sourced.
