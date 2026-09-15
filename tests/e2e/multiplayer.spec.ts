import { expect, test } from '@playwright/test'
import type { BrowserContext, Page } from '@playwright/test'
import { solveUnique } from '../../src/board/generator/uniqueness'
import { cellAt, cellState, doubleTapCell } from './helpers'

/**
 * Two real browsers, one room, one match.
 *
 * The integration suite proves the rules against a running server. This proves
 * the other half: that two independent browser sessions, each with its own
 * storage and its own socket, meet in a room, see each other move, and agree on
 * who won — through the actual screens, the actual gestures and the actual
 * lazily-loaded multiplayer chunk.
 *
 * WHAT IT NEEDS. A party server (`pnpm party:dev`) and a build that knows where
 * it is (`VITE_PARTY_HOST`), because the host is read at build time. Without
 * both, every test here skips with a line saying so rather than failing: a
 * contributor running the e2e suite for a board-gesture change has not broken
 * multiplayer by not running a worker.
 *
 *     pnpm party:dev
 *     VITE_PARTY_HOST=127.0.0.1:8787 pnpm test:e2e multiplayer
 *
 * HOW IT SOLVES A BOARD. There is no reveal power-up in a race and no level
 * number on screen, so the test reads the board out of the accessibility tree —
 * every cell names its row, its column and its region — and runs the same exact
 * solver the generator uses to prove a puzzle unique. The browser is then driven
 * through the real double-tap gesture, cat by cat. Nothing is injected, and the
 * server still verifies every claim.
 */

const PARTY_HOST = (process.env['VITE_PARTY_HOST'] ?? '').trim().replace(/^[a-z]+:\/\//i, '')

const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(PARTY_HOST)

const partyBase = `${isLoopback ? 'http' : 'https'}://${PARTY_HOST}`

const SKIP_REASON =
  PARTY_HOST === ''
    ? 'VITE_PARTY_HOST is not set, so this build has no party server. Run `pnpm party:dev` and ' +
      'rebuild with VITE_PARTY_HOST=127.0.0.1:8787 to include the multiplayer e2e tests.'
    : `No party server answering at ${partyBase}. Start one with \`pnpm party:dev\`.`

/** Settled once per worker, so a missing server costs one request rather than one per test. */
let partyReachable = false

test.beforeAll(async () => {
  if (PARTY_HOST === '') return
  try {
    const response = await fetch(`${partyBase}/health`, { signal: AbortSignal.timeout(2_500) })
    const body = (await response.json()) as { ok?: unknown }
    partyReachable = response.ok && body.ok === true
  } catch {
    partyReachable = false
  }
})

/** A room code, minted by the server exactly as the create-room screen mints one. */
const allocateRoom = async (): Promise<string> => {
  const response = await fetch(`${partyBase}/rooms`, { method: 'POST' })
  const body = (await response.json()) as { code?: unknown }
  if (typeof body.code !== 'string') throw new Error('the party server would not mint a code')
  return body.code
}

/** Every cell's accessible name, in DOM order. Empty while no board is on screen. */
const readCells = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="gridcell"]')).map(
      (cell) => cell.getAttribute('aria-label') ?? '',
    ),
  )

/** `Row 3, column 5, light blue, empty` */
const CELL_LABEL = /^Row (\d+), column (\d+), (.+), [^,]+$/

/**
 * Which region each cell belongs to, as one string.
 *
 * Used to tell one board from the next without knowing either level number: a
 * new level is a new set of regions, and an empty signature means the board has
 * left the screen altogether.
 */
const boardSignature = async (page: Page): Promise<string> =>
  (await readCells(page)).map((label) => CELL_LABEL.exec(label)?.[3] ?? '?').join('|')

/**
 * The one solution of the board currently on screen.
 *
 * `solveUnique` is the generator's own exact solver, so this is not a second
 * implementation of the rules — it is the same search that proved the puzzle
 * had exactly one answer in the first place.
 */
