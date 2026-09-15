import { afterEach, describe, expect, it } from 'vitest'
import { LEVEL_TIME_LIMIT_MS, RECONNECT_GRACE_MS } from '../../src/multiplayer/match'
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
 * The cases a match has to survive.
 *
 * Every one of these is something that will happen on a phone within the first
 * week: somebody puts the app in the background mid-level, somebody walks off
 * and never finishes, the person who created the room leaves it, a knockout
 * loses half its field before the field has been thinned. None of them may
 * leave a room stuck, and none of them may hand a win to somebody who was not
 * there for it.
 */

const GAP_MS = 250

/** Finishes a set of players in order, one accepted claim at a time. */
const finishInOrder = async (
  order: readonly TestClient[],
  levelIndex: number,
  schedule: readonly LevelSpec[],
): Promise<void> => {
  for (const client of order) {
    client.solve(levelIndex, schedule)
    await client.waitFor('accepted', (message) => message.levelIndex === levelIndex)
    await sleep(GAP_MS)
  }
}

const readyUp = async (clients: readonly TestClient[]): Promise<void> => {
  for (const client of clients) {
    await client.waitForPhase('interlude')
    client.send({ t: 'ready' })
  }
}

describe.skipIf(!partyReachable)('a dropped connection', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('keeps the seat, the clock and the level when a player comes back', async () => {
    const { code, clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const adaId = ada.playerId
    const schedule = await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })

    const started = await bo.waitFor('level', (message) => message.levelIndex === 0)
    await ada.waitFor('level', (message) => message.levelIndex === 0)
    ada.send({ t: 'progress', cats: 2 })
    await sleep(GAP_MS)

    // The tunnel. Nothing polite about it: the socket simply goes.
    ada.close()
    const dropped = await bo.waitUntilState((state) =>
      state.players.some((player) => player.id === adaId && !player.connected),
    )
    // Still seated, still in the match, still on the same level.
    expect(dropped.players).toHaveLength(2)
    expect(dropped.phase).toBe('playing')
    expect(RECONNECT_GRACE_MS).toBeGreaterThan(5_000)

    // The seat token is what brings her back. A reconnect that presented
    // anything else — the id she was broadcast under, the session id on her
    // socket URL — would be a stranger arriving mid-match, and refused as one.
    const back = await connect(code, { token: ada.token ?? '', name: 'Ada' })
    expect(back.playerId).toBe(adaId)

    const welcome = await back.waitFor('welcome')
    expect(welcome.state.phase).toBe('playing')
    expect(welcome.state.players).toHaveLength(2)
    // The returning player is told the schedule and the clock of the level they
    // are in the middle of, so their board and timer resume rather than restart.
    const resumed = await back.waitFor('level', (message) => message.levelIndex === 0)
    expect(resumed.startsAt).toBe(started.startsAt)
    expect(resumed.deadlineAt).toBe(started.deadlineAt)
    expect((await back.waitFor('match')).schedule).toEqual(schedule)

    // And the blip cost them nothing: they still win the level.
    await finishInOrder([back, bo], 0, schedule)
    const result = (await bo.waitFor('result', (message) => message.result.levelIndex === 0)).result
    expect(result.winnerId).toBe(adaId)
    expect(result.finishes.every((finish) => finish.status === 'solved')).toBe(true)
  })
})

describe.skipIf(!partyReachable)('the host leaving', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('passes the room to the earliest remaining player, who can then start', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    expect(ada.state?.hostId).toBe(ada.playerId)

    ada.send({ t: 'leave' })
    const closed = await ada.waitForClose()
    expect(closed.reason).toBe('left')

    const passed = await bo.waitUntilState((state) => state.players.length === 2)
    // Succession is by join order, so both remaining clients name the same host
    // without being told which one it should be.
    expect(passed.hostId).toBe(bo.playerId)
    const seenByCy = await cy.waitUntilState((state) => state.players.length === 2)
    expect(seenByCy.hostId).toBe(bo.playerId)

    // The role is real, not cosmetic: the server takes a start from the new host.
    const schedule = await startMatch(bo, { mode: 'blaze', levelCount: 3, difficulty: 'easy' })
    expect(schedule).toHaveLength(3)
    expect((await cy.waitForPhase('countdown')).hostId).toBe(bo.playerId)
  })
})

