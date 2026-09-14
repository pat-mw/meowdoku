# Decisions

Choices made while building Meowdoku that the handover, spec, stack doc and
design export did not settle between them. Each entry records what was chosen
and why, so a later reader does not have to re-derive it.

Authority order (from the handover): handover > stack doc (tech) > spec
(behaviour) > design export (visual only).

---

## Scaffold

**Vite 8 + `@vitejs/plugin-react` 6.** The stack doc says "Vite (latest 6/7)".
Vite 8 is current and `@vitejs/plugin-react@6` peer-requires it; every other
plugin in the stack (PWA, Tailwind, TanStack router) declares Vite 8 support.

**React Compiler via Babel, not the oxc port.** `@vitejs/plugin-react@6` offers
an experimental Rust React Compiler (`compiler: true`, needs
`oxc-transform-react`) and the stable Babel route. The stack doc names
`babel-plugin-react-compiler` stable 1.0 explicitly, so the build uses
`@rolldown/plugin-babel` with `reactCompilerPreset()`.

**TypeScript 5.9, not 7.0.** TypeScript 7 (the native port) is published but the
typed-router and ESLint toolchain here is built against the 5.x line;
`typescript-eslint` peer-caps at `<6.1.0`.

**Nunito latin subsets only.** The UI is English. Shipping only `latin` and
`latin-ext` keeps the precache small while covering every glyph the app draws.
Licensed under the SIL OFL; licence shipped alongside the font files.

## Level identity

**Level number is the identity.** The spec's 4-digit `id` ("0063") existed for a
static level pack. Levels are procedural and unbounded, so `Level.number` is the
only identifier, and saves key completion by the number as a decimal string.

**`Level` carries `tier` and `depth` instead of the spec's `difficulty: 1..5`.**
The spec derived `difficulty` from "solver technique depth"; the handover
replaces that with an explicit 1-7 technique scale plus a tier table. Keeping
both would let them disagree, so the derived field is dropped and the two real
inputs are stored.

## Cell encoding

**Cell states stay numeric (`0 empty, 1 x, 2 cat, 3 wrong`)** and boards persist
as digit strings, matching the design export's save shape. This keeps an
in-progress 15x15 board at 225 bytes and makes the save human-inspectable.

## Interaction

**A long press consumes the press on every cell state, not just on a marked
one.** The design prototype only started a long-press timer on an `x` cell, so a
slow press on an empty cell fell through to the tap handler and marked it. The
handover's gesture table says a long press on an empty cell is a no-op, and the
handover outranks the design export, so the timer now runs on every press and
the reducer decides what (if anything) it means. The practical effect is that
resting a finger on the board never marks a cell.

**Double-tap detection lives in the input layer, tap semantics in the reducer.**
The reducer receives already-classified gestures (`tap`, `doubleTap`,
`longPress`, `paint`) rather than raw pointer events, which is what makes every
row of the gesture table directly unit-testable without a DOM.

**The reducer reports effects instead of firing them.** Sound and haptics are
side effects, but the board logic must stay pure. Each transition stamps an
`event` on the state and bumps `eventSeq`; the store turns that into a sound and
a vibration. Nothing in `src/board` knows those exist.

## Region growth

The handover's generator design — build a random valid cat placement, grow
regions around it, keep the board if it has exactly one solution — does not work
as written. Measured over twenty thousand attempts per size with evenly grown
regions:

| Board | Legal cat placements | Solutions a grown board has | Unique in 20,000 tries |
| ----- | -------------------- | --------------------------- | ---------------------- |
| 6x6   | 90                   | median 18                   | 26 (0.13%)             |
| 8x8   | 5,242                | median 340                  | 0                      |
| 11x11 | 5,296,790            | median 45,374               | 0                      |
| 15x15 | —                    | over 2,000,000              | 0                      |

Rejection sampling cannot find a needle in five million. Several plausible fixes
were built and measured, and none worked on its own: matching the reference
level's lopsided region sizes, making regions thin, and killing alternative
solutions one at a time all left the yield at or near zero above 8x8.

What works is a partition shaped for the job, then repaired with the solver in
the loop:

- **N-1 pocket regions** at or just above the tier's minimum size, plus **one
  basin region** taking 65% to 95% of the board. A five-cell pocket pins its cat
  to five candidates. The basin looks like filler but is the harsher constraint
  of the two: "exactly one cat in these 140 cells" forces the other fourteen out
  of two thirds of the board.
- **A repair loop driven by the exact solver.** An alternative solution dies the
  moment any cell it puts a cat on changes region, because that region then holds
  two of its cats. So the loop enumerates alternatives, counts how many place a
  cat on each cell, and moves the most-hit cell — one edit invalidating every
  alternative running through it. Below a handful of alternatives it switches to
  trying each legal move and keeping the one that leaves fewest solutions, and it
  rolls back to the best partition seen when a run of edits stops paying.

