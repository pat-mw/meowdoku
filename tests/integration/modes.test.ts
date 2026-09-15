import { afterEach, describe, expect, it } from 'vitest'
import type { LevelResult, LevelSpec, PodiumEntry } from '../../src/multiplayer/protocol'
import {
  type TestClient,
  closeAllClients,
  openRoom,
  partyReachable,
  sleep,
  startMatch,
} from './harness'

/**
 * A whole match, in each mode, with the podium the rules should produce.
 *
 * The scripts below decide the outcome the only way a real room can: by having
 * one client send its solution before another, with a real gap in between. No
 * test claims a time. The gaps are a quarter of a second — comfortably longer
 * than a loopback round trip and comfortably shorter than anything a person
 * would notice — so the order the server records is the order the script wrote.
 */

/** How far apart scripted finishes are placed. */
const GAP_MS = 250

/** The place a player took, by player id. */
const placeOf = (podium: readonly PodiumEntry[], playerId: string | null): number =>
  podium.find((entry) => entry.playerId === playerId)?.place ?? -1

const entryOf = (podium: readonly PodiumEntry[], playerId: string | null): PodiumEntry => {
  const entry = podium.find((row) => row.playerId === playerId)
  if (!entry) throw new Error('no podium entry for that player')
  return entry
}

/**
 * Plays one synchronised level, finishing the players in the order given.
 *
 * Each client's claim is sent only after the previous one has been accepted, so
 * the finish order is a fact about the server's sequence rather than a hope
 * about scheduling.
 */
const playLevel = async (
  order: readonly TestClient[],
  levelIndex: number,
  schedule: readonly LevelSpec[],
): Promise<LevelResult> => {
  for (const client of order) {
    await client.waitFor('level', (message) => message.levelIndex === levelIndex)
  }
  for (const client of order) {
    client.solve(levelIndex, schedule)
    await client.waitFor('accepted', (message) => message.levelIndex === levelIndex)
    await sleep(GAP_MS)
  }
  const anchor = order[0] as TestClient
  return (await anchor.waitFor('result', (message) => message.result.levelIndex === levelIndex))
    .result
}

/** Skips the rest of an interlude, once the room is actually in one. */
const readyUp = async (clients: readonly TestClient[]): Promise<void> => {
  for (const client of clients) {
    await client.waitForPhase('interlude')
    client.send({ t: 'ready' })
  }
}

describe.skipIf(!partyReachable)('blaze', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('ranks by total time across the schedule, with no pause between levels', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, {
      mode: 'blaze',
      levelCount: 3,
      difficulty: 'easy',
    })
    expect(schedule).toHaveLength(3)
    // Every level in the match is a different puzzle.
    expect(new Set(schedule.map((spec) => spec.levelNumber)).size).toBe(3)

    await ada.waitFor('level', (message) => message.levelIndex === 0)
    await bo.waitFor('level', (message) => message.levelIndex === 0)

    /** One player's run through the whole schedule, at their own pace. */
    const run = async (client: TestClient, pauseMs: number): Promise<void> => {
      for (let index = 0; index < schedule.length; index++) {
        await sleep(pauseMs)
        client.solve(index, schedule)
        await client.waitFor('accepted', (message) => message.levelIndex === index)
      }
    }

    // Nobody waits for anybody: both runs are in flight at once, which is the
    // whole of what blaze is.
    await Promise.all([run(ada, 20), run(bo, 400)])

    const finished = await ada.waitFor('finished')
    const podium = finished.podium
    expect(podium).toHaveLength(2)
    expect(podium[0]?.playerId).toBe(ada.playerId)
    expect(podium[0]?.status).toBe('champion')
    expect(placeOf(podium, bo.playerId)).toBe(2)

    const champion = entryOf(podium, ada.playerId)
    const runnerUp = entryOf(podium, bo.playerId)
    expect(champion.levelsSolved).toBe(3)
    expect(runnerUp.levelsSolved).toBe(3)
    // Both solved everything, so the podium is purely a matter of total time.
    expect(champion.totalTimeMs).toBeLessThan(runnerUp.totalTimeMs)
    // Blaze has no level winners, so nobody scores a point.
    expect(champion.points).toBe(0)
    expect(runnerUp.points).toBe(0)

    // Both ends agree, and neither of them was told anything about a board.
    const theirs = await bo.waitFor('finished')
    expect(theirs.podium).toEqual(podium)
    expect(ada.state?.results ?? []).toHaveLength(0)
  })
})

