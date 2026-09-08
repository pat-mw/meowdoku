import { expect, test } from '@playwright/test'
import {
  cellAt,
  cellState,
  cellsInState,
  doubleTapCell,
  dragAcross,
  longPressCell,
  revealCat,
  startFreshGame,
  tapCell,
} from './helpers'

/**
 * Every row of the interaction table, on real mobile engines. These are the
 * tests that catch the things unit tests cannot: scroll fighting, double-tap
 * zoom, and pointer capture behaving differently on WebKit than on Chromium.
 */
test.describe('board gestures', () => {
  test.beforeEach(async ({ page }) => {
    await startFreshGame(page)
  })

  test('tap marks an empty cell, and tapping again clears it', async ({ page }) => {
    const cell = cellAt(page, 1, 1)
    await expect.poll(() => cellState(cell)).toBe('empty')
    await tapCell(page, cell)
    await expect.poll(() => cellState(cell)).toBe('marked not a cat')
    await tapCell(page, cell)
    await expect.poll(() => cellState(cell)).toBe('empty')
  })

  test('long-press clears a mark and does nothing to an empty cell', async ({ page }) => {
    const marked = cellAt(page, 2, 2)
    await tapCell(page, marked)
    await expect.poll(() => cellState(marked)).toBe('marked not a cat')
    await longPressCell(page, marked)
    await expect.poll(() => cellState(marked)).toBe('empty')

    // A long press on an empty cell is a no-op, not a mark.
    await longPressCell(page, marked)
    await expect.poll(() => cellState(marked)).toBe('empty')
  })

  test('double-tap attempts a cat, and a wrong guess costs a fish', async ({ page }) => {
    await revealCat(page)
    const cats = await cellsInState(page, 'cat')
    expect(cats).toHaveLength(1)

    // Any other cell in the revealed cat's row is guaranteed to be a wrong guess.
    const match = /^Row (\d+), column (\d+),/.exec(cats[0] ?? '')
    const catRow = Number(match?.[1])
    const catCol = Number(match?.[2])
    const wrongCol = catCol === 1 ? 2 : 1
    const wrongCell = cellAt(page, catRow, wrongCol)

    await expect(page.getByLabel('3 of 3 fish left')).toBeVisible()
    await doubleTapCell(page, wrongCell)
    await expect.poll(() => cellState(wrongCell)).toBe('wrong guess')
    await expect(page.getByLabel('2 of 3 fish left')).toBeVisible()
  })

  test('a cat cell ignores every gesture once placed', async ({ page }) => {
    await revealCat(page)
    const cats = await cellsInState(page, 'cat')
    const match = /^Row (\d+), column (\d+),/.exec(cats[0] ?? '')
    const cat = cellAt(page, Number(match?.[1]), Number(match?.[2]))

    await tapCell(page, cat)
    await expect.poll(() => cellState(cat)).toBe('cat')
    await longPressCell(page, cat)
    await expect.poll(() => cellState(cat)).toBe('cat')
    await doubleTapCell(page, cat)
    await expect.poll(() => cellState(cat)).toBe('cat')
  })

  test('a drag from an empty cell paints marks and never disturbs other states', async ({ page }) => {
    const anchor = cellAt(page, 3, 3)
    await tapCell(page, anchor)
    await expect.poll(() => cellState(anchor)).toBe('marked not a cat')

    await dragAcross(page, cellAt(page, 3, 1), cellAt(page, 3, 5))

    for (const col of [1, 2, 4, 5]) {
      await expect.poll(() => cellState(cellAt(page, 3, col))).toBe('marked not a cat')
    }
    // The already-marked cell is untouched, not toggled off by the stroke.
    await expect.poll(() => cellState(anchor)).toBe('marked not a cat')
  })

  test('a drag that starts on a marked cell paints nothing', async ({ page }) => {
    const start = cellAt(page, 4, 1)
    await tapCell(page, start)
    await expect.poll(() => cellState(start)).toBe('marked not a cat')

    const before = await cellsInState(page, 'marked not a cat')
    await dragAcross(page, start, cellAt(page, 4, 5))
    const after = await cellsInState(page, 'marked not a cat')
    expect(after).toEqual(before)
  })

  test('dragging the board never scrolls the page or zooms it', async ({ page }) => {
    const scrollBefore = await page.evaluate(() => window.scrollY)
    await dragAcross(page, cellAt(page, 1, 1), cellAt(page, 5, 5))
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore)

    await doubleTapCell(page, cellAt(page, 2, 4))
    const scale = await page.evaluate(() => window.visualViewport?.scale ?? 1)
    expect(scale).toBe(1)
  })

  test('the hint power-up marks a cell and explains itself', async ({ page }) => {
    await page.getByRole('button', { name: /^Hint/ }).click()
    await expect(page.getByRole('status')).toBeVisible()
    const marked = await cellsInState(page, 'marked not a cat')
    expect(marked.length).toBeGreaterThan(0)
    await expect(page.getByRole('button', { name: /^Hint, 2 left/ })).toBeVisible()
  })
})