const solveVisibleBoard = async (page: Page): Promise<number[]> => {
  const labels = await readCells(page)
  const size = Math.round(Math.sqrt(labels.length))
  if (size < 4 || size * size !== labels.length) {
    throw new Error(`the board on screen has ${labels.length} cells, which is not a square`)
  }
  const regions = new Int32Array(size * size)
  const ids = new Map<string, number>()
  for (const label of labels) {
    const parsed = CELL_LABEL.exec(label)
    if (!parsed) throw new Error(`unreadable cell: ${label}`)
    const row = Number(parsed[1]) - 1
    const col = Number(parsed[2]) - 1
    const region = parsed[3] as string
    if (!ids.has(region)) ids.set(region, ids.size)
    regions[row * size + col] = ids.get(region) as number
  }
  const solution = solveUnique(size, regions)
  if (solution === null) throw new Error('the board on screen has no unique solution')
  return solution
}

/** Waits until a board is on screen and fully described. */
const waitForBoard = async (page: Page): Promise<void> => {
  await page.getByRole('grid').first().waitFor({ state: 'visible', timeout: 45_000 })
  await expect
    .poll(
      async () => {
        const count = (await readCells(page)).length
        const size = Math.round(Math.sqrt(count))
        return count > 0 && size * size === count
      },
      { timeout: 20_000 },
    )
    .toBe(true)
}

/**
 * Places one cat, retrying the gesture until it lands.
 *
 * The retry is what covers the countdown: a board is on screen for three
 * seconds before it will accept anything, and a double-tap during that window
 * is simply ignored rather than mis-applied. It also stops the moment the board
 * changes underneath, which is what the final cat of a level does in blaze.
 */
const placeCat = async (page: Page, row: number, col: number, signature: string): Promise<void> => {
  const cell = cellAt(page, row + 1, col + 1)
  await expect
    .poll(
      async () => {
        if ((await boardSignature(page)) !== signature) return 'moved on'
        if ((await cellState(cell)) === 'cat') return 'cat'
        await doubleTapCell(page, cell)
        await page.waitForTimeout(150)
        return (await boardSignature(page)) === signature ? await cellState(cell) : 'moved on'
      },
      { timeout: 30_000 },
    )
    .toMatch(/^(cat|moved on)$/)
}

/** Solves whatever board is on screen, cat by cat, through the real gesture. */
const solveVisibleLevel = async (page: Page): Promise<void> => {
  await waitForBoard(page)
  const signature = await boardSignature(page)
  const solution = await solveVisibleBoard(page)
  for (let row = 0; row < solution.length; row++) {
    await placeCat(page, row, solution[row] as number, signature)
  }
}

/**
 * Takes a browser session into a room by code.
 *
 * The room is entered by deep link, which is how a shared invite arrives, and
 * the code is typed anyway so the test exercises the field that guests really
 * use rather than only the link that filled it.
 */
const joinRoom = async (page: Page, code: string, name: string): Promise<void> => {
  await page.goto(`/multiplayer?room=${code}`)
  const codeField = page.locator('#mp-room-code')
  const joinEntry = page.getByRole('button', { name: /^join/i })
  await codeField.or(joinEntry).first().waitFor({ state: 'visible', timeout: 45_000 })
  // The deep link may land on the join form directly or on the multiplayer menu;
  // either way the next thing is the form.
  if ((await codeField.count()) === 0) await joinEntry.first().click()
  await codeField.waitFor({ state: 'visible', timeout: 20_000 })

  await codeField.fill(code)
  await page.locator('#mp-guest-name').fill(name)
  await page.getByRole('button', { name: 'Join room' }).click()
  await expect(page.getByRole('heading', { name: 'Waiting room' })).toBeVisible({ timeout: 20_000 })
}

