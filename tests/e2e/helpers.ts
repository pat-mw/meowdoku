import type { Locator, Page } from '@playwright/test'

/** Cell states, as they appear at the end of a cell's accessible name. */
export type CellLabelState = 'empty' | 'marked not a cat' | 'cat' | 'wrong guess'

export const cellAt = (page: Page, row: number, col: number): Locator =>
  page.getByRole('gridcell', { name: new RegExp(`^Row ${row}, column ${col},`) })

export const cellState = async (cell: Locator): Promise<CellLabelState> => {
  const label = (await cell.getAttribute('aria-label')) ?? ''
  const state = label.split(', ').pop() ?? ''
  return state as CellLabelState
}

/** Board coordinates of every cell currently in a given state. */
export const cellsInState = async (page: Page, state: CellLabelState): Promise<string[]> =>
  page.evaluate(
    (wanted) =>
      Array.from(document.querySelectorAll('[role="gridcell"]'))
        .map((cell) => cell.getAttribute('aria-label') ?? '')
        .filter((label) => label.endsWith(`, ${wanted}`)),
    state,
  )

/** The centre of a cell in page coordinates. */
export const centreOf = async (cell: Locator): Promise<{ x: number; y: number }> => {
  const box = await cell.boundingBox()
  if (!box) throw new Error('Cell is not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/**
 * Long enough that the next tap on the same cell is a fresh tap rather than the
 * second half of a double-tap.
 */
const DOUBLE_TAP_WINDOW_MS = 320

export const tapCell = async (page: Page, cell: Locator): Promise<void> => {
  const { x, y } = await centreOf(cell)
  await page.mouse.click(x, y)
  await page.waitForTimeout(DOUBLE_TAP_WINDOW_MS)
}

/** Two taps on the same cell inside the double-tap window. */
export const doubleTapCell = async (page: Page, cell: Locator): Promise<void> => {
  const { x, y } = await centreOf(cell)
  await page.mouse.click(x, y)
  await page.mouse.click(x, y, { delay: 0 })
}

/** A press held past the long-press threshold, without moving. */
export const longPressCell = async (page: Page, cell: Locator): Promise<void> => {
  const { x, y } = await centreOf(cell)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.waitForTimeout(500)
  await page.mouse.up()
}

/** A drag stroke across a row, in small steps so every cell is entered. */
export const dragAcross = async (page: Page, from: Locator, to: Locator): Promise<void> => {
  const start = await centreOf(from)
  const end = await centreOf(to)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  const steps = 24
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(
      start.x + ((end.x - start.x) * step) / steps,
      start.y + ((end.y - start.y) * step) / steps,
    )
  }
  await page.mouse.up()
  // The paint set is flushed on the next animation frame.
  await page.waitForTimeout(80)
}

/**
 * Starts from a clean install and waits for the first board to be playable.
 *
 * Storage is wiped once, by hand, rather than through an init script: an init
 * script runs on every navigation, so it would also wipe the save on the reload
 * that the persistence tests are there to check.
 */
export const startFreshGame = async (page: Page): Promise<void> => {
  await page.goto('/')
  await page.evaluate(async () => {
    try {
      localStorage.clear()
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('keyval-store')
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
        request.onblocked = () => resolve()
      })
    } catch {
      // A browser that blocks storage still starts at level 1, which is what we want.
    }
  })
  await page.goto('/play/1')
  await page.getByRole('grid').waitFor({ state: 'visible', timeout: 30_000 })
}

/** Places a correct cat using the reveal power-up, which is deterministic. */
export const revealCat = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /^Reveal a cat/ }).click()
  await page.waitForTimeout(50)
}
