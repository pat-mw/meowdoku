import { HTTP_BASE, PARTY_HOST, probeParty } from './harness'

/**
 * Says, once and in the main process, whether there is a server to test against.
 *
 * The suites skip themselves when the party server is missing, which is right —
 * a contributor running the tests without a worker has not broken anything —
 * but a silent skip is indistinguishable from a suite that does not exist.
 * Vitest does not surface a worker's console output for a file whose tests were
 * all skipped, so the explanation has to be printed from here.
 */
export const setup = async (): Promise<void> => {
  if (await probeParty()) {
    console.log(`[integration] Party server: ${HTTP_BASE}`)
    return
  }
  console.log(
    `\n[integration] SKIPPED: no party server answering at ${HTTP_BASE}.\n` +
      '[integration] Start one with `pnpm party:dev`, then run `pnpm test:integration`.\n' +
      `[integration] On another port: PARTY_HOST=127.0.0.1:8799 pnpm test:integration` +
      `${PARTY_HOST === '127.0.0.1:8787' ? '' : ` (currently ${PARTY_HOST})`}\n`,
  )
}
