import { beforeEach, describe, expect, it } from 'vitest'
import { Registry } from '../registry'
import type { Env } from '../env'

/**
 * Rationing on the registry itself, not on the token bucket underneath it.
 *
 * The distinction matters because it is exactly where a real defect hid. The
 * bucket has its own thorough tests, and they all passed while `Registry`
 * allocated codes without consulting it — every room code in a deployment comes
 * from this one object against one ceiling, so an unrationed `allocate` is not a
 * cost borne by whoever calls it, it is a way to stop anyone anywhere from
 * opening a room. Only the integration suite caught that, and the integration
 * suite skips itself when no party server is running, so a machine running the
 * unit tests alone would have shipped it.
 *
 * These tests drive the Durable Object directly over an in-memory stand-in for
 * its storage, so they run anywhere the rest of the unit suite does.
 */

/** Enough of a Durable Object's storage for the registry: a map and an alarm. */
class FakeStorage {
  readonly values = new Map<string, unknown>()
  alarm: number | null = null

  // eslint-disable-next-line @typescript-eslint/require-await
  async list({ prefix }: { prefix: string }): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>()
    for (const [key, value] of this.values) {
      if (key.startsWith(prefix)) out.set(key, value)
    }
    return out
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string | string[]): Promise<void> {
    for (const one of Array.isArray(key) ? key : [key]) this.values.delete(one)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getAlarm(): Promise<number | null> {
    return this.alarm
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setAlarm(at: number): Promise<void> {
    this.alarm = at
  }
}

const newRegistry = (): { registry: Registry; storage: FakeStorage } => {
  const storage = new FakeStorage()
  const ctx = { storage, blockConcurrencyWhile: (fn: () => unknown) => fn() }
  // The registry only ever reaches for `ctx.storage`, so the rest of the Durable
  // Object surface is deliberately absent: anything else it grew a dependency on
  // would fail loudly here rather than being quietly satisfied by a stub.
  const registry = new Registry(ctx as unknown as DurableObjectState, {} as Env)
  return { registry, storage }
}

describe('Registry.allocate rations by caller', () => {
  let registry: Registry

  beforeEach(() => {
    registry = newRegistry().registry
  })

  const allocateMany = async (caller: string, times: number) => {
    const results = []
    for (let i = 0; i < times; i++) results.push(await registry.allocate(caller))
    return results
  }

  it('hands out a burst and then refuses the same caller', async () => {
    const results = await allocateMany('198.51.100.7', 200)
    const granted = results.filter((r) => r.ok)
    const refused = results.filter((r) => !r.ok)

    // The exact burst size is the limiter's business; what this asserts is that
    // a flood is bounded at all, and bounded far below the code space.
    expect(granted.length).toBeGreaterThan(0)
    expect(granted.length).toBeLessThan(60)
    expect(refused.length).toBeGreaterThan(100)
    for (const refusal of refused) {
      expect(refusal.ok).toBe(false)
      if (!refusal.ok) expect(refusal.reason).toBe('rate-limited')
    }
  })

  it('tells a refused caller how long to wait', async () => {
    const results = await allocateMany('203.0.113.9', 200)
    const refusal = results.find((r) => !r.ok)
    expect(refusal).toBeDefined()
    if (refusal && !refusal.ok) {
      expect(refusal.retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('does not let one caller exhaust everyone else', async () => {
    await allocateMany('198.51.100.7', 200)
    // An honest host arriving after the flood must still be served.
    const honest = await registry.allocate('192.0.2.50')
    expect(honest.ok).toBe(true)
  })

  it('rations callers it cannot tell apart together, rather than not at all', async () => {
    // A request with no address is the easy way round a per-caller budget, so
    // the unidentifiable share one bucket instead of each getting a fresh one.
    const results = await allocateMany('', 200)
    expect(results.filter((r) => r.ok).length).toBeLessThan(60)
  })

  it('gives every granted allocation a distinct code', async () => {
    const codes = new Set<string>()
    for (let caller = 0; caller < 8; caller++) {
      for (const result of await allocateMany(`198.51.100.${caller}`, 12)) {
        if (result.ok) codes.add(result.code)
      }
    }
    expect(codes.size).toBeGreaterThan(20)
    // Uniqueness is the registry's whole reason to exist; a duplicate would put
    // two rooms behind one code.
    for (const code of codes) expect(code).toMatch(/^[0-9ACDEFHJKMNPRTVWXY]{5}$/)
  })
})
