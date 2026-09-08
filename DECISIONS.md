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
