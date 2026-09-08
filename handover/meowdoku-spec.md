# Meowdoku — Web Game Specification

**Purpose:** Recreate the mobile puzzle game *Meowdoku* as an ad-free, installable, mobile-first web app.
**Audience:** This document is handed first to a design agent (visual/UX pass), then to a full-stack coding agent. Sections are tagged **[DESIGN]**, **[ENGINEERING]**, or both. Anything marked *Open decision* is a choice the human owner may revise after the design pass.

---

## 1. Game overview [DESIGN + ENGINEERING]

Meowdoku is a "Star Battle / Queens"-style logic puzzle:

- An **N×N grid** (N = 5 to 15; the reference level is 11×11) is partitioned into **N irregular colour regions**.
- The player must place exactly **N cats** such that:
  1. **One cat per colour region**
  2. **One cat per row and one per column**
  3. **Cats cannot touch** — no two cats may be in adjacent cells, including diagonally (the 8-neighbourhood)
- Every level has **exactly one solution** and is solvable by pure deduction (no guessing needed).
- Players have **3 lives (fish)** per level. A wrong cat placement costs one life. Losing all three fails the level.
- The player wins when all N cats are correctly placed.

There is no timer in the reference game. The puzzle is calm, not frantic.

---

## 2. Reference screenshot breakdown [DESIGN]

Layout of the original, top to bottom (portrait phone):

| Zone | Contents |
|---|---|
| Top bar | Back button (left), **Level 63** and **Score 0** labels (centre, large numerals), Settings gear (right). All in rounded white pill/circle chips on a cream background. |
| Status row | Two white pills: **cat-face icon + `0/11`** (cats placed / total, count in green) and **three fish icons** (lives; spent lives shown greyed-out / faded). |
| Rules strip | One wide white rounded card containing three mini-cards, each with a tiny 3×3 pictogram and label: *"1 Cat per color"*, *"1 Cat per column and row"*, *"Cats cannot touch"*. |
| Board | White rounded card holding the grid. Cells are rounded squares with a visible gap (~8% of cell size). Region colours are soft pastels. |
| Bottom toolbar | Two large circular white buttons with red numeric badges: **winking cat** (badge `2`) = "reveal a cat" power-up; **light bulb** (badge `3`) = hint. |

Cell marks seen in the screenshot:
- **White cross (×)** on a coloured cell = player-marked "not a cat".
- **Red/orange cross (×)** on a coloured cell = wrong cat guess (cost a life; one fish is greyed out).
- Confirmed cats are shown as a cat face on the cell (not visible in this screenshot — see §7).

### 2.1 Palette extracted from the screenshot

Background cream `#F5F0EB`. Card white `#FFFFFF`. Text/icon dusky brown `#8A5A5A` (titles), dark brown `#6B4A3A` (pictograms).

Region colours (11 used on the reference level):

| Key | Name | Hex (approx.) |
|---|---|---|
| O | Orange | `#F2A66E` |
| G | Forest green | `#4E9A5F` |
| Y | Gold / mustard | `#D3B23B` |
| B | Light blue | `#B8D2EE` |
| T | Teal | `#4FAFB8` |
| P | Pink | `#EFA6E4` |
| L | Yellow | `#F2DE8C` |
| R | Brown | `#9C6F49` |
| M | Light green | `#A6D98A` |
| U | Purple | `#8C7FE0` |
| K | Magenta / rose | `#CB6F98` |

Provide at least **17 region colours** so 15×15 levels have two spares. Every colour must remain distinguishable from its neighbours *and* pass a colour-blind check (see §12). Consider a subtle pattern/icon-in-corner option for accessibility.

---

## 3. Sample level (real data) [ENGINEERING]

Transcribed from the screenshot. Verified by brute-force solver: **exactly one solution**. Use it as the first fixture/test level.

```
Level: 63   Size: 11
OOOOOOGGGGY
OOOBBBBBGYY
TTOOOBPBBYY
TTTBOBPPBYB
TLBBBBPPBYB
LLBRRRPMBBB
LLBBRRMMUBB
LLLBRRMMUBB
KKLBRBMMUBB
KKKBRBUUUBB
KKKBBBUUUBB
```

