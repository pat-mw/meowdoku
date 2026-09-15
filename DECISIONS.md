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

## Haptics

Vibration never fired once on an Android install, and lengthening the patterns
did not fix it. Research settled several things that had been guesses:

**The `Permissions-Policy` header is not the cause.** There is no `vibrate` or
`vibration` policy-controlled feature — it appears only as a hypothetical in old
Feature Policy drafts and was never specified or shipped. It is absent from the
W3C feature registry and from MDN's full directive list, and the sensor
directives we do send (accelerometer, gyroscope, magnetometer) address a
different subsystem entirely. The header was left alone.

**Deferring the call is fine.** `navigator.vibrate` needs _sticky_ user
activation, which never expires and is never consumed once the document has had
one qualifying interaction. A `requestAnimationFrame` callback or a store
subscriber is a perfectly valid place to call it, so the drag-paint flush was
never the problem.

**`pointerdown` does not grant activation; `touchend` does.** So the first
gesture of a session can be refused outright if it is a long press or a drag,
which complete no tap.

Two real defects were found and fixed:

- **Retrigger starvation.** Each call cancels the vibration in flight rather
  than queueing. A drag flushing once per animation frame reissued a short pulse
  every ~16 ms, restarting a linear resonant actuator that needs longer than
  that to spin up — perceptually, silence. A repeat of the pattern already
  playing is now dropped; a different pattern still interrupts, so a cat
  placement is never swallowed by paint ticks.
- **Winning and failing had no haptic at all**, and because a winning
  placement's event is replaced by the win event, finishing a level buzzed
  nothing whatsoever.

Every action now has its own pattern, designed as a shape rather than a
duration: rising for a placement, falling for an undo, flat for a refusal,
rhythmic for the win. All are odd-length, because Blink strips the trailing
pause from an even-length pattern, and all are at least 15 ms, below which an
LRA produces nothing detectable.

Beyond that the API cannot be forced. Android's own "Use vibration and haptics"
and "Touch feedback" toggles, Do Not Disturb and OEM battery savers all swallow
an accepted call silently — `navigator.vibrate` returns `true` whenever Chrome
hands the pattern to Android, regardless of what Android then does with it. So
Settings reports which of those worlds the device is in rather than a bare
on/off.

## The region palette

The seventeen region colours were measured pairwise in CIEDE2000 and
re-measured under simulated protanopia and deuteranopia. The worst pair in
typical colour vision was orange against peach at 7.43 — close enough that
adjacent regions of those two read as one shape. Under deuteranopia light green
against peach was 2.17, which is effectively the same colour.

The palette now floors at 11.53 for typical vision, 4.66 under deuteranopia and
4.43 under protanopia. Separation came from lightness and hue alone: no colour
gained chroma over its previous value, because turning the saturation up would
have solved the measurement and lost the design. Olive dropped out of the
gold/yellow/light-green cluster, jade turned blue-green away from the other two
greens, peach lightened away from orange, and teal darkened away from mint.
Every name still describes its colour, so `REGION_NAMES` and `REGION_KEYS` are
unchanged and neither the generator nor the hint engine is affected.

`MIN_REGION_SEPARATION` is 11 because a CIEDE2000 distance of about 1 is the
just-noticeable difference for a large patch; eleven is roughly ten times that
and is the highest floor all seventeen can clear while staying one soft warm
family. The dichromat floor of 4 records what is actually achievable rather than
what would be desirable: dichromatic vision is two-dimensional, so seventeen
categories cannot all be separated at a glance no matter how they are chosen.
Eight pairs remain below 8 under deuteranopia and seven under protanopia, and
the colour-blind letter overlay — not the palette — is the real accommodation.

One weakness is unchanged rather than fixed: the white cross on the palest
region has a contrast ratio of 1.34, and raising it would mean darkening the
pale end enough to undo the separation gains. It is the weakest overlay in the
design and it is no worse than it was.

Adjacency-aware key assignment — refusing to give perceptually close keys to
neighbouring regions rather than only refusing identical ones — was considered
and rejected. For typical vision it is no longer needed; for dichromats it is
the only remaining lever, but it would cost a generator version bump, constrain
the colouring stage at 15x15 where fifteen of seventeen keys are already in
play, and duplicate what the letter overlay already does.

## Dark mode

Only the surfaces and the ink change. The region colours stay exactly as they
are, because they are the puzzle's content rather than its chrome: a player
learns "the teal region" and it must be the same teal in either theme.

The dark values live in one block of custom properties and are applied from two
selectors — a `prefers-color-scheme` media query and a `data-theme` attribute —
because a media query cannot be reused as an attribute selector. Specificity
arbitrates: the attribute selector outranks the bare `:root` the media query
uses, so an explicit choice beats the system preference in both directions
without needing `!important`. A unit test asserts the two paths assign the same
properties to the same values, since nothing else would stop them drifting.

There is no inline bootstrap script to prevent a flash of the wrong theme,
because the Content-Security-Policy forbids inline scripts. The media query
covers the common case instead — a player whose phone is dark sees dark from the
first paint — and only someone who has explicitly chosen the theme their device
does not use can see a brief flash.

The one thing that could not simply inherit is the cat. It is a near-black
tuxedo, which vanishes into a dark card, so on the app's own surfaces it becomes
a warm grey-brown: light enough to show a silhouette, dark enough that the white
muzzle and eyes still read as white. A board cell keeps its pastel background in
either theme, so cells scope the cat back to its true colour.

## Text contrast is measured, not chosen

Adding a dark theme exposed that `--mdk-ink` was doing two jobs: the colour of
text, and the fill of the primary button. That works when ink is dark and the
button's label is cream, and breaks the moment ink inverts — the dark theme's
pale rose button carried cream lettering nobody could read. The same mistake sat
in the Export and Import buttons, whose background was a hard-coded light beige.

Filled controls now have their own tokens — `--mdk-primary` with
`--mdk-on-primary`, and `--mdk-surface-sunken` for the quieter pair — so a
colour that has to work as a background is never the same variable as one that
has to work as text. The primary button keeps its brand colour in both themes;
it is the one element that should look identical either way.

A contrast test then measured every foreground and background the components
actually pair, in both themes, and found that several light-theme values had
never met the bar the product itself sets. Muted copy was at 2.74:1 on cream
against a stated requirement of 4.5:1; the version line was at 1.63:1 and locked
level numbers at 1.55:1. All were adjusted by the minimum needed rather than
restyled.

One documented exception: gold stars on white sit at 1.84:1 and stay there.
Darkening gold far enough to clear 3:1 turns it olive and stops it reading as
gold, and the stars never carry information alone — a level tile's accessible
name states the count and the win overlay prints the score beside them.
