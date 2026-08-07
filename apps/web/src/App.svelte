<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    acedMain,
    advance,
    buildShareText,
    currentQuestion,
    currentStreak,
    DEFAULT_SCORE_CONFIG,
    emptyPlayerState,
    hasCompleted,
    isBonusQuestion,
    isComplete,
    recordCompletedDay,
    trophyProgress,
    selectCountry,
    sessionVerdicts,
    sessionXp,
    startSession,
    submitGuess,
    TIMER_SECONDS,
    timeUp,
    todaysPuzzle,
    type Adjacency,
    type DailyPuzzle,
    type PlayerState,
    type Session,
    type Trophy,
    type Verdict,
  } from "@pinpoint/core";
  import {
    bearingDeg,
    compassPoint,
    createWorldMap,
    haversineKm,
    largestOuterRing,
    polygonCentroidXY,
    type MapFeature,
    type WorldMap,
  } from "@pinpoint/map";
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
  // Dev tools show under `pnpm dev`, OR in a build made with VITE_DEV_TOOLS=1 (the hosted /dev/ variant).
  const DEV = import.meta.env.DEV || import.meta.env.VITE_DEV_TOOLS === "1";
  // Build info injected by vite.config.ts (SHA is empty in local dev).
  const APP_VERSION = import.meta.env.VITE_APP_VERSION;
  const BUILD_SHA = import.meta.env.VITE_BUILD_SHA;
  const EMOJI: Record<Verdict, string> = { correct: "🟩", neighbor: "🟨", wrong: "⬛" };
  const base = import.meta.env.BASE_URL;

  /** Representative lon/lat for a country, for the distance/direction readout. Cached per iso. */
  const centroidCache = new Map<string, [number, number] | null>();
  function centroidOf(iso: string): [number, number] | null {
    if (!centroidCache.has(iso)) {
      const f = features.find((x) => x.iso === iso);
      const ring = f ? largestOuterRing(f.geometry) : null;
      centroidCache.set(iso, ring ? polygonCentroidXY(ring as [number, number][]) : null);
    }
    return centroidCache.get(iso) ?? null;
  }

  // Flag emojis render as raw "KE" letters on Windows (broken + leaks the answer), so we render an
  // SVG instead. The stored emoji is two regional-indicator chars -> decode back to the alpha-2 code.
  function flagCode(emoji: string): string | null {
    const cps = [...emoji].map((c) => c.codePointAt(0) ?? 0);
    if (cps.length === 2 && cps.every((cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff)) {
      return cps.map((cp) => String.fromCharCode(cp - 0x1f1e6 + 97)).join("");
    }
    return null;
  }

  let canvas: HTMLCanvasElement;
  let map: WorldMap | null = null;
  let session: Session | null = null;
  let player: PlayerState = emptyPlayerState();
  let selected: string | null = null;
  let names: Record<string, string> = {}; // iso -> country name, for the answer reveal
  let adjacency: Adjacency = {}; // iso -> bordering iso[], for neighbor partial-credit
  let features: MapFeature[] = [];
  let currentPuzzle: DailyPuzzle | null = null;
  let loaded = false; // data + puzzle resolved
  let started = false; // player pressed Play (past the welcome screen)
  let isTouch = false; // touch device (pinch) vs mouse (scroll/buttons) — tailors the hint text
  let namesOn = false; // country-names aid: labels the map
  let namesUsed = false; // sticky: once names are shown this session, points stay halved (anti-cheat)
  let done = false;
  let shareText = "";
  let copied = false;
  let bonusStatus: "solved" | "missed" | undefined; // for the results card

  const bonusFrom = (verdicts: string[]): "solved" | "missed" | undefined =>
    verdicts.length >= 4 ? (verdicts[3] === "correct" ? "solved" : "missed") : undefined;

  // Per-question countdown timer (rendered as a depleting ring, not a reverse bar).
  let timeLeft = 0;
  let totalTime = 0;
  let timerId: ReturnType<typeof setInterval> | null = null;
  const RING_R = 26;
  const RING_C = 2 * Math.PI * RING_R;

  // Trophy-unlock toast.
  let trophyToast: Trophy | null = null;
  let trophyToastId: ReturnType<typeof setTimeout> | null = null;
  function showTrophy(t: Trophy) {
    trophyToast = t;
    if (trophyToastId) clearTimeout(trophyToastId);
    trophyToastId = setTimeout(() => (trophyToast = null), 4000);
  }

  function stopTimer() {
    if (timerId) clearInterval(timerId);
    timerId = null;
  }
  function startTimer() {
    stopTimer();
    const cq = session ? currentQuestion(session) : null;
    if (!cq) return;
    totalTime = TIMER_SECONDS[cq.difficulty];
    timeLeft = totalTime;
    if (devNoTimer) return; // dev: no countdown, no auto-submit — the ring is hidden too
    timerId = setInterval(() => {
      timeLeft -= 1;
      if (timeLeft <= 0) {
        stopTimer();
        onTimeUp();
      }
    }, 1000);
  }
  function onTimeUp() {
    if (session?.phase !== "question") return;
    session = timeUp(session, adjacency, scoreCfg());
    const r = session.results.at(-1)!;
    map?.reveal(r.guessIso, currentQuestion(session)?.acceptedIso ?? r.correctIso);
    void syncBar();
  }
  onDestroy(stopTimer);

  // Dev-only tools
  let devMenuOpen = false;
  let devUnlimited = DEV && loadDevFlags().unlimited; // bypass the daily 3-question limit
  let devNoTimer = DEV && loadDevFlags().noTimer; // play with no countdown (patient testing)
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

  // Trophy-progress bar. Numeric levels are internal only; the visible progression is the bar
  // filling toward the NEXT trophy. On crossing a trophy it fills to full, celebrates, then resets.
  let displayEarned = 0; // count of trophies the bar has "reached"
  let displayPct = 0;
  let barNoTransition = false;
  let barAnimating = false;
  let barPending = false;
  const BAR_FILL_MS = 1200;
  const BAR_MS = BAR_FILL_MS + 120;
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  async function syncBar() {
    if (barAnimating) {
      barPending = true;
      return;
    }
    barAnimating = true;
    do {
      barPending = false;
      const target = trophyProgress(player.xp + (session ? sessionXp(session) : 0));
      const targetEarned = target.earned.length;
      if (targetEarned < displayEarned) {
        // dev reset -> snap down without a backwards animation
        barNoTransition = true;
        displayEarned = targetEarned;
        displayPct = Math.round(target.progress * 100);
        await tick();
        barNoTransition = false;
      } else {
        while (displayEarned < targetEarned) {
          displayPct = 100; // fill to the trophy
          await wait(BAR_MS);
          const justEarned = target.earned[displayEarned]; // the trophy we just crossed
          if (justEarned) showTrophy(justEarned);
          barNoTransition = true; // reset to empty without animating backwards
          displayPct = 0;
          displayEarned += 1;
          await tick();
          await wait(30);
          barNoTransition = false;
        }
        displayPct = Math.round(target.progress * 100); // fill toward the next trophy
        await wait(BAR_MS);
      }
    } while (barPending);
    barAnimating = false;
  }

  $: q = session ? currentQuestion(session) : null;
  $: revealed = session?.phase === "revealed";
  $: lastResult = revealed ? (session!.results.at(-1) ?? null) : null;
  $: answerName = lastResult ? (names[lastResult.correctIso] ?? lastResult.correctIso) : "";
  $: guessName = lastResult?.guessIso ? (names[lastResult.guessIso] ?? lastResult.guessIso) : "";
  /**
   * How far off a wrong guess was, and in which direction. Without this a miss teaches nothing —
   * tapping a neighbour and tapping another continent both just read "wrong". The arrow is a rotated
   * SVG rather than a directional emoji: emoji rendering is inconsistent across platforms (the flag
   * emoji rendered as raw letters on Windows), and rotation also gives the exact bearing instead of
   * snapping to one of eight arrows.
   */
  $: miss =
    lastResult && lastResult.verdict !== "correct" && lastResult.guessIso
      ? (() => {
          const from = centroidOf(lastResult.guessIso);
          const to = centroidOf(lastResult.correctIso);
          if (!from || !to) return null;
          const km = Math.round(haversineKm(from, to));
          const bearing = bearingDeg(from, to);
          return { km, bearing, compass: compassPoint(bearing) };
        })()
      : null;
  // Live XP = banked XP + XP earned so far today; drives the trophy bar as you answer.
  $: liveXp = player.xp + (session ? sessionXp(session) : 0);
  $: prog = trophyProgress(liveXp);
  $: isBonus = session ? isBonusQuestion(session) : false;
  $: nextLabel = !session
    ? ""
    : isBonus
      ? "See results"
      : session.index === 2
        ? acedMain(session)
          ? "Bonus question →"
          : "See results"
        : "Next";

  // Points multiplier: bonus question is worth 2x; using the names aid halves everything for the
  // whole session (sticky — peeking then unchecking must not restore full points).
  const scoreCfg = () => ({ ...DEFAULT_SCORE_CONFIG, multiplier: (isBonus ? 2 : 1) * (namesUsed ? 0.5 : 1) });

  const shareOptsFor = (xp: number) => {
    const t = trophyProgress(xp).earned.at(-1);
    return { trophy: t ? `${t.emoji} ${t.name}` : undefined };
  };

  onMount(async () => {
    isTouch = typeof window !== "undefined" && !!window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
    player = loadPlayerState();
    // Seed the trophy bar to the player's current standing without an intro animation.
    const initProg = trophyProgress(player.xp);
    barNoTransition = true;
    displayEarned = initProg.earned.length;
    displayPct = Math.round(initProg.progress * 100);
    await tick();
    barNoTransition = false;

    const [calendar, feats, adj] = await Promise.all([loadCalendar(), loadFeatures(), loadAdjacency()]);
    features = feats;
    names = Object.fromEntries(feats.map((f) => [f.iso, f.name ?? f.iso]));
    adjacency = adj;
    // todaysPuzzle wraps to the start of the calendar once the dates run out, re-dated to today.
    // The old `?? calendar.puzzles[0]` fallback here is exactly what bricked the game on exhaustion:
    // that puzzle carries a PAST date, so hasCompleted() said it was already done and the player was
    // permanently stuck on the results screen.
    currentPuzzle = todaysPuzzle(calendar);
    loaded = true;
    if (!currentPuzzle) return;

    // If today's already done, jump straight to results; otherwise show the welcome screen (Play).
    if (!devUnlimited && hasCompleted(player, currentPuzzle.date)) {
      done = true;
      const hist = player.history[currentPuzzle.date] ?? [];
      bonusStatus = bonusFrom(hist);
      shareText = buildShareText(currentPuzzle.date, hist.slice(0, 3), player.streak, SHARE_URL, {
        ...shareOptsFor(player.xp),
        bonus: bonusStatus,
      });
    }
  });

  // Start (or restart) a play session for the current puzzle; creates the map once, else resets it.
  async function startPlay() {
    if (!currentPuzzle) return;
    done = false;
    started = true;
    selected = null;
    namesOn = false;
    namesUsed = false; // fresh session -> aid and its penalty reset
    session = startSession(currentPuzzle);
    await tick(); // ensure the <canvas> is in the DOM before wiring the map
    if (!map) {
      // 12x zoom on every device — needed to see/tap tiny island countries (e.g. the Caribbean).
      const maxZoom = 16;
      map = createWorldMap({
        canvas,
        features,
        maxZoom,
        onSelect: (iso) => {
          if (session?.phase !== "question") return;
          selected = iso;
          session = selectCountry(session, iso);
        },
      });
    } else {
      map.reset();
    }
    map.setLabels(namesOn);
    map.render();
    startTimer();
  }

  function onGuess() {
    if (!session || selected == null) return;
    stopTimer();
    session = submitGuess(session, adjacency, scoreCfg());
    const r = session.results.at(-1)!;
    map?.reveal(r.guessIso, currentQuestion(session)?.acceptedIso ?? r.correctIso);
    void syncBar(); // animate the trophy bar (fill-then-rollover on unlock)
  }

  function onNext() {
    if (!session) return;
    stopTimer();
    session = advance(session);
    selected = null;
    if (isComplete(session)) {
      const date = session.puzzle.date;
      const allVerdicts = sessionVerdicts(session);
      const mandatory = allVerdicts.slice(0, 3); // grid/history is the mandatory 3
      bonusStatus = bonusFrom(allVerdicts); // solved / missed / (undefined if not unlocked)
      const gained = sessionXp(session);
      if (devUnlimited) {
        // Dev: recordCompletedDay is idempotent per day, so bank XP directly and replay immediately.
        player = { ...player, xp: player.xp + gained };
        savePlayerState(player);
        void startPlay();
      } else {
        // Persist ALL verdicts (incl. the 4th bonus) so the star survives a reload.
        player = recordCompletedDay(player, date, allVerdicts, gained);
        savePlayerState(player);
        shareText = buildShareText(date, mandatory, player.streak, SHARE_URL, { ...shareOptsFor(player.xp), bonus: bonusStatus });
        session = null; // avoid double-counting today's XP in liveXp now that it's banked
        done = true;
      }
    } else {
      map?.reset(); // clear the previous question's highlight AND zoom back to the full world
      startTimer(); // fresh countdown for the next question
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

  function toggleNames() {
    namesOn = !namesOn;
    if (namesOn) namesUsed = true; // sticky penalty for the rest of the session
    map?.setLabels(namesOn);
  }

  function toggleUnlimited() {
    devUnlimited = !devUnlimited;
    saveDevFlags({ unlimited: devUnlimited, noTimer: devNoTimer });
    if (devUnlimited && done) void startPlay(); // jump back into play from the results screen
  }

  function toggleNoTimer() {
    devNoTimer = !devNoTimer;
    saveDevFlags({ unlimited: devUnlimited, noTimer: devNoTimer });
    if (devNoTimer) stopTimer(); // kill any running countdown immediately
    else if (!revealed) startTimer(); // resume a countdown for the current question
  }
</script>

<main>
  {#if trophyToast}
    <div class="toast" role="status">
      <span class="toast-emoji">{trophyToast.emoji}</span>
      <span>Trophy unlocked — <strong>{trophyToast.name}</strong>!</span>
    </div>
  {/if}
  <header>
    <h1>📍 Pinpoint {#if DEV}<span class="dev-badge">DEV</span>{/if}</h1>
    <div class="stats">
      🔥 {currentStreak(player)}
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
      <label class="dev-opt">
        <input type="checkbox" checked={devNoTimer} on:change={toggleNoTimer} />
        No timer (play at your own pace)
      </label>
      <button class="dev-btn" on:click={devReset}>↻ Reset progress</button>
    </div>
  {/if}

  <div class="trophies" title="Trophies earned">
    {#each prog.earned as t (t.name)}
      <span class="trophy" title={t.name}>{t.emoji}</span>
    {/each}
  </div>

  <div class="trophy-bar" title={prog.next ? `Progress to ${prog.next.name}` : "All trophies earned!"}>
    <div class="xpbar">
      <div
        class="xpfill"
        style="width: {displayPct}%; transition: {barNoTransition ? 'none' : `width ${BAR_FILL_MS}ms ease`}"
      ></div>
    </div>
    <span class="next-trophy">{prog.next ? prog.next.emoji : "🏅"}</span>
  </div>

  {#if !loaded}
    <p class="loading">Loading…</p>
  {:else if done}
    <section class="card">
      <h2>Come back tomorrow!</h2>
      {#if bonusStatus === "solved"}
        <p class="bonus-line good">⭐ Bonus solved!</p>
      {:else if bonusStatus === "missed"}
        <p class="bonus-line">✩ Bonus missed — so close!</p>
      {/if}
      <pre class="share">{shareText}</pre>
      <button on:click={copyShare}>{copied ? "Copied!" : "Share"}</button>
    </section>
  {:else if !started}
    <section class="card welcome">
      <h2>Guess the country 🌍</h2>
      <p class="welcome-sub">Read a clue, find it on the map. Three puzzles a day.</p>
      <button on:click={startPlay}>▶ Play</button>
    </section>
  {:else if q}
    {#if !revealed && !devNoTimer}
      <div class="timer-wrap">
        <svg class="timer-ring" class:low={timeLeft <= 5} viewBox="0 0 60 60" width="60" height="60" aria-label="Time left">
          <circle class="track" cx="30" cy="30" r={RING_R} />
          <circle
            class="prog"
            cx="30"
            cy="30"
            r={RING_R}
            style="stroke-dasharray: {RING_C}; stroke-dashoffset: {RING_C * (1 - (totalTime ? timeLeft / totalTime : 0))}; transition: stroke-dashoffset 1s linear;"
          />
          <text x="30" y="31" text-anchor="middle" dominant-baseline="middle">{timeLeft}</text>
        </svg>
      </div>
    {/if}
    <p class="clue">{q.prompt}</p>
    {#if q.emoji}
      {@const cc = flagCode(q.emoji)}
      {#if cc}
        <img
          class="flag-img"
          src="{base}flags/{cc}.svg"
          alt="Flag"
          draggable="false"
          on:contextmenu|preventDefault
        />
      {:else}
        <div class="flag-emoji" role="img" aria-label="flag" on:contextmenu|preventDefault>{q.emoji}</div>
      {/if}
    {/if}
    <p class="progress">
      {#if isBonus}⭐ Bonus question{:else}Question {(session?.index ?? 0) + 1} / 3{/if} · {q.difficulty}
    </p>
    <div class="map-wrap">
      <canvas bind:this={canvas} width="720" height="360"></canvas>
      <div class="zoom-controls">
        <button class="zoom-btn" on:click={() => map?.zoomBy(1.6)} aria-label="Zoom in" title="Zoom in">＋</button>
        <button class="zoom-btn" on:click={() => map?.zoomBy(1 / 1.6)} aria-label="Zoom out" title="Zoom out">－</button>
      </div>
    </div>
    <p class="hint">{isTouch ? "Pinch to zoom · drag to pan" : "Scroll or use ＋/－ to zoom · drag to pan"}</p>

    {#if revealed && lastResult}
      <p class="result" class:good={lastResult.verdict === "correct"}>
        {#if lastResult.verdict === "correct"}
          {EMOJI.correct} Correct! It's {answerName}.
        {:else if lastResult.verdict === "neighbor"}
          {EMOJI.neighbor} Close — a neighbor! The answer was {answerName}. You picked {guessName}.
        {:else}
          {EMOJI.wrong} Not quite — the answer was {answerName}. {#if lastResult.guessIso}You picked {guessName}.{/if}
        {/if}
      </p>
      {#if miss}
        <p class="miss">
          <svg class="arrow" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"
               style="transform: rotate({miss.bearing}deg)">
            <path d="M12 3 L12 21 M12 3 L6 10 M12 3 L18 10" />
          </svg>
          {miss.km.toLocaleString()} km {miss.compass}
          <span class="sr-only">of your guess</span>
        </p>
      {/if}
      {#if q.fact}
        <!-- Facts come from Wikipedia (CC BY-SA), which requires visible attribution. -->
        <p class="fact">💡 {q.fact} <span class="fact-src">— Wikipedia</span></p>
      {/if}
      <button on:click={onNext}>{nextLabel}</button>
    {:else}
      <button disabled={!selected} on:click={onGuess}>Guess</button>
      <label class="names-toggle">
        <input type="checkbox" checked={namesOn} on:change={toggleNames} />
        {namesUsed ? "Country names — ½ points this game" : "Show country names (½ points)"}
      </label>
    {/if}
  {:else}
    <p>Loading today's puzzle…</p>
  {/if}
</main>

<div class="version">v{APP_VERSION}{BUILD_SHA ? ` · ${BUILD_SHA}` : ""}</div>

<style>
  :global(body) { margin: 0; background: #0b1e33; color: #eaf2f8; font-family: system-ui, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 1rem; position: relative;
    /* Light anti-cheat: text can't be selected/copied into a search engine. */
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  /* keep the share text copyable (it's spoiler-free) */
  .share { user-select: text; -webkit-user-select: text; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 1.4rem; margin: 0.2rem 0; }
  .dev-badge { font-size: 0.7rem; font-weight: 700; vertical-align: middle; padding: 0.1rem 0.4rem;
    margin-left: 0.3rem; border-radius: 5px; background: #d1495b; color: #fff; letter-spacing: 0.05em; }
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
  /* Hide ＋/－ on touch devices (pinch-to-zoom covers it); show only where there's a mouse. */
  @media (hover: none) and (pointer: coarse) {
    .zoom-controls { display: none; }
  }
  .zoom-btn { width: 38px; height: 38px; margin: 0; padding: 0; font-size: 1.4rem; line-height: 1;
    background: rgba(11, 30, 51, 0.85); color: #eaf2f8; border: 1px solid #33506b; border-radius: 8px; }
  .trophy-bar { display: flex; align-items: center; gap: 0.5rem; margin: 0.3rem 0 0.6rem; }
  .xpbar { flex: 1; height: 12px; background: #12293d; border-radius: 999px; overflow: hidden; }
  .xpfill { height: 100%; background: #3ea672; border-radius: 999px; }
  .next-trophy { font-size: 1.25rem; opacity: 0.55; } /* the trophy you're working toward */
  .trophies { display: flex; gap: 0.4rem; align-items: center; min-height: 1.5rem; margin-bottom: 0.2rem; }
  .trophy { font-size: 1.2rem; }
  .clue { font-size: 1.25rem; font-weight: 600; margin: 0.8rem 0 0.2rem; }
  .flag-emoji { font-size: 5rem; line-height: 1; text-align: center; margin: 0.4rem 0;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: default; }
  .flag-img { display: block; width: 200px; max-width: 60%; height: auto; margin: 0.5rem auto;
    border-radius: 6px; box-shadow: 0 2px 10px rgba(0,0,0,0.4);
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  .progress { opacity: 0.7; margin: 0 0 0.6rem; }
  canvas { width: 100%; height: auto; border-radius: 10px; touch-action: none; display: block; }
  .hint { opacity: 0.55; font-size: 0.85rem; margin: 0.4rem 0 0; text-align: center; }
  .names-toggle { display: flex; align-items: center; justify-content: center; gap: 0.5rem;
    font-size: 0.85rem; opacity: 0.8; margin-top: 0.6rem; cursor: pointer; }
  .names-toggle input { width: auto; }
  .timer-wrap { display: flex; justify-content: center; margin-bottom: 0.4rem; }
  .timer-ring { transform: rotate(-90deg); } /* start depleting from 12 o'clock */
  .timer-ring .track { fill: none; stroke: #12293d; stroke-width: 6; }
  .timer-ring .prog { fill: none; stroke: #3ea672; stroke-width: 6; stroke-linecap: round; }
  .timer-ring text { fill: #eaf2f8; font-size: 20px; font-weight: 700; transform: rotate(90deg); transform-origin: 30px 30px; }
  .timer-ring.low .prog { stroke: #d1495b; }
  .timer-ring.low text { fill: #d1495b; }
  .toast { position: fixed; top: 1rem; left: 50%; transform: translateX(-50%); z-index: 100;
    display: flex; align-items: center; gap: 0.5rem; background: #12293d; border: 1px solid #f2c14e;
    color: #eaf2f8; padding: 0.6rem 1rem; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    animation: toast-in 0.35s ease; }
  .toast-emoji { font-size: 1.5rem; }
  @keyframes toast-in { from { opacity: 0; transform: translate(-50%, -12px); } to { opacity: 1; transform: translate(-50%, 0); } }
  .fact {
    margin: 0.4rem 0 0.9rem; padding: 0.6rem 0.75rem; border-radius: 8px;
    background: rgba(255, 255, 255, 0.06); border-left: 3px solid #f2c14e;
    font-size: 0.92rem; line-height: 1.4; opacity: 0.92; text-align: left;
  }
  .miss {
    margin: 0.1rem 0 0.5rem; display: flex; align-items: center; gap: 0.45rem;
    font-size: 0.95rem; font-weight: 600; color: #f2c14e;
  }
  /* Rotated SVG rather than a directional emoji: emoji rendering is inconsistent across platforms
     (see the flag fallback above) and rotation gives the exact bearing, not one of eight arrows. */
  .arrow { flex: none; }
  .arrow path { fill: none; stroke: #f2c14e; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .fact-src { opacity: 0.5; font-size: 0.78rem; white-space: nowrap; }
  .welcome { text-align: center; padding: 2rem 1rem; }
  .welcome h2 { font-size: 1.6rem; margin: 0; }
  .welcome-sub { opacity: 0.8; margin: 0.5rem 0 0; }
  .version {
    position: fixed;
    bottom: 6px;
    right: 8px;
    font-size: 0.7rem;
    opacity: 0.4;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
  }
  .loading { opacity: 0.7; }
  button { margin-top: 0.9rem; width: 100%; padding: 0.9rem; font-size: 1.05rem; font-weight: 600;
    border: 0; border-radius: 10px; background: #f2c14e; color: #0b1e33; cursor: pointer; }
  button:disabled { background: #33506b; color: #7f97ab; cursor: not-allowed; }
  .result { font-size: 1.1rem; margin-top: 0.8rem; }
  .result.good { color: #3ea672; }
  .card { text-align: center; }
  .bonus-line { font-size: 1.05rem; font-weight: 600; margin: 0.2rem 0 0.6rem; }
  .bonus-line.good { color: #3ea672; }
  .share { display: inline-block; text-align: left; background: #12293d; padding: 1rem; border-radius: 10px; }
</style>
