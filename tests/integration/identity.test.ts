import { afterEach, describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../src/multiplayer/protocol'
import {
  TestClient,
  allocateRoom,
  closeAllClients,
  connect,
  openRoom,
  partyReachable,
  sleep,
  startMatch,
} from './harness'

/**
 * Who the server thinks you are.
 *
 * A room broadcasts every player's id to every player — it is on the progress
 * bars, in every result, all over the podium. So the id cannot also be what
 * gets a connection into a seat, and nothing else a client can see or choose
 * may be either. What proves a seat is a token the server minted, sent to its
 * owner alone, and never put in a broadcast.
 *
 * These tests attack the room the way the room can actually be attacked: read
 * an opponent's id out of a state frame, then try to become them. Every route
 * in has to end with the attacker holding a seat of their own or holding
 * nothing, and never with the victim losing anything.
 */

const GAP_MS = 250

/** The id of another player in the room, read out of a broadcast, as anyone can. */
const opponentIdSeenBy = (client: TestClient, name: string): string => {
  const player = client.state?.players.find((entry) => entry.name === name)
  if (!player) throw new Error(`no player called ${name} in the room state`)
  return player.id
}

describe.skipIf(!partyReachable)('a player id', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('does not resume the seat it belongs to, however it is presented', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const adaId = opponentIdSeenBy(bo, 'Ada')
    expect(adaId).toBe(ada.playerId)

    // Everything an attacker can learn about Ada, used every way it can be
    // used: as the connection id on the socket URL, and as the token in the
    // join frame. PartyServer would take the first as the connection's identity
    // if the Worker in front of it had not already replaced it.
    const attacker = new TestClient(code, adaId)
    await attacker.ready()
    attacker.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Mallory', token: adaId })
    const welcome = await attacker.waitFor('welcome')

    expect(welcome.you).not.toBe(adaId)
    expect(welcome.token).not.toBe(adaId)
    // A third seat, not Ada's: the room grew rather than changing hands.
    const seen = await ada.waitUntilState((state) => state.players.length === 3)
    expect(seen.players.filter((player) => player.id === adaId)).toHaveLength(1)
    expect(seen.players.find((player) => player.id === adaId)?.name).toBe('Ada')
  })

  it('leaves the victim connected and still hearing the room', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const adaId = ada.playerId as string

    const attacker = new TestClient(code, adaId)
    await attacker.ready()
    attacker.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Mallory', token: adaId })
    await attacker.waitFor('welcome')

    // PartyServer keys its connection map by the id on the socket URL, so a
    // duplicate id used to evict the victim from it: their socket stayed open
    // and stopped receiving anything the room broadcast.
    const from = ada.mark()
    bo.send({ t: 'name', name: 'Bonnie' })
    await ada.waitForState((state) => state.players.some((p) => p.name === 'Bonnie'), { from })
    expect(ada.closed).toBeNull()
  })

  it('is not what a socket is addressed by, so no id can displace a connection', async () => {
    // Defence in depth for the layer underneath the token. PartyServer keys its
    // connection map by the `_pk` on the socket URL, so two sockets asking for
    // one id used to mean the second quietly replacing the first — the victim
    // left holding an open socket the room could no longer broadcast to. The
    // Worker mints that id now, so asking is not a way to get one.
    const code = await allocateRoom()
    const victim = await connect(code, { sessionId: 'the-same-pk', name: 'Ada' })
    const twin = await connect(code, { sessionId: 'the-same-pk', name: 'Bo' })
    expect(twin.playerId).not.toBe(victim.playerId)

    const from = victim.mark()
    twin.send({ t: 'name', name: 'Bonnie' })
    await victim.waitForState((state) => state.players.some((p) => p.name === 'Bonnie'), { from })
    expect(victim.closed).toBeNull()
  })

  it('cannot be used to walk into a match that has already started', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada] = clients as [TestClient]
    const adaId = ada.playerId as string
    await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    await ada.waitFor('level', (message) => message.levelIndex === 0)

    // The resume path used to be tried before the door was checked, so a forged
    // id got into a running match — where it could forfeit the victim's level,
    // and if the victim hosted, change the settings and start the next match.
    const attacker = new TestClient(code, adaId)
    await attacker.ready()
    attacker.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Mallory', token: adaId })

    const error = await attacker.waitFor('error')
    expect(error.code).toBe('match-in-progress')
    expect((await attacker.waitForClose()).reason).toBe('match-in-progress')

    const during = ada.state
    expect(during?.players).toHaveLength(2)
    expect(during?.phase).not.toBe('lobby')
    expect(ada.closed).toBeNull()
  })

  it('cannot forfeit somebody else’s level', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'knockout', difficulty: 'easy' })
    for (const client of [ada, bo, cy]) {
      await client.waitFor('level', (message) => message.levelIndex === 0)
    }

    // A knockout is the sharpest version of the attack: leaving forfeits the
    // level, and in knockout a forfeit decides who goes out.
    const attacker = new TestClient(code, cy.playerId as string)
    await attacker.ready()
    attacker.send({ t: 'join', v: PROTOCOL_VERSION, name: 'Mallory', token: cy.playerId as string })
    await attacker.waitForClose()

    for (const client of [ada, bo, cy]) {
      client.solve(0, schedule)
      await client.waitFor('accepted', (message) => message.levelIndex === 0)
      await sleep(GAP_MS)
    }
    const result = (await ada.waitFor('result', (message) => message.result.levelIndex === 0))
      .result
    // Cy played and placed third; nobody forfeited on their behalf.
    expect(result.ranking).toEqual([ada.playerId, bo.playerId, cy.playerId])
    expect(result.eliminatedId).toBe(cy.playerId)
    expect(result.finishes.every((finish) => finish.status === 'solved')).toBe(true)
  })
})

