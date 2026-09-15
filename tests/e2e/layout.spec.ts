import { expect, test, type Page } from '@playwright/test'
import { seedUnlockedTo } from './helpers'

/**
 * The rules strip shows its three pictograms in one fixed place on every board
 * size, so what a test has to settle is whether that still fits a phone at the
 * largest board. The two viewports below are the tightest the game targets: a
 * 390x844 iPhone 13 and a 360x800 Android. The board is the thing a player
 * cannot scroll to find mid-gesture, so it must sit entirely inside the
 * viewport, with the strip above it and also fully on screen.
 */

/** Grandmaster tier: always 15x15, the largest board the game produces. */
const LARGEST_BOARD_LEVEL = 1001

const PHONES = [
  { name: 'iPhone 13', width: 390, height: 844 },
  { name: 'small Android', width: 360, height: 800 },
]

/** The page's own scroll box, which is what a bounding box is measured against. */
const viewportOf = (page: Page) =>
  page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollY: window.scrollY,
    /** Taller than the viewport means something below the fold needs scrolling to. */
    documentHeight: document.documentElement.scrollHeight,
  }))

for (const phone of PHONES) {
  test.describe(`a 15x15 board on a ${phone.name}`, () => {
    test.use({ viewport: { width: phone.width, height: phone.height } })

    test('keeps the full rules strip above the board, all on screen', async ({ page }) => {
      await seedUnlockedTo(page, LARGEST_BOARD_LEVEL)
      await page.goto(`/play/${LARGEST_BOARD_LEVEL}`)
      const board = page.getByRole('grid', { name: 'Puzzle board, 15 by 15' })
      await board.waitFor({ state: 'visible', timeout: 40_000 })
      await expect(page.getByRole('gridcell')).toHaveCount(225)

      const rules = page.getByRole('region', { name: 'How to play' })
      await expect(rules).toBeVisible()
      // All three pictograms, not a summary line standing in for them.
      await expect(rules.getByText('1 cat per color')).toBeVisible()
      await expect(rules.getByText('1 cat per row & column')).toBeVisible()
      await expect(rules.getByText('Cats cannot touch')).toBeVisible()

      const viewport = await viewportOf(page)
      expect(viewport.scrollY).toBe(0)
      // The whole screen has to fit, not only the two boxes measured below: the
      // power-up toolbar sits under the board and must not push the page into a
      // scroll the player would have to fight mid-gesture.
      expect(viewport.documentHeight).toBeLessThanOrEqual(viewport.height)
      const boardBox = await board.boundingBox()
      const rulesBox = await rules.boundingBox()
      if (!boardBox || !rulesBox) throw new Error('the board and the rules must both be laid out')

      // Reported so a regression says by how much, not merely that it failed.
      console.log(
        `${phone.name} ${phone.width}x${phone.height}: board ${boardBox.y.toFixed(0)}..` +
          `${(boardBox.y + boardBox.height).toFixed(0)}, rules ${rulesBox.y.toFixed(0)}..` +
          `${(rulesBox.y + rulesBox.height).toFixed(0)}, viewport height ${viewport.height}`,
      )

      expect(boardBox.y).toBeGreaterThanOrEqual(0)
      expect(boardBox.y + boardBox.height).toBeLessThanOrEqual(viewport.height)
      expect(boardBox.x).toBeGreaterThanOrEqual(0)
      expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(viewport.width)
      expect(rulesBox.y).toBeGreaterThanOrEqual(0)
      expect(rulesBox.y + rulesBox.height).toBeLessThanOrEqual(viewport.height)
      // The rules belong between the pills and the grid at every board size. An
      // earlier version moved them below the board on large ones to buy height
      // the board turned out not to need, which made the screen rearrange itself
      // as the player climbed the tiers.
      expect(rulesBox.y + rulesBox.height).toBeLessThanOrEqual(boardBox.y)
    })
  })
}