describe.skipIf(!partyReachable)('a knockout that loses players early', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('ends at the survivor rather than at the end of the schedule', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy', 'Dee'])
    const [ada, bo, cy, dee] = clients as [TestClient, TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'knockout', difficulty: 'easy' })
    // Four players were in the room when the host pressed start, so three
    // levels were scheduled.
    expect(schedule).toHaveLength(3)

    for (const client of [ada, bo, cy, dee]) {
      await client.waitFor('level', (message) => message.levelIndex === 0)
    }
    // Dee walks out mid-level. That forfeits the level and frees a place.
    dee.send({ t: 'leave' })
    await dee.waitForClose()

    await finishInOrder([ada, bo, cy], 0, schedule)
    const first = (await ada.waitFor('result', (message) => message.result.levelIndex === 0)).result
    expect(first.ranking).toEqual([ada.playerId, bo.playerId, cy.playerId])
    expect(first.eliminatedId).toBe(cy.playerId)

    await readyUp([ada, bo])
    await finishInOrder([ada, bo], 1, schedule)
    const final = (await ada.waitFor('result', (message) => message.result.levelIndex === 1)).result
    expect(final.eliminatedId).toBe(bo.playerId)

    const podium = (await ada.waitFor('finished')).podium
    // Two levels, not three: a knockout is over when one player is left.
    expect(ada.state?.results).toHaveLength(2)
    expect(ada.state?.levelCount).toBe(3)
    expect(podium.map((entry) => entry.playerId)).toEqual([
      ada.playerId,
      bo.playerId,
      cy.playerId,
      dee.playerId,
    ])
    expect(podium.map((entry) => entry.status)).toEqual([
      'champion',
      'knocked-out',
      'knocked-out',
      'left',
    ])
    // Walking out ranks below being beaten, even though both went out at the
    // same level.
    expect(podium[2]?.eliminatedAtLevel).toBe(1)
    expect(podium[3]?.eliminatedAtLevel).toBe(1)
  })
})

/**
 * The player who never finishes.
 *
 * This one costs a level's whole time limit in wall clock, because that limit
 * is the thing under test: without it one stuck player holds the room open
 * indefinitely. Ninety seconds is the easy band's cap and is deliberately not
 * configurable over the wire, so there is no faster honest way to reach it.
 * `SKIP_SLOW=1` leaves it out when a quick run is what is wanted.
 */
describe.skipIf(!partyReachable || process.env['SKIP_SLOW'] === '1')(
  'a player who never finishes',
  () => {
    afterEach(() => {
      closeAllClients()
    })

    it(
      'times the level out, records how far they got, and carries on',
      async () => {
        const { clients } = await openRoom(['Ada', 'Bo'])
        const [ada, bo] = clients as [TestClient, TestClient]
        const schedule = await startMatch(ada, {
          mode: 'steady',
          levelCount: 3,
          difficulty: 'easy',
        })

        const level = await ada.waitFor('level', (message) => message.levelIndex === 0)
        expect(level.deadlineAt - level.startsAt).toBe(LEVEL_TIME_LIMIT_MS.easy)
        await bo.waitFor('level', (message) => message.levelIndex === 0)

        ada.solve(0, schedule)
        await ada.waitFor('accepted', (message) => message.levelIndex === 0)
        // Bo places two cats and then stops, which is what being stuck looks like
        // from the server's side.
        bo.send({ t: 'progress', cats: 2 })

        const result = (
          await ada.waitFor('result', (message) => message.result.levelIndex === 0, {
            timeoutMs: LEVEL_TIME_LIMIT_MS.easy + 20_000,
          })
        ).result
        expect(result.winnerId).toBe(ada.playerId)
        expect(result.ranking).toEqual([ada.playerId, bo.playerId])

        const stuck = result.finishes.find((finish) => finish.playerId === bo.playerId)
        expect(stuck?.status).toBe('timeout')
        expect(stuck?.elapsedMs).toBeNull()
        // The bar was telling the truth all along, and the number it was showing
        // is the one that ranks a level nobody solved.
        expect(stuck?.progress).toBe(2)

        // The room is not stuck: the timed-out player is still in the match and
        // the next level runs normally.
        await readyUp([ada, bo])
        await finishInOrder([bo, ada], 1, schedule)
        const second = (await ada.waitFor('result', (message) => message.result.levelIndex === 1))
          .result
        expect(second.winnerId).toBe(bo.playerId)
      },
      LEVEL_TIME_LIMIT_MS.easy + 60_000,
    )
  },
)