describe.skipIf(!partyReachable)('a seat token', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('is issued to its owner and to nobody else', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const adaToken = ada.token as string
    expect(adaToken.length).toBeGreaterThan(20)
    expect(adaToken).not.toBe(bo.token)
    expect(adaToken).not.toBe(ada.playerId)

    // Every frame either client has been sent, searched for the other's secret.
    // A token that appears in a broadcast is not a secret at all.
    const everything = JSON.stringify(bo.received)
    expect(everything).not.toContain(adaToken)
    expect(everything).toContain(ada.playerId as string)
  })

  it('brings its owner back to the same seat, score and level', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const adaId = ada.playerId as string
    const adaToken = ada.token as string
    const schedule = await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })

    await ada.waitFor('level', (message) => message.levelIndex === 0)
    await bo.waitFor('level', (message) => message.levelIndex === 0)
    ada.solve(0, schedule)
    await ada.waitFor('accepted', (message) => message.levelIndex === 0)
    bo.solve(0, schedule)
    await bo.waitFor('result', (message) => message.result.levelIndex === 0)

    ada.close()
    await bo.waitUntilState((state) =>
      state.players.some((player) => player.id === adaId && !player.connected),
    )

    const back = await connect(code, { token: adaToken, name: 'Ada' })
    expect(back.playerId).toBe(adaId)
    const welcome = await back.waitFor('welcome')
    const me = welcome.state.players.find((player) => player.id === adaId)
    expect(me?.connected).toBe(true)
    // The point of a seat: the level she won is still hers.
    expect(me?.points).toBe(1)
    expect(me?.levelsSolved).toBe(1)
    expect(welcome.state.players).toHaveLength(2)
  })

  it('stops working once its owner has left for good', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada] = clients as [TestClient]
    const adaToken = ada.token as string
    const adaId = ada.playerId

    ada.send({ t: 'leave' })
    await ada.waitForClose()

    const again = await connect(code, { token: adaToken, name: 'Ada' })
    // A new seat, because the old one no longer exists. Presenting a stale
    // token must not resurrect a place in the room or a score attached to it.
    expect(again.playerId).not.toBe(adaId)
    expect(again.token).not.toBe(adaToken)
  })

  it('replaces the connection holding the seat instead of stranding its owner', async () => {
    // The phone that reloads, or the socket that is open but has quietly
    // stopped delivering: the room still believes in a connection its owner
    // cannot use. The owner holds the token, so the new socket takes the seat
    // over and the old one is hung up on.
    const code = await allocateRoom()
    const first = await connect(code, { name: 'Ada' })
    const adaId = first.playerId
    const token = first.token as string

    const second = await connect(code, { token, name: 'Ada' })
    expect(second.playerId).toBe(adaId)

    const closed = await first.waitForClose()
    expect(closed.code).toBe(4001)
    // The reason is a code the client understands, so the old tab can say what
    // happened instead of reporting a server problem that did not occur.
    expect(closed.reason).toBe('superseded')
    const state = await second.waitUntilState((room) => room.players.length === 1)
    expect(state.players[0]?.id).toBe(adaId)
    expect(state.players[0]?.connected).toBe(true)
  })
})
