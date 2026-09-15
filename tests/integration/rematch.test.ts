import { afterEach, describe, expect, it } from 'vitest'
import type { LevelSpec } from '../../src/multiplayer/protocol'
import {
  type TestClient,
  closeAllClients,
  connect,
  openRoom,
  partyReachable,
  sleep,
  startMatch,
} from './harness'

/**
 * What happens after the podium.
 *
 * A room outlives its matches. It has a code people have read aloud and are
 * sitting in, and the overwhelmingly likely thing they want next is another
 * game with the same people. For that to be possible the room has to be able to
 * come back to its lobby, and everything the last match decided — scores,
 * eliminations, the schedule, who was knocked out — has to be gone when it
 * does, or the next match starts with people already out of it.
 *
 * The room used to have no route back at all: the phase reached `finished` on
 * the first match and stayed there for as long as the room existed.
 */

const GAP_MS = 250

/** Plays a whole blaze schedule out, which is the quickest honest way to a podium. */
const playBlaze = async (
  clients: readonly TestClient[],
  schedule: readonly LevelSpec[],
): Promise<void> => {
  for (const client of clients) {
    await client.waitFor('level', (message) => message.levelIndex === 0)
  }
  for (const client of clients) {
    for (let index = 0; index < schedule.length; index++) {
      client.solve(index, schedule)
      await client.waitFor('accepted', (message) => message.levelIndex === index)
      await sleep(40)
    }
  }
  await (clients[0] as TestClient).waitFor('finished')
}

describe.skipIf(!partyReachable)('a finished room', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('goes back to its lobby with nothing of the last match left on it', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'blaze', levelCount: 3, difficulty: 'easy' })
    await playBlaze([ada, bo], schedule)
    expect((await ada.waitForPhase('finished')).podium).not.toBeNull()

    bo.send({ t: 'rematch' })

    // Everybody moves together: the room has one phase and it is the server's.
    const lobby = await ada.waitForPhase('lobby')
    await bo.waitForPhase('lobby')
    expect(lobby.podium).toBeNull()
    expect(lobby.schedule).toBeNull()
    expect(lobby.results).toEqual([])
    expect(lobby.levelIndex).toBe(-1)
    expect(lobby.players).toHaveLength(2)
    for (const player of lobby.players) {
      expect(player.points).toBe(0)
      expect(player.levelsSolved).toBe(0)
      expect(player.totalTimeMs).toBe(0)
      expect(player.eliminatedAtLevel).toBeNull()
      expect(player.progress).toBe(0)
    }
    // The settings the host chose survive, because a rematch is nearly always
    // the same game again and the lobby is where changing it belongs.
    expect(lobby.settings.mode).toBe('blaze')
  })

  it('can then start another match, with different puzzles', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const first = await startMatch(ada, { mode: 'blaze', levelCount: 3, difficulty: 'easy' })
    await playBlaze([ada, bo], first)

    ada.send({ t: 'rematch' })
    await ada.waitForPhase('lobby')

    const from = ada.mark()
    ada.send({ t: 'start' })
    const second = (await ada.waitFor('match', () => true, { from })).schedule
    expect(second).toHaveLength(3)
    // Seeded with the start time as well as the room code, so the second match
    // is not a replay of the first.
    expect(second.map((spec) => spec.levelNumber)).not.toEqual(
      first.map((spec) => spec.levelNumber),
    )
    await bo.waitForPhase('countdown')
  })

  it('brings a knocked-out player back into the next knockout', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'knockout', difficulty: 'easy' })
    expect(schedule).toHaveLength(2)

    for (const client of [ada, bo, cy]) {
      await client.waitFor('level', (message) => message.levelIndex === 0)
    }
    for (const client of [ada, bo, cy]) {
      client.solve(0, schedule)
      await client.waitFor('accepted', (message) => message.levelIndex === 0)
      await sleep(GAP_MS)
    }
    const first = (await ada.waitFor('result', (message) => message.result.levelIndex === 0)).result
    expect(first.eliminatedId).toBe(cy.playerId)

    for (const client of [ada, bo]) {
      await client.waitForPhase('interlude')
      client.send({ t: 'ready' })
    }
    for (const client of [ada, bo]) {
      client.solve(1, schedule)
      await client.waitFor('accepted', (message) => message.levelIndex === 1)
      await sleep(GAP_MS)
    }
    await ada.waitFor('finished')

    cy.send({ t: 'rematch' })
    const lobby = await cy.waitForPhase('lobby')
    // The whole roster is back, nobody is carrying an elimination, and the
    // knockout is three players long again rather than two.
    expect(lobby.players).toHaveLength(3)
    expect(lobby.players.every((player) => player.eliminatedAtLevel === null)).toBe(true)
    expect(lobby.levelCount).toBe(2)

    const from = ada.mark()
    ada.send({ t: 'start' })
    const again = (await ada.waitFor('match', () => true, { from })).schedule
    expect(again).toHaveLength(2)
    await cy.waitFor('level', (message) => message.levelIndex === 0)
  })

  it('leaves the room to somebody who is still in it when the host has gone', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'blaze', levelCount: 3, difficulty: 'easy' })
    await playBlaze([ada, bo, cy], schedule)

    ada.send({ t: 'leave' })
    await ada.waitForClose()
    bo.send({ t: 'rematch' })

    const lobby = await bo.waitForPhase('lobby')
    // The host left from the podium, so the lobby is two players and the
    // earliest of them is hosting it.
    expect(lobby.players).toHaveLength(2)
    expect(lobby.hostId).toBe(bo.playerId)
    expect(lobby.players.map((player) => player.name).sort()).toEqual(['Bo', 'Cy'])

    const from = bo.mark()
    bo.send({ t: 'start' })
    expect((await bo.waitFor('match', () => true, { from })).schedule).toHaveLength(3)
    await cy.waitForPhase('countdown')
  })

  it('takes a newcomer again once it is back in its lobby', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'blaze', levelCount: 3, difficulty: 'easy' })
    await playBlaze([ada, bo], schedule)

    ada.send({ t: 'rematch' })
    await ada.waitForPhase('lobby')

    const late = await connect(code, { name: 'Cy' })
    const lobby = await ada.waitUntilState((state) => state.players.length === 3)
    expect(lobby.players.map((player) => player.name).sort()).toEqual(['Ada', 'Bo', 'Cy'])
    expect(late.closed).toBeNull()
  })

  it('refuses to unwind a match that is still being played', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    await bo.waitFor('level', (message) => message.levelIndex === 0)

    const from = bo.mark()
    bo.send({ t: 'rematch' })
    const error = await bo.waitFor('error', () => true, { from })
    expect(error.code).toBe('match-in-progress')
    expect(bo.closed).toBeNull()
    expect(ada.state?.phase).toBe('playing')
  })
})
