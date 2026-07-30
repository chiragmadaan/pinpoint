# Further improvements (backlog)

Ideas surfaced during development that are worth doing but were deliberately deferred.

## Smarter calendar assembly — balance person-question placement across tiers

**Problem.** The per-day rule allows at most one "person" question (birthplace/nationality/deathplace).
With the current content that caps the calendar at ~108 days, because the **hard tier is
person-heavy** and has only ~94 non-person questions:

```
person / non-person per tier:  easy [115, 126]   medium [1787, 417]   hard [906, 94]
```

The greedy assembler picks easy → medium → hard and lets easy *and* medium take person questions
first, forcing the hard slot to spend its scarce ~94 non-person questions almost every day — so it
runs dry around day 108.

**Fix.** Each day has one "person budget" — spend it in the tier where non-person supply is
*scarcest* (hard), leaving the abundant non-person supply in easy/medium for the other two slots.
A balancing heuristic (place the day's person question in the currently-scarcest-non-person tier,
or a small bipartite matching over a window of days) should reach the theoretical **~220 days with
zero content changes** — roughly a 2× recovery.

**Also helps:** generating more non-person *hard* content (obscure landmarks, dishes, country
attributes) raises the ceiling further, but the assembly change is free.

Relevant code: `tools/content-gen/src/build.ts` → `assembleCalendar` (the `pick` function and the
per-day tier loop).

## Disputed-territory birthplace blind spot

The disputed-answer denylist (`generate.ts` `DISPUTED_ISO` / `DISPUTED_PEAKS`) covers answers that
*are* disputed. It does **not** catch `birthplace` questions where the person's birth city is in a
disputed region (e.g. Crimea, Kashmir, Tibet, Taiwan) but the answer is a claimant country — the
prompt names the person, not the city. Resolving each Wikidata birthplace to coordinates and
dropping those in disputed regions would close this. ~18 such questions today (answers in
border-contested countries) are unverified.

## Higher-resolution coastlines (full 1:50m map) — optional

DONE: the ~59 missing micro-states/territories (Singapore, Vatican, Puerto Rico, Mauritius, Malta,
Bahrain, Maldives, the Caribbean small states, etc.) were **spliced** into `countries.geo.json` from
Natural Earth 1:50m — 180 → 239 features for only +15% vertices (10.7K → 12.3K) and +70 KB. Viewport
culling was also added to `render.ts` (`inViewport`). Content-gen reads this same map file for its
`allowed` set, so **a regen now generates questions for those 59 countries** (mostly non-person
locate/flag/capital/currency — which also helps the calendar-length problem above).

REMAINING (optional): the existing 180 countries still use coarse **1:110m** coastlines (blocky).
Swapping the whole map to 1:50m would smooth them, but the decoded GeoJSON is **3.7 MB (1.4 MB gz)**
and **~99K vertices (~9×)** → mobile pan/zoom jank at the world view. To pursue it: ship the 739 KB
**TopoJSON** (231 KB gz) and decode at runtime (`data.ts` `featuresFromTopoJSON` + a numeric→ISO3
map), AND add **geometry simplification** (Douglas–Peucker) to cut vertices. Only worth it if the
blocky coastlines become a real complaint — the micro-state gap (the actual problem) is already fixed.

## Geo-localized map borders

The map uses one border set (LoC-cut Kashmir, Taiwan as a separate country, etc.), which is
rejected by India and China. The only approach that's actually safe in those markets is serving
region-specific border geometry by user locale/IP (as Google/Apple do). Large effort + ongoing
maintenance; required before distributing in India/China. See the game-design doc's borders notes.

## Rotated / leader-line labels for thin countries

Country-name labels stay on their own landmass and are dropped (until you zoom in) when they can't
fit — so thin countries (Togo, Chile) show their name only at high zoom. Rotating labels along a
country's long axis, or leader lines, would let more small/thin countries show a name earlier.
Relevant code: `packages/map/src/labels.ts` → `layoutLabels`.