Solution (row → column, 0-indexed): `[9, 3, 10, 4, 0, 6, 1, 5, 7, 2, 8]`

(The red-cross in the screenshot at row 1, col 8 is consistent: that cell is not a cat.)

---

## 4. Level data model [ENGINEERING]

```ts
type Level = {
  id: string;            // "0063"
  number: number;        // 63 (display)
  size: number;          // N
  regions: string[];     // N strings of N chars; each char = region key
  solution: number[];    // solution[row] = column of the cat
  difficulty: 1|2|3|4|5; // derived from solver technique depth
};
```

- Region keys map to palette entries via a stable lookup so the same key always renders the same colour within a level. Keys are reassigned per level so adjacent regions never share a hue.
- Levels ship as a static JSON bundle (`/levels/pack-01.json`) generated offline by a script (§5). ~200 levels for v1 is plenty.
- Board size progression (open decision, suggested): levels 1–10 → 5×5, 11–25 → 6×6, 26–45 → 7×7, 46–70 → 8×8, 71–100 → 9×9, 101–140 → 10×10–12×12, 141+ → 13×13–15×15 (expert tier; regions get larger and more interlocking rather than just more numerous).

---

## 5. Level generator & solver [ENGINEERING]

Ship a Node/TS script (`scripts/generate-levels.ts`) — **not** part of the client bundle.

**Solver (backtracking):** place one cat per row; prune on column, region, and 8-neighbour conflicts. Count solutions with early exit at 2. Must run < 200 ms for 15×15 (count with early exit at 2; use bitmasks for column/region/adjacency pruning).

**Generator:**
1. Generate a random valid cat placement (rows/cols permutation satisfying non-adjacency).
2. Seed N regions, one at each cat cell.
3. Grow regions by random flood-fill until every cell is assigned. Bias growth toward irregular, organic shapes (the reference has regions ranging from 3 to ~40 cells).
4. Run the solver; **keep only if exactly one solution**.
5. Optionally run a human-technique solver (single-candidate, row/region elimination, region-forces-row, neighbourhood elimination) to grade difficulty; reject puzzles that need guessing.
6. Retry until the target count is reached; write JSON.

Include a `validate-levels` test that re-checks uniqueness for every shipped level.

---

## 6. Cell state machine [ENGINEERING + DESIGN]

Each cell is in exactly one state:

| State | Meaning | Visual |
|---|---|---|
| `empty` | Untouched | Plain region colour |
| `x` | Player-marked "not a cat" | White × on region colour |
| `cat` | Correct cat, locked | Cat face on region colour |
| `wrong` | Wrong cat guess, locked | Red × on region colour |

### 6.1 Input rules (must match the original feel)

Use Pointer Events on the board container (one listener, not per-cell). Distinguish **tap** vs **drag** with a movement threshold of ~6 px and a hold threshold of ~350 ms for long-press.

| Gesture | On `empty` | On `x` | On `cat` | On `wrong` |
|---|---|---|---|---|
| **Tap** | → `x` | → **attempt cat** (see below) | no-op | no-op |
| **Double-tap** (two taps < 300 ms) | → attempt cat (equivalent to tap-then-tap; implement naturally through the tap rule, do not add separate detection) | — | — | — |
| **Long-press** *(open decision — not in original)* | no-op | → `empty` (undo an X) | no-op | no-op |
| **Drag** (pointer down then move) | Paints `x` onto every **`empty`** cell the pointer passes over. Cells that are `x`, `cat`, or `wrong` are **never changed** by a drag. | Drag that *starts* on a non-empty cell does nothing. | | |

Drag details:
- The cell under `pointerdown` is included in the paint set once movement crosses the threshold (if it was empty). If the pointer is released without crossing the threshold it is a tap instead.
- Track cells via `elementFromPoint` or grid-math on pointer coordinates; add each newly entered cell once. Use `setPointerCapture` so dragging outside the board keeps working.
- Prevent page scroll while dragging on the board (`touch-action: none` on the board).
- Haptic tick (`navigator.vibrate(8)`) on each newly painted cell where supported (open decision).

