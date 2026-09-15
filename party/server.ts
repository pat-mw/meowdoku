import { getServerByName, routePartykitRequest } from 'partyserver'
import { parseRoomCode } from '../src/multiplayer/roomCode'
import { PROTOCOL_VERSION } from '../src/multiplayer/protocol'
import type { Env } from './env'
import { REGISTRY_NAME } from './registry'

export { Room } from './room'
export { Registry } from './registry'

/**
 * The Worker in front of the rooms.
 *
 * Three jobs, and deliberately no fourth. It hands out room codes, it answers
 * whether a code is live, and it lets a socket through to a room — canonicalised,
 * origin-checked and with a connection id the server chose — before PartyServer
 * takes over. Nothing about a match is decided here; the room object is the
 * authority and this is the door.
 *
 * Being the door means being the only place two things can be enforced. Room
 * creation is unauthenticated and consumes a shared, finite code space, so it
 * is rationed per caller here rather than trusted. And a connection's id is
 * assigned here rather than accepted from the query string, because PartyServer
 * would otherwise let a client name itself anything, including somebody else.
 *
 * ROUTES
 *   GET  /health          liveness and protocol version, for the connection
 *                         check the app runs before it offers multiplayer
 *   POST /rooms           allocate a code: `{ code }`, or 429/503 with
 *                         `Retry-After` when the caller or the deployment has
 *                         to wait
 *   GET  /rooms/:code     `{ exists }` for a code typed into the join field
 *   WS   /parties/room/:code
 */

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

/**
 * CORS, from an allowlist when one is configured.
 *
 * No cookies and no credentials cross this boundary — a room code is the only
 * thing resembling a secret and it is meant to be read aloud — so the
 * allowlist is about keeping someone else's page from quietly farming room
 * codes, not about protecting a session. Unset means "any origin", which is
 * what makes `wrangler dev` usable from a Vite dev server on a random port.
 */
const allowedOrigin = (request: Request, env: Env): string | null => {
  const configured = env.ALLOWED_ORIGINS
  const origin = request.headers.get('Origin')
  if (!configured || configured.trim() === '') return origin ?? '*'
  if (!origin) return null
  const allowed = configured.split(',').map((value) => value.trim())
  return allowed.includes(origin) ? origin : null
}

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin === null
    ? {}
    : {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }

const json = (
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin), ...extra },
  })

/**
 * Who is asking, for the purpose of rationing room codes.
 *
 * `CF-Connecting-IP` is set by the edge and cannot be forged by the client;
 * `X-Forwarded-For` is only consulted because `wrangler dev` does not always
 * set the first, and a local run with no rationing at all would mean the limit
 * is never exercised until it matters. An address that cannot be determined
 * returns the empty string, and the registry rations those together.
 */
const callerAddress = (request: Request): string =>
  request.headers.get('CF-Connecting-IP') ??
  request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
  ''

/**
 * The room code inside a party URL, canonicalised.
 *
 * Rooms are addressed by `idFromName(code)`, so "abc12" and "ABC12" would be
 * two different rooms sharing one spoken code. `parseRoomCode` folds the
 * confusable characters and upper-cases, and anything it rejects never reaches
 * a Durable Object at all.
 */
const roomCodeFromPath = (pathname: string): string | null => {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length < 3 || parts[0] !== 'parties' || parts[1] !== 'room') return null
  return parts[2] ?? null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = allowedOrigin(request, env)
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: origin === null ? 403 : 204,
        headers: corsHeaders(origin),
      })
    }
    if (origin === null) return json({ error: 'forbidden-origin' }, 403, null)

    if (url.pathname === '/health') {
      return json({ ok: true, protocol: PROTOCOL_VERSION, serverTime: Date.now() }, 200, origin)
    }

    if (url.pathname === '/rooms' && request.method === 'POST') {
      const registry = await getServerByName(env.Registry, REGISTRY_NAME)
      const result = await registry.allocate(callerAddress(request))
      if (!result.ok) {
        const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
        // Every failure here is momentary, so every one of them says how long a
        // moment is. The status separates the two kinds: 429 is this caller
        // asking for too many codes, 503 is the deployment having none to give.
        // Anyone reading the logs wants very different things from those two.
        const status = result.reason === 'rate-limited' ? 429 : 503
        return json({ error: result.reason, retryAfterMs: result.retryAfterMs }, status, origin, {
          'Retry-After': String(seconds),
        })
      }
      return json({ code: result.code }, 201, origin)
    }

    if (url.pathname.startsWith('/rooms/') && request.method === 'GET') {
      const code = parseRoomCode(url.pathname.slice('/rooms/'.length))
      if (!code) return json({ exists: false }, 200, origin)
      const registry = await getServerByName(env.Registry, REGISTRY_NAME)
      return json({ exists: await registry.lookup(code), code }, 200, origin)
    }

    const raw = roomCodeFromPath(url.pathname)
    if (raw !== null) {
      const code = parseRoomCode(raw)
      if (!code) return json({ error: 'bad-room-code' }, 404, origin)
      if (code !== raw) {
        // Rewrite rather than redirect: a WebSocket upgrade cannot follow a 301,
        // and the room's identity is derived from this path segment.
        url.pathname = url.pathname.replace(`/parties/room/${raw}`, `/parties/room/${code}`)
      }
      // PartyServer takes a connection's id from the `_pk` query parameter,
      // which means the CLIENT names its own connection. Its connection map is
      // keyed by that id, so a socket opened with somebody else's id silently
      // replaces theirs and takes over everything the room addresses by
      // connection. The id is therefore minted here, at the door, and whatever
      // the client asked for is thrown away: a connection id is now a thing the
      // server hands out, unguessable and unique per socket. What a player owns
      // is their seat token, which travels in the join frame and nowhere else.
      url.searchParams.set('_pk', crypto.randomUUID())
      request = new Request(url, request)
      const routed = await routePartykitRequest(request, env, {
        onBeforeConnect: async (_req, lobby) => {
          // A code nobody is using must not conjure an empty room: the guest
          // who mistyped would sit alone in a room the host cannot find.
          const registry = await getServerByName(env.Registry, REGISTRY_NAME)
          if (await registry.lookup(lobby.name)) return
          return new Response('no such room', { status: 404 })
        },
      })
      if (routed) return routed
    }

    return json({ error: 'not-found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
