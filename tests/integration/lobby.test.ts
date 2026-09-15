import { afterEach, describe, expect, it } from 'vitest'
import { MAX_PLAYERS, PROTOCOL_VERSION } from '../../src/multiplayer/protocol'
import { isRoomCode, normaliseRoomCode } from '../../src/multiplayer/roomCode'
import { ROOM_CREATE_BURST } from '../../party/lib/rateLimit'
import {
  HTTP_BASE,
  TestClient,
  allocateRoom,
  closeAllClients,
  connect,
  openRoom,
  partyReachable,
  roomExists,
  tryAllocateRoom,
} from './harness'

/**
 * Getting into a room.
 *
 * Everything before a match: allocating a code, finding a room by it, seeing
 * the other players arrive, and the two refusals that are decided at the door —
 * a room that is full, and a client speaking a protocol the server does not.
 */
describe.skipIf(!partyReachable)('lobby', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('allocates a code that is live, canonical and findable', async () => {
    const code = await allocateRoom()
    expect(isRoomCode(code)).toBe(true)
    expect(await roomExists(code)).toBe(true)
    // Folding is the point of the alphabet: a guest who types the code they
    // heard, in whatever case, reaches the same room.
    expect(await roomExists(code.toLowerCase())).toBe(true)
  })

  it('does not invent a room for a code nobody is using', async () => {
    expect(await roomExists('22222')).toBe(false)
    // A socket to an unallocated code is refused at the handshake rather than
    // conjuring an empty room the host could never be found in.
    const ghost = new TestClient('22222', 'ghost')
    await ghost.waitForClose()
    expect(ghost.received).toHaveLength(0)
    expect(ghost.playerId).toBeNull()
  })

  it('lets two players meet in the same room and see each other', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]

    const seenByAda = await ada.waitForState((state) => state.players.length === 2)
    const seenByBo = await bo.waitForState((state) => state.players.length === 2)

    expect(seenByAda.players.map((player) => player.name).sort()).toEqual(['Ada', 'Bo'])
    expect(seenByBo.players.map((player) => player.name).sort()).toEqual(['Ada', 'Bo'])
    // The first to arrive hosts, and both ends agree on who that is.
    expect(seenByAda.hostId).toBe(ada.playerId)
    expect(seenByBo.hostId).toBe(ada.playerId)
    expect(ada.playerId).not.toBe(bo.playerId)
  })

  it('makes duplicate names unambiguous inside the room', async () => {
    const { clients } = await openRoom(['Milo', 'milo'])
    const [first] = clients as [TestClient]
    const state = await first.waitForState((room) => room.players.length === 2)
    const names = state.players.map((player) => player.name)
    expect(new Set(names).size).toBe(2)
    expect(names).toContain('Milo')
  })

  it('joins a room through a mistyped, confusable code', async () => {
    const code = await allocateRoom()
    const host = await connect(code, { name: 'Ada' })
    // O for zero, I for one, lower case throughout: every one of these folds.
    const spoken = code.toLowerCase().replaceAll('0', 'o').replaceAll('1', 'l')
    expect(normaliseRoomCode(spoken)).toBe(code)
    const guest = await connect(spoken, { name: 'Bo' })
    const state = await host.waitForState((room) => room.players.length === 2)
    expect(state.code).toBe(code)
    expect(state.players.map((player) => player.name).sort()).toEqual(['Ada', 'Bo'])
    expect(guest.closed).toBeNull()
  })

  it('fills to eight players and refuses the ninth', async () => {
    const code = await allocateRoom()
    const seated: TestClient[] = []
    for (let i = 0; i < MAX_PLAYERS; i++) {
      seated.push(await connect(code, { name: `P${i + 1}` }))
    }
    const host = seated[0] as TestClient
    const full = await host.waitForState((state) => state.players.length === MAX_PLAYERS)
    expect(full.players).toHaveLength(8)

    const ninth = await connect(code, { name: 'Late', admit: false })
    const error = await ninth.waitFor('error')
    expect(error.code).toBe('room-full')
    // Refused for good, not merely told off: the close is in the application
    // range so the real client stops retrying.
    const closed = await ninth.waitForClose()
    expect(closed.code).toBe(4001)
    expect(closed.reason).toBe('room-full')

    // The room is unchanged by the attempt.
    expect((host.state?.players ?? []).length).toBe(8)
  })

  it('refuses a client speaking the wrong protocol version', async () => {
    const code = await allocateRoom()
    const client = new TestClient(code, 'wrong-version')
    await client.ready()
    client.send({ t: 'join', v: PROTOCOL_VERSION + 1, name: 'Stale' })
    const error = await client.waitFor('error')
    expect(error.code).toBe('version-mismatch')
    expect((await client.waitForClose()).code).toBe(4001)
  })

  it('refuses a newcomer once the match has started', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada] = clients as [TestClient]
    ada.send({ t: 'settings', settings: { mode: 'steady', levelCount: 3, difficulty: 'easy' } })
    ada.send({ t: 'start' })
    await ada.waitFor('countdown')

    const late = await connect(code, { name: 'Late', admit: false })
    const error = await late.waitFor('error')
    expect(error.code).toBe('match-in-progress')
    expect((await late.waitForClose()).reason).toBe('match-in-progress')
  })

  it('only lets the host change the mode or start', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [, bo] = clients as [TestClient, TestClient]
    bo.send({ t: 'settings', settings: { mode: 'blaze', levelCount: 3, difficulty: 'easy' } })
    const refusedSettings = await bo.waitFor('error')
    expect(refusedSettings.code).toBe('not-host')

    const from = bo.mark()
    bo.send({ t: 'start' })
    const refusedStart = await bo.waitFor('error', () => true, { from })
    expect(refusedStart.code).toBe('not-host')
    // A refusal that is not fatal leaves the socket alive.
    expect(bo.closed).toBeNull()
  })

  it('refuses to start a knockout without enough players', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada] = clients as [TestClient]
    const from = ada.mark()
    ada.send({ t: 'settings', settings: { mode: 'knockout', difficulty: 'easy' } })
    await ada.waitForState((state) => state.settings.mode === 'knockout', { from })
    ada.send({ t: 'start' })
    const error = await ada.waitFor('error', () => true, { from })
    expect(error.code).toBe('not-enough-players')
    expect(ada.state?.phase).toBe('lobby')
  })
})