**Attempt cat:**
- If the cell is the solution for its row → state `cat`, play the cat pop animation, increment `catsPlaced`. If `catsPlaced === N` → win sequence.
- Else → state `wrong`, decrement lives, shake the cell, grey out one fish. If lives reach 0 → fail sequence.
- *Open decision:* on a correct cat, optionally auto-mark all cells in the same row, column, region, and 8-neighbourhood as `x` (an "auto-X" setting, off by default to match the original).

---

## 7. Game flow & screens [DESIGN + ENGINEERING]

### 7.1 Screens
1. **Home** — logo/mascot, "Continue (Level N)" primary button, "Level select", "Settings". Keep it to one screen; no splash video, no daily-reward popups. That is the whole point of this clone.
2. **Level select** — scrollable grid of level tiles: completed (cat face), current (highlighted), locked (greyed, unlockable only in order). Show best score/stars per level.
3. **Game** — as in §2. This is 90% of the product.
4. **Win overlay** — modal card: "Purrfect!", cat celebration, score breakdown, "Next level" / "Level select".
5. **Fail overlay** — "Out of fish", "Retry" (restores lives and resets the board), "Level select". No ad-for-extra-life mechanics.
6. **Settings** — sound, haptics, colour-blind mode, auto-X, reset progress.

### 7.2 Header counters
- `Level N`, `Score` (see §8).
- `cats placed / N` — turns green when complete.
- Lives: 3 fish, spent ones rendered at ~35% opacity and desaturated.

### 7.3 Power-ups
- **Reveal cat** (winking cat button, badge shows remaining, e.g. 2): places one correct cat in a deterministic order (first unsolved row). Does not cost a life.
- **Hint** (bulb button, badge 3): highlights one cell the human-technique solver can prove is *not* a cat (prefer a cell whose elimination unblocks the next deduction), and briefly shows a one-line explanation, e.g. "This row's green region only has cells here". Marks that cell `x`.
- Both are per-level allowances (reset each level). *Open decision:* global pool vs per-level; original appears per-level.
- Using either power-up reduces the level's score (§8).

### 7.4 Win / fail sequences
- Win: all cat cells bounce in sequence, confetti (light, 1 s), then overlay. Progress saved before the overlay shows.
- Fail: board dims, fish icon wobbles, overlay after 600 ms.

---

## 8. Scoring [ENGINEERING] *(open decision — simple v1 proposal)*

The reference shows "Score 0" at the start; exact formula unknown. Proposed:

- Base: `100 × N`
- −10% per life lost, −15% per power-up used
- Stars: 3 = no lives lost & no power-ups, 2 = ≤1 life lost, 1 = completed
- Level select shows stars; Home shows lifetime total score.

---

## 9. Persistence [ENGINEERING]

- `localStorage` key `meowdoku:v1` holding `{ currentLevel, completed: {levelId: {stars, score}}, settings, inProgress?: {levelId, cellStates, lives, powerUpsLeft} }`.
- Save the in-progress board after every state change so refresh/backgrounding never loses a puzzle.
- No accounts, no server state. Export/import progress as a JSON string in Settings (nice-to-have).

---

## 10. Tech stack & delivery [ENGINEERING]

- **Vite + React + TypeScript**, no UI framework needed; Tailwind or CSS modules for styling. State via a small reducer (`useReducer`) or Zustand; the board reducer must be pure and unit-testable.
- **PWA:** manifest (standalone display, portrait orientation, icons 192/512, maskable), service worker precaching the whole app + level packs so it works fully offline. Installable to the home screen — this replaces the native app.
- **Rendering:** the grid as absolutely-sized CSS grid; cells are `div`s (SVG not required). Board sizes to `min(100vw − padding, available height)`; for N ≥ 13 wrap the grid in a zoom/pan container (CSS transform, not native page zoom). Must work from 320 px wide up to tablet, and in desktop browsers as a centred phone-width column.
- Zero network requests after first load. Zero third-party scripts. No analytics by default.
- Deploy as static files (Vercel/Netlify/GitHub Pages).