The repair loop, not the growth bias, is what carries the large boards. Without
it a 15x15 board is essentially never uniquely solvable; with it, about three
quarters are. Overall yield across sizes 5 to 15 is roughly 83%, every level from
1 to 4,812 generates on its own tier's acceptance rules rather than falling down
the degradation ladder, and the slowest tier builds a board in under half a
second.

The tier table's numbers are otherwise exactly as the handover specified, with
one correction the measurements forced:

**`minCandidatesAfterBasics` must be zero for any tier whose depth band tops out
at 2.** That field counts cells still unknown once the depth-1 and depth-2
techniques have run, and a puzzle solvable at depth 2 is by definition fully
cracked by them — so the count is always zero there, and any positive threshold
is unsatisfiable. The thresholds for the deeper tiers are set from the measured
tenth percentile of boards that already satisfy the tier's depth band.

## Interaction, continued

**A drag also erases.** The handover's gesture table says a drag starting on a
non-empty cell does nothing. In play that is frustrating: marking a row is one
sweep, but unmarking it is one tap per cell. A stroke now takes its direction
from the cell it began on — from an empty cell it marks, from a marked one it
erases — and the direction is fixed for the whole stroke, so a sweep never flips
halfway. Cats and wrong guesses stay locked and no stroke touches them, so a
drag can never undo real progress.

## Tap on a marked cell

**A tap on an `x` clears it; it does not attempt a cat.** The original spec's
gesture table has tap-on-`x` attempting a cat, on the reasoning that a
double-tap is just two taps and needs no separate detection. The handover
replaces that table wholesale with one where a tap toggles the mark off and a
genuine double-tap (two taps on the same cell within 300 ms) makes the attempt,
and the handover outranks the spec. Detection is therefore explicit, per cell,
in the input layer.

The consequence the product owner accepted: the first tap of a double-tap has
already marked the cell, so a double-tap on an empty cell runs
empty → `x` → cat attempt. That is expected, and the reducer's `doubleTap` case
attempts from either `empty` or `x` for exactly this reason.

## The viewport is zoomable

The stack doc calls for `user-scalable=no, maximum-scale=1`, to stop a
double-tap on a cell zooming the page instead of placing a cat. It also calls
for a Lighthouse accessibility score of 90 or better. Those two requirements
contradict each other: locking the viewport fails WCAG 1.4.4 and caps the
accessibility score at 79.

The lock is the wrong half to keep. A player who needs to magnify a 15x15 board
is exactly the player the setting would shut out, and the double-tap problem has
a narrower fix: `touch-action: none` on the grid and `preventDefault` on
pointerdown mean the gesture never reaches the browser, so the board does not
zoom while the rest of the page still does. Controls carry
`touch-action: manipulation` for the same reason.

With the lock removed, Lighthouse reports 100 for performance, accessibility and
best practices. An end-to-end test drives a genuine two-tap touch sequence on
WebKit and asserts both that the visual viewport scale is still 1 and that the
tap reached the game, so a regression here fails the build rather than shipping.

## Lighthouse no longer has a PWA category

Lighthouse 12 removed it, so `installable-manifest`, `service-worker`,
`maskable-icon` and `apple-touch-icon` are not audits any more and asserting on
them fails as "not a known audit". They have been dropped from the Lighthouse
config. Installability is verified instead against the deployed site — manifest,
icon resolution, iOS head tags and an active service worker — and by the release
checklist.

## The hint engine reasons rather than points

The first hint engine was a port of the design prototype's: it scanned for a
single cell and said one line about it, and when nothing matched it fell back on
"No cat can live here — safe to mark it off", which it produced by reading the
solution. That last branch was not a hint at all; it was a small reveal with no
reasoning attached.

The engine now works the way the puzzle does. It derives the deduction chain
from scratch and reports the next step: which rule applies, every cell that rule
settles, and why, naming the rows, columns and colours involved. The rules, in
the order it offers them, are the ones the difficulty model already measures —
eliminations from a placed cat, a colour pinned to one line, a line served by
one colour, k colours locked into k lines and its converse, a cell that would
smother a line, and one-step lookahead as a last resort.

Three choices shape it:

**It does not trust the player's own crosses.** Only placed cats and proven
wrong guesses are premises. A player who marks a cell by mistake would otherwise
be told, in confident prose, to cross off the very cell holding a cat. The chain
is re-derived each time and the first step that settles something the player has
not already settled is the one reported, so a hint is always both sound and new.
A property test asserts across forty levels and hundreds of board states that no
hint ever rules out a cell holding a cat.

**It never points at a cat.** Naming a cell that must hold one is what the
reveal power-up is for, and what it costs. Every hint eliminates.

**It marks at most twelve cells.** Some rules are enormously productive: on a
board with one very large region, a line served by a single colour rules out
every other cell of that colour — measured at up to eighty-four cells, a third
of a 15x15 grid from one tap. Sound, but it finishes the puzzle rather than
helping. The engine prefers a rule that fits inside the budget over one that has
to be trimmed, and says how many more follow the same way.