describe.skipIf(!partyReachable)('steady', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('scores a point per level and pauses between them', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, {
      mode: 'steady',
      levelCount: 3,
      difficulty: 'easy',
    })

    const first = await playLevel([ada, bo], 0, schedule)
    expect(first.winnerId).toBe(ada.playerId)
    expect(first.ranking).toEqual([ada.playerId, bo.playerId])
    expect(first.eliminatedId).toBeNull()
    expect(first.finishes.every((finish) => finish.status === 'solved')).toBe(true)
    // The level number is the whole of what a client needs to rebuild the board.
    expect(first.levelNumber).toBe(schedule[0]?.levelNumber)

    await readyUp([ada, bo])
    const second = await playLevel([ada, bo], 1, schedule)
    expect(second.winnerId).toBe(ada.playerId)

    await readyUp([ada, bo])
    // Bo takes the last one, which changes the scoreline without changing the
    // result: two points beats one.
    const third = await playLevel([bo, ada], 2, schedule)
    expect(third.winnerId).toBe(bo.playerId)

    const finished = await ada.waitFor('finished')
    const podium = finished.podium
    expect(podium.map((entry) => entry.playerId)).toEqual([ada.playerId, bo.playerId])
    expect(entryOf(podium, ada.playerId).points).toBe(2)
    expect(entryOf(podium, bo.playerId).points).toBe(1)
    expect(entryOf(podium, ada.playerId).status).toBe('champion')
    expect(entryOf(podium, bo.playerId).status).toBe('finished')

    const state = await ada.waitForPhase('finished')
    expect(state.results.map((result) => result.winnerId)).toEqual([
      ada.playerId,
      ada.playerId,
      bo.playerId,
    ])
  })
})

describe.skipIf(!partyReachable)('knockout', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('drops the slowest player each level down to a head-to-head', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'knockout', difficulty: 'easy' })
    // Length is a function of the room, not of a host's choice: three players
    // is one elimination and then the final.
    expect(schedule).toHaveLength(2)
    expect(ada.state?.levelCount).toBe(2)

    const first = await playLevel([ada, bo, cy], 0, schedule)
    expect(first.winnerId).toBe(ada.playerId)
    expect(first.eliminatedId).toBe(cy.playerId)

    await readyUp([ada, bo])
    const final = await playLevel([ada, bo], 1, schedule)
    expect(final.winnerId).toBe(ada.playerId)
    expect(final.eliminatedId).toBe(bo.playerId)
    // The player already out is not ranked in a level they did not play.
    expect(final.ranking).toEqual([ada.playerId, bo.playerId])

    const finished = await ada.waitFor('finished')
    const podium = finished.podium
    expect(podium.map((entry) => entry.playerId)).toEqual([ada.playerId, bo.playerId, cy.playerId])
    expect(entryOf(podium, ada.playerId).status).toBe('champion')
    expect(entryOf(podium, bo.playerId).status).toBe('knocked-out')
    expect(entryOf(podium, bo.playerId).eliminatedAtLevel).toBe(2)
    expect(entryOf(podium, cy.playerId).status).toBe('knocked-out')
    expect(entryOf(podium, cy.playerId).eliminatedAtLevel).toBe(1)

    // The player knocked out first still sees the whole match end.
    const theirs = await cy.waitFor('finished')
    expect(theirs.podium).toEqual(podium)
  })

  it('refuses a claim from a player who has been knocked out', async () => {
    const { clients } = await openRoom(['Ada', 'Bo', 'Cy'])
    const [ada, bo, cy] = clients as [TestClient, TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'knockout', difficulty: 'easy' })

    const first = await playLevel([ada, bo, cy], 0, schedule)
    expect(first.eliminatedId).toBe(cy.playerId)

    await readyUp([ada, bo])
    await cy.waitFor('level', (message) => message.levelIndex === 1)
    const from = cy.mark()
    cy.solve(1, schedule)
    const error = await cy.waitFor('error', () => true, { from })
    expect(error.code).toBe('not-in-match')
  })
})