---

## 11. Visual & motion design brief [DESIGN]

Match the original's warmth but don't clone its assets:

- **Tone:** cosy, pastel, rounded everything. Cream background, white cards with soft shadow (`0 4px 16px rgba(0,0,0,0.06)`), 16–24 px radii on cards, ~18% radius on cells.
- **Typography:** rounded sans (e.g. Nunito / Quicksand / Fredoka). Level & score numerals large and bold in dusky brown.
- **Cat mark:** an original simple cat face (black-and-white tuxedo like the reference is a good default; consider letting the player pick a cat "skin" in Settings). Must read at 24 px.
- **X marks:** white, ~55% of cell size, stroke-width ~14% of cell, rounded caps. Wrong guess uses `#E5613D`-ish coral red, same geometry.
- **Motion:** cat placement = scale 0→1.15→1 with overshoot (180 ms). Wrong = horizontal shake (3 cycles, 250 ms) + fish fade. X paint = 80 ms fade-in. Respect `prefers-reduced-motion`.
- **Sound (optional, off until user enables):** soft "mew" on correct cat, low "bonk" on wrong, tiny tick on X.
- Deliverables from the design pass: Home, Level select, Game (5×5 and 11×11 states, including mid-game with all four cell states and one spent life), Win overlay, Fail overlay, Settings, plus the component sheet (cells in every state, buttons, pills, fish states) and the final colour palette with tokens.

---

## 12. Accessibility [DESIGN + ENGINEERING]

- Colour-blind mode: overlay a small distinct glyph or pattern per region (dots, stripes, letters). Verify the palette under deuteranopia/protanopia simulation.
- Minimum touch target: at 15×15 on a 360 px-wide phone cells are only ~22 px, below comfortable touch size. For N ≥ 13 the board must support **pinch-to-zoom and two-finger pan** (zoomed board scrolls inside the card; single-finger drag still paints X). Alternatively collapse the rules strip on large boards to buy vertical space. All buttons ≥ 44 px.
- Keyboard play on desktop: arrow keys move focus, `X` marks, `Enter`/`Space` attempts cat, `Backspace` clears. Focus ring visible.
- Screen reader: each cell has `aria-label` "Row 3, column 5, orange, marked not a cat". Live region announces lives and cats placed.
- Text contrast ≥ 4.5:1 for labels on cream/white.

---

## 13. Testing [ENGINEERING]

- Unit: solver (uniqueness, speed), board reducer (every transition in §6), scoring, persistence round-trip.
- Fixture: the §3 sample level must solve to the listed solution and reject the red-cross cell.
- Interaction tests (Playwright, mobile viewport): tap → X; tap X → cat/wrong; drag paints only empty cells; drag starting on X paints nothing; lives decrement; win and fail overlays appear; refresh restores the board.
- Lighthouse PWA score ≥ 90; app loads offline after first visit.
- 15×15 board renders and drag-paints at 60 fps on a mid-range Android device; pinch-zoom works without interfering with tap/drag.

---

## 14. Acceptance criteria (v1 done when…)

1. All three rules enforced; every shipped level verified unique by the test suite.
2. Tap / double-tap / drag behave exactly as §6, on iOS Safari and Android Chrome, with no scroll fighting.
3. 3 lives, reveal-cat and hint power-ups, win/fail overlays, level progression, score & stars.
4. Progress persists across refresh and app relaunch; works fully offline; installable.
5. No ads, no popups, no network calls after load.
6. Passes §12 accessibility checks; playable with keyboard on desktop.

---

## 15. Out of scope for v1 (possible later)

Daily puzzles, themes/cat skins beyond a picker, timer/speed mode, cloud sync, leaderboards, an in-browser level editor, undo history beyond long-press clear.