/**
 * Room codes have to be unique among live rooms, and the only way to know that
 * is to ask for several at once. Sequential allocation would prove nothing: the
 * interesting case is two hosts pressing Create in the same millisecond, which
 * is exactly what a burst of concurrent POSTs produces.
 *
 * The burst is a dozen rather than the sixty-four it once was, because the
 * lobby now rations room creation per caller and this whole suite is one
 * caller. That ceiling is the point of the second test.
 */
describe.skipIf(!partyReachable)('room codes', () => {
  it('hands out unique codes under concurrent creation', async () => {
    const batch = 12
    const results = await Promise.all(Array.from({ length: batch }, () => allocateRoom()))
    expect(results).toHaveLength(batch)
    for (const code of results) expect(isRoomCode(code)).toBe(true)
    expect(new Set(results).size).toBe(batch)
    // Every one of them is live, which is what "unique among ongoing sessions"
    // actually means: the registry is holding all twelve at once.
    const live = await Promise.all(results.map((code) => roomExists(code)))
    expect(live.every(Boolean)).toBe(true)
  })

  /**
   * Creating a room is unauthenticated, and every code comes out of one table
   * with a hard ceiling on it. Unrationed, a few seconds of requests from a
   * single client reserved every code the deployment had, and because only a
   * room object ever released one, every host in the world was refused until
   * the reservations timed out half an hour later.
   */
  it('refuses a flood instead of letting one caller take the code space', async () => {
    const attempts = await Promise.all(
      Array.from({ length: ROOM_CREATE_BURST * 3 }, () => tryAllocateRoom()),
    )
    const allocated = attempts.filter((attempt) => attempt.code !== null)
    const refused = attempts.filter((attempt) => attempt.status === 429)

    expect(refused.length).toBeGreaterThan(0)
    expect(allocated.length).toBeLessThanOrEqual(ROOM_CREATE_BURST)
    // Nothing is broken by the refusal: the codes that were handed out are real
    // and live, and the ones that were not are simply not there.
    for (const attempt of allocated) expect(isRoomCode(attempt.code as string)).toBe(true)
    expect(new Set(allocated.map((attempt) => attempt.code)).size).toBe(allocated.length)
  })

  it('tells a rationed caller how long to wait rather than just saying no', async () => {
    // Drains whatever budget is left, so the refusal below is the limiter's and
    // not a coincidence.
    await Promise.all(Array.from({ length: ROOM_CREATE_BURST * 2 }, () => tryAllocateRoom()))
    const response = await fetch(`${HTTP_BASE}/rooms`, { method: 'POST' })
    expect(response.status).toBe(429)
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0)
    const body = (await response.json()) as { error?: unknown; retryAfterMs?: unknown }
    expect(body.error).toBe('rate-limited')
    expect(typeof body.retryAfterMs).toBe('number')
  })
})
