# The Meowdoku party server

The multiplayer authority: room codes, match timing, solution verification and
progress fan-out. It runs on Cloudflare Workers, entirely separately from the
Vercel frontend, and the two are joined only by a host name and a
Content-Security-Policy entry.

## Which runtime, and why

**PartyServer (`partyserver` 0.5.10) on Cloudflare Workers, deployed with
wrangler.** Not the `partykit` CLI.

Both were checked. `partykit`, the hosted platform CLI, last published
0.0.115 in September 2025 from `github.com/partykit/partykit`. `partyserver`
last published in August 2026 from `github.com/cloudflare/partykit`, alongside
`partysocket` 1.3.0 in June 2026. The programming model is identical — a class
per room backed by a Durable Object, with `onConnect`, `onMessage`, `onClose`
and `broadcast` — but PartyServer runs on Workers directly instead of on a
hosted platform that is no longer being released. When two options are
equivalent, take the maintained one. The client library is `partysocket` either
way.

## Shape

| File               | What it is                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`        | The Worker entry. Allocates codes, answers "is this code live", canonicalises and origin-checks a socket, then hands over to PartyServer. |
| `room.ts`          | One Durable Object per room code. The clock, the referee, the fan-out.                                                                    |
| `registry.ts`      | One Durable Object for the whole deployment. Decides which codes are in use.                                                              |
| `env.ts`           | The bindings, merged into `Cloudflare.Env`.                                                                                               |
| `lib/directory.ts` | The live-room table: allocate, heartbeat, release, sweep. Pure.                                                                           |
| `lib/levels.ts`    | Generates and caches the level solutions the server verifies against. Pure.                                                               |
| `lib/names.ts`     | Display-name deduplication. Pure.                                                                                                         |
| `lib/rateLimit.ts` | Per-connection token buckets. Pure.                                                                                                       |
| `lib/snapshot.ts`  | What a room writes to Durable Object storage, and how it reads it back. Pure.                                                             |

Everything under `lib/` is free of Workers globals so it can be unit-tested in
Node — see `tests/unit/server-*.test.ts`. Everything above it needs a Worker.

The rules are not here. `src/multiplayer/match.ts` is a pure rulebook the client
imports too, so both ends compute the same podium from the same recorded
finishes. This directory supplies the three things a pure function cannot: a
clock, a socket, and somewhere to put the answer.

## Local development

```sh
pnpm party:dev        # wrangler dev on http://127.0.0.1:8787
pnpm party:typecheck  # tsc against party/tsconfig.json
pnpm exec vitest run tests/unit/server-directory.test.ts   # and the other server-*.test.ts
```

`wrangler dev` runs the real workerd, real Durable Objects and real storage
under `.wrangler/`, so local behaviour matches production including alarms and
evictions. Point the app at it with:

```
VITE_PARTY_HOST=127.0.0.1:8787
```

Leave `ALLOWED_ORIGINS` unset locally; the Vite dev server's port moves around
and an unset allowlist means "any origin".

## Deployment

```sh
pnpm party:deploy                        # wrangler deploy
pnpm party:tail                          # live logs
```

The first deploy prints the worker's URL, `meowdoku-party.<subdomain>.workers.dev`.

Then, and these are the steps nobody else can do for you:

1. **Cloudflare account and plan.** `wrangler login` once. The Workers **Paid**
   plan is required: generating a board costs 1–113 ms of CPU (measured across
   the multiplayer bands) and the Free plan's per-invocation CPU allowance is
   below that. `wrangler.toml` sets `[limits] cpu_ms = 5000`.
2. **Lock the origin down.** Set `ALLOWED_ORIGINS` to exactly the frontend's
   origin — `https://meowdoku.vercel.app`, or whatever the production domain is
   — either in `wrangler.toml`'s `[vars]` followed by a redeploy, or with
   `wrangler secret put ALLOWED_ORIGINS`. Until it is set, any page on any
   origin can open a socket.
3. **Point the app at it.** Set `VITE_PARTY_HOST` in the Vercel project for
   Production, Preview and Development, to the worker's host with no scheme and
   no trailing slash:

   ```
   VITE_PARTY_HOST=meowdoku-party.<subdomain>.workers.dev
   ```

4. **Widen the Content-Security-Policy.** `vercel.json` currently sends
   `connect-src 'self'`, which blocks a WebSocket to any other origin. It has to
   name exactly this origin and nothing more:

   ```
   connect-src 'self' https://meowdoku-party.<subdomain>.workers.dev wss://meowdoku-party.<subdomain>.workers.dev
   ```

   Both schemes are needed: `https:` for the `POST /rooms` call, `wss:` for the
   socket. That edit belongs to whoever owns `vercel.json`.

