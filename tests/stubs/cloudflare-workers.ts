/**
 * A stand-in for the `cloudflare:workers` module, for unit tests only.
 *
 * Durable Object classes import `DurableObject` and `env` from a virtual module
 * the Workers runtime provides, which Node cannot resolve — which is why the
 * party server's unit tests otherwise reach only its pure helpers, and why a
 * defect in the Durable Object itself went unnoticed by the whole unit suite.
 *
 * The real base class does nothing but hold `ctx` and `env`; everything the
 * server actually relies on lives in `ctx.storage`, which each test supplies for
 * itself. Anything beyond that is deliberately absent, so a dependency on more
 * of the runtime fails loudly here rather than being quietly satisfied.
 */

export class DurableObject<TEnv = unknown> {
  readonly ctx: DurableObjectState
  readonly env: TEnv

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx
    this.env = env
  }
}

/** The ambient binding accessor. Tests pass bindings in explicitly instead. */
export const env: Record<string, unknown> = {}
