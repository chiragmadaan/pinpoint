<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    advance,
    buildShareText,
    currentQuestion,
    emptyPlayerState,
    hasCompleted,
    isComplete,
    latestTrophy,
    levelForXp,
    recordCompletedDay,
    trophiesEarned,
    selectCountry,
    sessionVerdicts,
    sessionXp,
    startSession,
    submitGuess,
    todaysPuzzle,
    type Adjacency,
    type DailyPuzzle,
    type PlayerState,
    type Session,
    type Verdict,
  } from "@pinpoint/core";
  import { createWorldMap, type MapFeature, type WorldMap } from "@pinpoint/map";
  import { loadAdjacency, loadCalendar, loadFeatures } from "./lib/data";
  import {
    clearPlayerState,
    loadDevFlags,
    loadPlayerState,
    saveDevFlags,
    savePlayerState,
  } from "./lib/storage";

  // Points at wherever the app is actually served (localhost in dev, the Pages URL in prod).
  const SHARE_URL =
    typeof location !== "undefined" ? location.origin + import.meta.env.BASE_URL : "https://pinpoint.example";
  const DEV = import.meta.env.DEV; // true under `pnpm dev`, stripped from production builds
  const EMOJI: Record<Verdict, string> = { correct: "🟩", neighbor: "🟨", wrong: "⬛" };

  let canvas: HTMLCanvasElement;
  let map: WorldMap | null = null;
  let session: Session | null = null;
  let player: PlayerState = emptyPlayerState();
  let selected: string | null = null;
  let names: Record<string, string> = {}; // iso -> country name, for the answer reveal
  let adjacency: Adjacency = {}; // iso -> bordering iso[], for neighbor partial-credit
  let features: MapFeature[] = [];
  let currentPuzzle: DailyPuzzle | null = null;
  let done = false;
  let shareText = "";
  let copied = false;

  // Dev-only tools
  let devMenuOpen = false;
  let devUnlimited = DEV && loadDevFlags().unlimited; // bypass the daily 3-question limit
  let toggleBtn: HTMLButtonElement;

  // Svelte action: close the dropdown when clicking anywhere outside it (or the toggle button).
  function clickOutside(node: HTMLElement) {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!node.contains(t) && !(toggleBtn && toggleBtn.contains(t))) devMenuOpen = false;
    };
    document.addEventListener("click", handler);
    return { destroy: () => document.removeEventListener("click", handler) };
  }

  // XP bar display state (animated separately from the true level so level-ups fill-then-reset
  // instead of appearing to jump backwards).
  let displayLevel = 1;
  let displayPct = 0;
  let barNoTransition = false;
  let barAnimating = false;
  let barPending = false;
  const BAR_FILL_MS = 1200; // how long the bar takes to fill (slower = more satisfying)
  const BAR_MS = BAR_FILL_MS + 120; // wait per phase; must exceed the fill transition
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function syncXpBar() {
    if (barAnimating) {
      barPending = true; // coalesce rapid updates; re-run once the current animation finishes
      return;
    }
    barAnimating = true;
    do {
      barPending = false;
      const target = levelForXp(player.xp + (session ? sessionXp(session) : 0));
      if (target.level < displayLevel) {
        // e.g. dev reset -> snap down without a backwards animation
        barNoTransition = true;
        displayLevel = target.level;
        displayPct = Math.round(target.progress * 100);
        await tick();
        barNoTransition = false;
      } else {
        while (displayLevel < target.level) {
          displayPct = 100; // fill the current level to full
          await wait(BAR_MS);
          barNoTransition = true; // jump back to empty WITHOUT animating backwards
          displayPct = 0;
          displayLevel += 1;
          await tick();
          await wait(30);
          barNoTransition = false;
        }
        displayPct = Math.round(target.progress * 100); // fill toward the new level's progress
        await wait(BAR_MS);
      }
    } while (barPending);
    barAnimating = false;
  }

  $: q = session ? currentQuestion(session) : null;
  $: revealed = session?.phase === "revealed";
  $: lastResult = revealed ? (session!.results.at(-1) ?? null) : null;
  $: answerName = lastResult ? (names[lastResult.correctIso] ?? lastResult.correctIso) : "";
  // Live XP = banked XP + XP earned so far today; drives the bar/level and fills as you answer.
  $: liveXp = player.xp + (session ? sessionXp(session) : 0);
  $: lvl = levelForXp(liveXp);
  $: trophies = trophiesEarned(lvl.level);

  const shareOptsFor = (xp: number) => {
    const l = levelForXp(xp);
    const t = latestTrophy(l.level);
    return { level: l.level, trophy: t ? `${t.emoji} ${t.name}` : undefined };
  };

  onMount(async () => {
    player = loadPlayerState();
    // Seed the XP bar to the player's current standing without an intro animation.
    const initLvl = levelForXp(player.xp);
    barNoTransition = true;
    displayLevel = initLvl.level;
    displayPct = Math.round(initLvl.progress * 100);
    await tick();
    barNoTransition = false;

    const [calendar, feats, adj] = await Promise.all([loadCalendar(), loadFeatures(), loadAdjacency()]);
    features = feats;
    names = Object.fromEntries(feats.map((f) => [f.iso, f.name ?? f.iso]));
    adjacency = adj;
    // Fall back to the first sample day if today's isn't in the (sample) calendar.
    currentPuzzle = todaysPuzzle(calendar) ?? calendar.puzzles[0] ?? null;
    if (!currentPuzzle) return;

    if (!devUnlimited && hasCompleted(player, currentPuzzle.date)) {
      done = true;
      shareText = buildShareText(currentPuzzle.date, player.history[currentPuzzle.date] ?? [], player.streak, SHARE_URL, shareOptsFor(player.xp));
      return;
    }

    await startPlay();
  });

  // Start (or restart) a play session for the current puzzle; creates the map once, else resets it.
  async function startPlay() {
    if (!currentPuzzle) return;
    done = false;
    selected = null;
    session = startSession(currentPuzzle);
    await tick(); // ensure the <canvas> is in the DOM before wiring the map
    if (!map) {
      map = createWorldMap({
        canvas,
        features,
        onSelect: (iso) => {
          if (session?.phase !== "question") return;
          selected = iso;
          session = selectCountry(session, iso);
        },
      });
    } else {
      map.reset();
    }
    map.render();
  }

  function onGuess() {
    if (!session || selected == null) return;
    session = submitGuess(session, adjacency); // partial credit for a bordering country
    const r = session.results.at(-1)!;
    map?.reveal(r.guessIso, r.correctIso);
    void syncXpBar(); // animate the bar (fill-then-rollover on level-up)
  }

  function onNext() {
    if (!session) return;
    session = advance(session);
    selected = null;
    if (isComplete(session)) {
      const date = session.puzzle.date;
      const verdicts = sessionVerdicts(session);
      const gained = sessionXp(session);
      if (devUnlimited) {
        // Dev: recordCompletedDay is idempotent per day, so bank XP directly and replay immediately.
        player = { ...player, xp: player.xp + gained };
        savePlayerState(player);
        void startPlay();
      } else {
        player = recordCompletedDay(player, date, verdicts, gained);
        savePlayerState(player);
        shareText = buildShareText(date, verdicts, player.streak, SHARE_URL, shareOptsFor(player.xp));
        session = null; // avoid double-counting today's XP in liveXp now that it's banked
        done = true;
      }
    } else {
      map?.reset(); // clear the previous question's highlight AND zoom back to the full world
    }
  }

  async function copyShare() {
    try {
      await navigator.clipboard.writeText(shareText);
      copied = true;
    } catch {
      /* clipboard blocked */
    }
  }

  function devReset() {
    clearPlayerState();
    location.reload(); // fresh state + re-run onMount -> replay today's puzzle
  }

  function toggleUnlimited() {
    devUnlimited = !devUnlimited;
    saveDevFlags({ unlimited: devUnlimited });
    if (devUnlimited && done) void startPlay(); // jump back into play from the results screen
  }