A custom domain (`party.meowdoku.app`) is optional and changes only the host
name in steps 3 and 4.

## HTTP and WebSocket surface

| Route                    | Purpose                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `GET /health`            | `{ ok, protocol, serverTime }`. Cheap. This is what the app calls to decide whether to offer multiplayer at all. |
| `POST /rooms`            | Allocates a code: `201 { code }`, or `503 { error }` when the registry is momentarily out of codes.              |
| `GET /rooms/:code`       | `{ exists, code }` for a code typed into the join field.                                                         |
| `WS /parties/room/:code` | The room socket.                                                                                                 |

All four send CORS headers for the allowed origin.

## What the client must do

**Pass a stable connection id.** PartyServer takes the player id from the `_pk`
query parameter, which `partysocket` sets from its `id` option. The server finds
a reconnecting player's seat by that id, so it must survive a dropped socket
**and a page reload** — persist it per room in `sessionStorage`. Without it, a
refresh mid-match reads as "left the room" and forfeits the level.

```ts
const socket = new PartySocket({
  host: import.meta.env.VITE_PARTY_HOST,
  party: 'room', // kebab-case of the `Room` binding
  room: code, // canonical, from parseRoomCode
  id: stablePlayerId,
})
```

Send `{ t: 'join', v: PROTOCOL_VERSION, name }` as the first message. A
connection that has not joined within ten seconds is closed.

## Decisions worth knowing

**Codes are unique among live rooms, and a singleton decides it.** A Durable
Object cannot see its siblings, so one object — `Registry` — owns the table. It
processes one request at a time and reserves a code synchronously before any
`await`, which is what settles two hosts creating a room in the same
millisecond: the second allocation sees the first one's reservation. 27^5 codes,
a guardrail at 2,000 live rooms, eight retries, and a clean failure rather than
a loop if they all collide.

**Codes are recycled.** A room heartbeats while it has players and releases its
code when it empties (a minute after the last socket closes). The registry
sweeps anything that has not reported in for thirty minutes, which covers the
room that crashed without releasing.

**Memory first, storage as a seatbelt.** Room state lives in fields. A snapshot
is written to Durable Object storage on transitions — someone joins or leaves, a
level starts, a level resolves, a match ends — so an eviction mid-match is
recoverable by clients that reconnect within the grace period. Progress samples
are never written: they arrive four times a second, are worthless a tick later,
and are re-sent as soon as a client reconnects. The level solutions already
generated are written, so a restart does not rebuild boards it has played.

**Hibernation is off.** A match is minutes long and continuously active, and the
room depends on in-memory timers and per-connection rate limits. The durable
alarm is the backstop for the eviction that happens anyway: every deadline is
armed both as a `setTimeout` (precise, free) and as a storage alarm (survives a
restart), and both call the same idempotent tick.

**The server is the clock.** Every duration that decides a placing is measured
between a level start the server broadcast and a claim the server accepted.
`clientMs` on the wire is never read. In blaze, where players diverge, each
player's next level starts the instant their solve is accepted.

**Completion is verified, not trusted.** The server generates the level from its
number and compares the claimed cat columns against the one solution the board
has. Measured cost across the multiplayer bands: mean 1 ms on easy, 22 ms on
standard, 12 ms on hard, worst case 113 ms at level 40. That is affordable once
per level and not per claim, so levels are generated ahead of time — during the
three-second countdown, and during each six-second interlude — and cached for
the life of the room. A claim then costs an array comparison at the exact moment
eight players are racing to submit.

**Mid-match joining is refused**, deliberately. A newcomer would either be handed
a schedule they cannot win or change what every ranking means. They wait for the
podium, which turns the room back into a lobby that accepts joins and rematches.

**Progress is coalesced.** Samples land in a set and one message goes out per
250 ms carrying at most eight small tuples, so a busy room costs what the clock
says, not what the players do.

**Disconnection versus departure.** A drop keeps the seat and the clock running
for thirty seconds; a reconnect with the same id walks straight back into it,
and is re-sent the schedule and the current level's clock. After that, or on an
explicit `leave`, the player is retired — which forfeits the level in progress
even if a solve was already banked, because an absent player must not win a
level, take a point, or spare someone from a knockout. The seat itself is kept
so the podium can still put a name to the id.

## Integration note

`tsconfig.app.json` is a composite project, so every file its program reaches
must be matched by `include`. The server unit tests import `party/lib/*`, so
that project's `include` needs `"party/lib"` alongside `"src"` and
`"tests/unit"`. Nothing under `party/lib` touches a Workers global, and
`party/room.ts`, `party/registry.ts` and `party/server.ts` stay out of the app's
program entirely.