test.describe('multiplayer, two browsers', () => {
  let guest: BrowserContext | null = null

  test.afterEach(async () => {
    await guest?.close()
    guest = null
  })

  test('two players meet in one room and race a blaze match to a podium', async ({
    browser,
    baseURL,
    page,
  }) => {
    test.skip(!partyReachable, SKIP_REASON)
    // Six boards solved by hand through real gestures, plus a countdown.
    test.setTimeout(240_000)

    const code = await allocateRoom()
    // A context built by hand rather than a second `page` fixture: this is a
    // genuinely separate browser session, with its own storage and its own
    // socket, which is the only way to have two players. It inherits nothing
    // from the project's `use`, so the base URL has to be handed over.
    guest = await browser.newContext(baseURL === undefined ? {} : { baseURL })
    const guestPage = await guest.newPage()

    // Two independent sessions: separate storage, separate sockets, separate
    // players, and neither of them told anything about the other's board.
    await joinRoom(page, code, 'Ada')
    await joinRoom(guestPage, code, 'Bo')

    const hostRoster = page.getByRole('list', { name: 'Players' })
    const guestRoster = guestPage.getByRole('list', { name: 'Players' })
    await expect(hostRoster.getByText('Bo', { exact: true })).toBeVisible()
    await expect(guestRoster.getByText('Ada', { exact: true })).toBeVisible()
    // The first to arrive hosts, and only the host gets the button.
    const start = page.getByRole('button', { name: 'Start match' })
    await expect(start).toBeEnabled()
    await expect(guestPage.getByRole('button', { name: 'Start match' })).toHaveCount(0)

    // The shortest match this room can play: three small boards, no pauses.
    // Each choice is confirmed on the host's own screen before the next one is
    // made. A radio here is a button whose checked state comes back from the
    // room rather than from the browser, so an unconfirmed click is not merely
    // slow to show — it may never have been sent at all, and checking here is
    // what tells a failure further down which side of the socket went wrong.
    const hostMode = page.getByRole('radiogroup', { name: 'Mode' })
    await hostMode.getByRole('radio', { name: /^Blaze/ }).click()
    await expect(hostMode.getByRole('radio', { name: /^Blaze/ })).toBeChecked()
    const hostLevels = page.getByRole('radiogroup', { name: 'Levels' })
    await hostLevels.getByRole('radio', { name: '3' }).click()
    await expect(hostLevels.getByRole('radio', { name: '3' })).toBeChecked()
    const hostDifficulty = page.getByRole('radiogroup', { name: 'Difficulty' })
    await hostDifficulty.getByRole('radio', { name: 'Easy' }).click()
    await expect(hostDifficulty.getByRole('radio', { name: 'Easy' })).toBeChecked()
    // The guest sees the host's choices without being able to press them. This
    // one waits longer than the default because it is the first assertion in
    // the test that has to cross the socket twice — host to room, room to guest
    // — which every other cross-socket wait here is also given room for.
    const guestBlaze = guestPage
      .getByRole('radiogroup', { name: 'Mode' })
      .getByRole('radio', { name: /^Blaze/ })
    await expect(guestBlaze).toBeChecked({ timeout: 20_000 })
    await expect(guestBlaze).toBeDisabled()

    await start.click()

    // Blaze never pauses, so each player simply runs their own three boards.
    await solveVisibleLevel(page)

    // Ada is a whole board ahead, and Bo's race strip says so — which is the
    // entire point of the strip. The assertion reads the strip's spoken
    // standings rather than its headline, because that line carries the two
    // things being claimed in one string: who leads, and which level they are
    // on. The visible headline only names the leader, and matching a bare name
    // inside the strip is ambiguous anyway — the name appears in the headline
    // and again in the standings.
    await expect(guestPage.getByLabel('Race progress').getByRole('listitem').first()).toHaveText(
      /^1st: Ada, \d+ cats placed on level 2$/,
      { timeout: 20_000 },
    )

    await solveVisibleLevel(guestPage)
    await solveVisibleLevel(page)
    await solveVisibleLevel(guestPage)
    await solveVisibleLevel(page)
    await solveVisibleLevel(guestPage)

    // Ada solved every board before Bo started it, so Ada's total is lower and
    // the server — which timed all six — says so to both browsers.
    await expect(page.getByRole('heading', { name: 'You win!' })).toBeVisible({ timeout: 45_000 })
    await expect(guestPage.getByRole('heading', { name: 'Ada wins' })).toBeVisible({
      timeout: 45_000,
    })
  })

  test('a code nobody is using is refused before a socket is opened', async ({ page }) => {
    test.skip(!partyReachable, SKIP_REASON)

    await page.goto('/multiplayer')
    const codeField = page.locator('#mp-room-code')
    const joinEntry = page.getByRole('button', { name: /^join/i })
    await codeField.or(joinEntry).first().waitFor({ state: 'visible', timeout: 45_000 })
    if ((await codeField.count()) === 0) await joinEntry.first().click()

    await codeField.fill('22222')
    await page.locator('#mp-guest-name').fill('Ada')
    await page.getByRole('button', { name: 'Join room' }).click()

    await expect(page.getByText('No room with that code.')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('heading', { name: 'Waiting room' })).toHaveCount(0)
  })
})
