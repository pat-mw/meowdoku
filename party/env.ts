import type { Registry } from './registry'
import type { Room } from './room'

/**
 * The Worker's bindings.
 *
 * Declared by merging into `Cloudflare.Env` rather than as a standalone type,
 * because that is the interface PartyServer's generics default to: every
 * `Server`, every Durable Object stub and `routePartykitRequest` itself then
 * know the room and registry namespaces without each call site restating them.
 * The stub types are what make `registry.allocate()` a checked call rather than
 * a string sent into the dark.
 *
 * Kept in step with wrangler.toml by hand. There are three bindings and they
 * change about as often as the architecture does.
 */
declare global {
  // `Cloudflare.Env` is an ambient global interface owned by the Workers type
  // definitions. Declaration merging is the only way to extend it, and an
  // ambient namespace is the only syntax that does so — there is no module form.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env {
      /** One Durable Object per room code. The authority on a match. */
      Room: DurableObjectNamespace<Room>
      /**
       * The single object that knows which codes are in use. A room cannot see
       * its siblings, so uniqueness has to be decided somewhere that can.
       */
      Registry: DurableObjectNamespace<Registry>
      /**
       * Comma-separated origins allowed to open a socket. Unset means any
       * origin, which is right for `wrangler dev` and wrong for production.
       */
      ALLOWED_ORIGINS?: string
    }
  }
}

/**
 * The binding set, named.
 *
 * An alias so the server files can say `Env` and read like ordinary TypeScript
 * rather than like a global.
 */
export type Env = Cloudflare.Env
