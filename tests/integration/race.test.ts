import { afterEach, describe, expect, it } from 'vitest'
import { PROGRESS_TICK_INTERVAL_MS } from '../../src/multiplayer/protocol'
import type { ProgressTick } from '../../src/multiplayer/protocol'
import {
  type TestClient,
  closeAllClients,
  openRoom,
  partyReachable,
  sleep,
  solutionFor,
  startMatch,
} from './harness'

/**
 * The two things that make a race a race: seeing your opponents, and the
 * server — not the players — deciding who was quicker.
 */

/** Every sample the server published for one player, oldest first. */
const samplesFor = (client: TestClient, playerId: string | null): ProgressTick[] =>
  client.received
    .filter((message) => message.t === 'progress')
    .flatMap((message) => (message.t === 'progress' ? message.ticks : []))
    .filter((tick) => tick[0] === playerId)

const tickTimes = (client: TestClient): number[] =>
  client.received.flatMap((message) => (message.t === 'progress' ? [message.at] : []))

describe.skipIf(!partyReachable)('the progress bar', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('carries one player’s cats to the other, in order', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    await ada.waitFor('level', (message) => message.levelIndex === 0)
    await bo.waitFor('level', (message) => message.levelIndex === 0)

    const from = bo.mark()
    // Spaced wider than the server's coalescing interval, so each one is its
    // own tick rather than being folded into the last.
    for (const cats of [1, 2, 3]) {
      ada.send({ t: 'progress', cats })
      await sleep(PROGRESS_TICK_INTERVAL_MS + 120)
    }

    await bo.waitFor(
      'progress',
      (message) => message.ticks.some((tick) => tick[0] === ada.playerId && tick[2] === 3),
      { from },
    )

    const seen = samplesFor(bo, ada.playerId).map((tick) => tick[2])
    expect(seen.length).toBeGreaterThanOrEqual(3)
    // Monotonic here because the script only ever adds cats. A bar that retreats
    // is legal — cats can be removed — but a sample must never arrive out of
    // order, and these land in the order they were sent.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number)
    }
    const steps = seen.filter((cats, index) => index === 0 || cats !== seen[index - 1])
    // Every value the player passed through reached the opponent exactly once.
    // The leading zero is the level's opening flush and may or may not have gone
    // out before the first cat did.
    expect(steps.filter((cats) => cats > 0)).toEqual([1, 2, 3])

    // The level index travels with every sample, because blaze players are
    // routinely on different levels at the same moment.
    expect(samplesFor(bo, ada.playerId).every((tick) => tick[1] === 0)).toBe(true)

    // Timestamps are the server's and never go backwards.
    const times = tickTimes(bo)
    expect(times.length).toBeGreaterThan(1)
    expect([...times].sort((a, b) => a - b)).toEqual(times)

    // A player sees their opponent, not only themselves.
    expect(samplesFor(bo, bo.playerId).length).toBeGreaterThan(0)
  })

  it('clamps a claim of more cats than the board holds', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    const size = schedule[0]?.size ?? 0
    expect(size).toBeGreaterThan(0)
    await ada.waitFor('level', (message) => message.levelIndex === 0)

    const from = bo.mark()
    ada.send({ t: 'progress', cats: 31 })
    const tick = await bo.waitFor(
      'progress',
      (message) => message.ticks.some((sample) => sample[0] === ada.playerId && sample[2] > 0),
      { from },
    )
    const mine = tick.ticks.find((sample) => sample[0] === ada.playerId)
    // A bar is drawn out of the board size, so a number bigger than the board
    // would draw past the end of it.
    expect(mine?.[2]).toBe(size)
  })
})

describe.skipIf(!partyReachable)('timing authority', () => {
  afterEach(() => {
    closeAllClients()
  })

  it('ignores a claimed time and ranks by the server’s own measurement', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada, bo] = clients as [TestClient, TestClient]
    const schedule = await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    await ada.waitFor('level', (message) => message.levelIndex === 0)
    await bo.waitFor('level', (message) => message.levelIndex === 0)

    // Bo genuinely solves first.
    bo.solve(0, schedule, 900)
    const honest = await bo.waitFor('accepted', (message) => message.levelIndex === 0)

    // Ada solves nearly a second later and claims to have been instant.
    await sleep(900)
    ada.solve(0, schedule, 1)
    const liar = await ada.waitFor('accepted', (message) => message.levelIndex === 0)

    // The server measured Ada from the level start it broadcast, so the claim
    // bought nothing at all.
    expect(liar.elapsedMs).toBeGreaterThan(800)
    expect(liar.elapsedMs).toBeGreaterThan(honest.elapsedMs)

    const result = (await bo.waitFor('result', (message) => message.result.levelIndex === 0)).result
    expect(result.winnerId).toBe(bo.playerId)
    expect(result.ranking).toEqual([bo.playerId, ada.playerId])
    const recorded = result.finishes.find((finish) => finish.playerId === ada.playerId)
    expect(recorded?.elapsedMs).toBe(liar.elapsedMs)

    const standings = (await bo.waitForPhase('interlude')).players
    expect(standings.find((player) => player.id === bo.playerId)?.points).toBe(1)
    expect(standings.find((player) => player.id === ada.playerId)?.points).toBe(0)
  })

  it('refuses a solution that is not the board’s', async () => {
    const { clients } = await openRoom(['Ada', 'Bo'])
    const [ada] = clients as [TestClient]
    const schedule = await startMatch(ada, { mode: 'steady', levelCount: 3, difficulty: 'easy' })
    const spec = schedule[0]
    if (!spec) throw new Error('no first level')
    await ada.waitFor('level', (message) => message.levelIndex === 0)

    // The right shape, the wrong answer: rotating the solution keeps one cat
    // per row and per column and still breaks the regions.
    const solution = solutionFor(spec.levelNumber)
    const rotated = solution.map((col) => (col + 1) % spec.size)
    expect(rotated).not.toEqual(solution)

    const from = ada.mark()
    ada.send({ t: 'solved', claim: { levelIndex: 0, cols: rotated }, clientMs: 10 })
    const refused = await ada.waitFor('error', () => true, { from })
    expect(refused.code).toBe('invalid-solution')

    // A claim for a level the player is not on is refused before any board is
    // built, so a client cannot make the room do work by asking.
    const second = ada.mark()
    ada.send({ t: 'solved', claim: { levelIndex: 2, cols: solution }, clientMs: 10 })
    const wrongLevel = await ada.waitFor('error', () => true, { from: second })
    expect(wrongLevel.code).toBe('not-in-match')

    // And the real answer is still accepted afterwards.
    const third = ada.mark()
    ada.solve(0, schedule)
    const accepted = await ada.waitFor('accepted', () => true, { from: third })
    expect(accepted.levelIndex).toBe(0)
  })
})
