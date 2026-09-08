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

## Region growth, and why the tier table changed

The handover's generator design — build a random valid cat placement, grow
regions around it, keep the board if it has exactly one solution — does not
work as written. Measured over twenty thousand attempts per size with evenly
grown regions:

| Board | Legal cat placements | Solutions a grown board has | Unique in 20,000 tries |
| ----- | -------------------- | --------------------------- | ---------------------- |
| 6x6   | 90                   | median 18                   | 26 (0.13%)             |
| 8x8   | 5,242                | median 340                  | 0                      |
| 11x11 | 5,296,790            | median 45,374               | 0                      |
| 15x15 | —                    | over 2,000,000              | 0                      |

Rejection sampling cannot find a needle in five million. Three plausible fixes
were built and measured, and all three failed on their own:

- **Matching the reference level's lopsided region sizes** (one 42-cell region,
  the rest 5 to 9). Still zero unique boards above 5x5.
- **Making regions thin**, since the reference has six regions only two or three
  columns wide. Still zero, and it produced one-cell regions.
- **Killing alternative solutions one at a time**, by moving a cell so two of a
  rival's cats share a region. A 15x15 board has millions of rivals; after nine
  moves there was no legal aimed move left and the count had not shifted.

What does work is a combination, and the split of labour matters:

1. **Lopsided growth.** Across the hundred levels shipped with the design
   export — every one of which is uniquely solvable — about half of each board's
   regions touch only one or two rows, sizes run from a single cell to forty per
   cent of the board, and one or two big regions absorb the rest. Growing that
   way takes an 11x11 board from ~45,000 solutions to a few dozen.
2. **A short hill-climb.** A few dozen is not one, so the partition is then
   walked downhill: move a boundary cell, keep the move only if the board has
   strictly fewer solutions. Counting is capped at the current best, so probes
   get cheaper as the board tightens.

Neither half works alone. Hill-climbing from an even partition is blind, because
every probe saturates the cap and no move looks better than another — that was
measured too: 1,391 probes at 11x11, zero accepted.

Result: every board size from 5x5 to 15x15 now yields uniquely solvable,
deduction-solvable boards, and every level from 1 to 4,812 generates on its
tier's own acceptance rules rather than falling down the degradation ladder.

### Consequences for the tier table

The handover says of its starting table: "tune the numbers, keep the shape."
Two numbers had to move, and both are recorded here because they are visible to
players.

**`minRegionSize` is 1 rather than 2 to 5.** The very small regions are what
make a board uniquely solvable — they pin a cat to a handful of cells. Holding
every region to three cells or more drops the yield above 12x12 to zero. The
generator therefore permits at most **one** single-cell region per board, which
is what the real game's own levels do; every other region has at least two
cells.

**The depth bands top out at 7 but realistically reach 5.** The seven-technique
scale is implemented in full, and the solver reports honestly which depth a
board needed. In practice the shallower techniques almost always suffice, so
boards needing depth 6 or 7 are vanishingly rare. Rather than write bands the
generator can never satisfy — which would send every hard level down the
degradation ladder and silently flatten the progression the table exists to
create — the bands were set to what is actually reachable. Depth still steps
from 1 at Kitten to 5 at Grandmaster, alongside board size going 5x5 to 15x15,
so the progression is real; it is the 6-and-7 ceiling that was aspirational.

Both changes are baked into `GENERATOR_VERSION` 1, which has not shipped, so no
save can reference the earlier numbers.

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
