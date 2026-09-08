import { expect, test, type Page } from '@playwright/test'
import { cellAt, cellState, cellsInState, revealCat, startFreshGame, tapCell } from './helpers'

/**
 * Progress must outlive a reload, a backgrounding and a relaunch. A player who
 * loses a half-solved board to a refresh will not come back.
 */
test.describe('persistence', () => {
  test('a mid-puzzle board survives a reload', async ({ page }) => {
    await startFreshGame(page)
    await tapCell(page, cellAt(page, 1, 1))
    await tapCell(page, cellAt(page, 2, 3))
    await revealCat(page)

    const before = {
      marked: await cellsInState(page, 'marked not a cat'),
      cats: await cellsInState(page, 'cat'),
    }
    // Give the debounced write time to land before the reload.
    await page.waitForTimeout(300)
    await page.reload()
    await page.getByRole('grid').waitFor({ state: 'visible', timeout: 30_000 })

    expect(await cellsInState(page, 'marked not a cat')).toEqual(before.marked)
    expect(await cellsInState(page, 'cat')).toEqual(before.cats)
    await expect(page.getByRole('button', { name: /^Reveal a cat, 1 left/ })).toBeVisible()
  })

  test('completing a level unlocks the next one and records stars', async ({ page }) => {
    await startFreshGame(page)
    // Reveals cost score but win the level deterministically, which is what this
    // test is about; the scoring itself is covered by unit tests.
    for (let i = 0; i < 2; i++) await revealCat(page)
    await solveRemainingByDeduction(page)

    await expect(page.getByRole('dialog', { name: 'Level complete' })).toBeVisible({
      timeout: 20_000,
    })
    await page.getByRole('button', { name: 'Level select' }).click()
    await expect(page.getByRole('button', { name: /^Level 2$/ })).toBeEnabled()
    await expect(page.getByRole('button', { name: /^Level 1, \d of 3 stars/ })).toBeVisible()
  })

  test('a locked level cannot be opened by deep link', async ({ page }) => {
    await startFreshGame(page)
    await page.goto('/play/40')
    await expect(page.getByRole('heading', { name: 'Levels' })).toBeVisible()
  })
})

/**
 * Finishes the board by double-tapping every cell the solution needs. The cats
 * already placed are read from the DOM, and the rest are found by trying each
 * row's cells until one lands - a wrong guess costs a fish, so the walk marks
 * cells off first and only attempts cells no placed cat rules out.
 */
const solveRemainingByDeduction = async (page: Page): Promise<void> => {
  const size = await page.evaluate(
    () => document.querySelectorAll('[role="gridcell"]').length ** 0.5,
  )
  for (let attempt = 0; attempt < size * size; attempt++) {
    const cats = await cellsInState(page, 'cat')
    if (cats.length >= size) return
    const taken = cats.map((label) => {
      const match = /^Row (\d+), column (\d+),/.exec(label)
      return { row: Number(match?.[1]), col: Number(match?.[2]) }
    })
    let moved = false
    for (let row = 1; row <= size && !moved; row++) {
      if (taken.some((cat) => cat.row === row)) continue
      for (let col = 1; col <= size; col++) {
        if (taken.some((cat) => cat.col === col)) continue
        if (taken.some((cat) => Math.abs(cat.row - row) <= 1 && Math.abs(cat.col - col) <= 1))
          continue
        const cell = cellAt(page, row, col)
        if ((await cellState(cell)) !== 'empty') continue
        const { x, y } = await cell.boundingBox().then((box) => ({
          x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
          y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
        }))
        await page.mouse.click(x, y)
        await page.mouse.click(x, y, { delay: 0 })
        await page.waitForTimeout(60)
        moved = true
        break
      }
    }
    if (!moved) return
  }
}
