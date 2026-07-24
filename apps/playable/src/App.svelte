<script lang="ts">
  import { onMount } from "svelte";
  import {
    scoreGuess,
    recordCompletedDay,
    todaysPuzzle,
    todayKey,
    type Adjacency,
    type DailyPuzzle,
    type GuessResult,
    type Iso3,
    type PlayerState,
    type PuzzleCalendar,
  } from "@pinpoint/core";
  import { loadPlayerState, savePlayerState } from "./storage";

  // In real build: fetch the static assets bundled with the app.
  // import calendar from "../../../data/questions.sample.json";
  let calendar: PuzzleCalendar | null = null;
  let adjacency: Adjacency = {};

  let puzzle: DailyPuzzle | null = null;
  let player: PlayerState | null = null;

  let index = 0; // which of the 3 questions
  let selected: Iso3 | null = null; // tapped-but-not-submitted country
  let results: GuessResult[] = [];
  let startedAt = 0;

  $: current = puzzle?.questions[index] ?? null;
  // The one Playables-shaped UI rule: never reveal the name on "locate" questions.
  $: guessLabel =
    current && current.clueType !== "locate" && selected ? `Guess: ${selected}` : "Guess";

  onMount(async () => {
    player = await loadPlayerState();
    // TODO: load calendar + adjacency from bundled static JSON, then:
    // puzzle = todaysPuzzle(calendar);
    startedAt = Date.now();
  });

  function submit() {
    if (!current || !selected || !puzzle || !player) return;
    const r = scoreGuess(current, selected, Date.now() - startedAt, adjacency);
    results = [...results, r];
    selected = null;
    if (index < 2) {
      index += 1;
      startedAt = Date.now();
    } else {
      const xp = results.reduce((s, x) => s + x.points, 0);
      player = recordCompletedDay(
        player,
        todayKey(),
        results.map((x) => x.verdict),
        xp,
      );
      void savePlayerState(player);
    }
  }
</script>

<main>
  <!-- Skeleton only. Real UI: <WorldMap> canvas + clue header + fixed bottom Guess bar. -->
  {#if current}
    <h1>{current.prompt}</h1>
    <p>Question {index + 1} / 3 · {current.difficulty}</p>
    <!-- map goes here; tapping sets `selected` via createWorldMap onSelect -->
    <button disabled={!selected} on:click={submit}>{guessLabel}</button>
  {:else}
    <h1>🌍 Geo Quiz</h1>
    <p>Loading today's puzzle…</p>
  {/if}
</main>