</script>

<main>
  <header>
    <h1>📍 Pinpoint</h1>
    <div class="stats">
      🔥 {player.streak}
      {#if DEV}
        <button bind:this={toggleBtn} class="dev-toggle" class:on={devMenuOpen} on:click={() => (devMenuOpen = !devMenuOpen)} title="Dev menu">⚙ Dev</button>
      {/if}
    </div>
  </header>

  {#if DEV && devMenuOpen}
    <div class="dev-menu" use:clickOutside>
      <span class="dev-title">Dev tools</span>
      <label class="dev-opt">
        <input type="checkbox" checked={devUnlimited} on:change={toggleUnlimited} />
        Unlimited questions (bypass daily limit)
      </label>
      <button class="dev-btn" on:click={devReset}>↻ Reset progress</button>
    </div>
  {/if}

  <div class="level">
    <span class="lvl-label">Level {displayLevel}</span>
    <div class="xpbar">
      <div
        class="xpfill"
        style="width: {displayPct}%; transition: {barNoTransition ? 'none' : `width ${BAR_FILL_MS}ms ease`}"
      ></div>
    </div>
  </div>

  <div class="trophies" title="Trophies earned">
    {#each trophies as t (t.name)}
      <span class="trophy" title={t.name}>{t.emoji}</span>
    {/each}
    {#if trophies.length === 0}
      <span class="trophy-empty">No trophies yet — earn your first at Level 1</span>
    {/if}
  </div>

  {#if done}
    <section class="card">
      <h2>Come back tomorrow!</h2>
      <pre class="share">{shareText}</pre>
      <button on:click={copyShare}>{copied ? "Copied!" : "Share"}</button>
    </section>
  {:else if q}
    <p class="clue">{q.prompt}</p>
    {#if q.emoji}
      <div
        class="flag-emoji"
        role="img"
        aria-label="flag"
        on:contextmenu|preventDefault
        on:dragstart|preventDefault
      >
        {q.emoji}
      </div>
    {/if}
    <p class="progress">Question {(session?.index ?? 0) + 1} / 3 · {q.difficulty}</p>
    <div class="map-wrap">
      <canvas bind:this={canvas} width="720" height="360"></canvas>
      <div class="zoom-controls">
        <button class="zoom-btn" on:click={() => map?.zoomBy(1.4)} aria-label="Zoom in" title="Zoom in">＋</button>
        <button class="zoom-btn" on:click={() => map?.zoomBy(1 / 1.4)} aria-label="Zoom out" title="Zoom out">－</button>
      </div>
    </div>
    <p class="hint">Scroll, pinch, or use ＋/－ to zoom · drag to pan</p>

    {#if revealed && lastResult}
      <p class="result" class:good={lastResult.verdict === "correct"}>
        {#if lastResult.verdict === "correct"}
          {EMOJI.correct} Correct! It's {answerName}.
        {:else if lastResult.verdict === "neighbor"}
          {EMOJI.neighbor} Close — a neighbor! The answer was {answerName}.
        {:else}
          {EMOJI.wrong} Not quite — the answer was {answerName}.
        {/if}
      </p>
      <button on:click={onNext}>{session && session.index < 2 ? "Next" : "See results"}</button>
    {:else}
      <button disabled={!selected} on:click={onGuess}>Guess</button>
    {/if}
  {:else}
    <p>Loading today's puzzle…</p>
  {/if}
</main>

<style>
  :global(body) { margin: 0; background: #0b1e33; color: #eaf2f8; font-family: system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 1rem; position: relative;
    /* Light anti-cheat: text can't be selected/copied into a search engine. */
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  /* keep the share text copyable (it's spoiler-free) */
  .share { user-select: text; -webkit-user-select: text; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 1.4rem; margin: 0.2rem 0; }
  .stats { opacity: 0.85; display: flex; align-items: center; gap: 0.6rem; }
  .dev-toggle { width: auto; margin: 0; padding: 0.25rem 0.6rem; font-size: 0.8rem; font-weight: 500;
    background: #33506b; color: #fff; border-radius: 6px; }
  .dev-toggle.on { background: #4a6c8a; }
  .dev-menu { position: absolute; top: 3rem; right: 1rem; z-index: 50; width: 260px;
    background: #12293d; border: 1px solid #33506b; border-radius: 8px; padding: 0.7rem 0.9rem;
    display: flex; flex-direction: column; gap: 0.55rem; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
  .dev-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.6; }
  .dev-opt { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; cursor: pointer; }
  .dev-opt input { width: auto; }
  .dev-btn { width: auto; align-self: flex-start; margin: 0; padding: 0.35rem 0.7rem; font-size: 0.85rem;
    background: #d1495b; color: #fff; border-radius: 6px; }
  .map-wrap { position: relative; }
  .zoom-controls { position: absolute; right: 10px; bottom: 10px; display: flex; flex-direction: column; gap: 6px; }
  .zoom-btn { width: 38px; height: 38px; margin: 0; padding: 0; font-size: 1.4rem; line-height: 1;
    background: rgba(11, 30, 51, 0.85); color: #eaf2f8; border: 1px solid #33506b; border-radius: 8px; }
  .level { display: flex; align-items: center; gap: 0.6rem; margin: 0.3rem 0 0.6rem; }
  .lvl-label { font-weight: 600; white-space: nowrap; }
  .xpbar { flex: 1; height: 12px; background: #12293d; border-radius: 999px; overflow: hidden; }
  .xpfill { height: 100%; background: #3ea672; border-radius: 999px; }
  .trophies { display: flex; gap: 0.4rem; align-items: center; min-height: 1.5rem; margin-bottom: 0.4rem; }
  .trophy { font-size: 1.2rem; }
  .trophy-empty { font-size: 0.8rem; opacity: 0.5; }
  .clue { font-size: 1.25rem; font-weight: 600; margin: 0.8rem 0 0.2rem; }
  .flag-emoji { font-size: 5rem; line-height: 1; text-align: center; margin: 0.4rem 0;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: default; }
  .progress { opacity: 0.7; margin: 0 0 0.6rem; }
  canvas { width: 100%; height: auto; border-radius: 10px; touch-action: none; display: block; }
  .hint { opacity: 0.55; font-size: 0.85rem; margin: 0.4rem 0 0; text-align: center; }
  button { margin-top: 0.9rem; width: 100%; padding: 0.9rem; font-size: 1.05rem; font-weight: 600;
    border: 0; border-radius: 10px; background: #f2c14e; color: #0b1e33; cursor: pointer; }
  button:disabled { background: #33506b; color: #7f97ab; cursor: not-allowed; }
  .result { font-size: 1.1rem; margin-top: 0.8rem; }
  .result.good { color: #3ea672; }
  .card { text-align: center; }
  .share { display: inline-block; text-align: left; background: #12293d; padding: 1rem; border-radius: 10px; }
</style>
