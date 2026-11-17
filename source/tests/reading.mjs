/** Multi-file handbook fixture and real renderer reading/navigation assertions. */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'

export async function createHandbook(root) {
  const source = '#import "@local/research-note:0.2.0": handbook, entry\n#show: handbook.with(title: [Preview test])\n#entry("first.typ", include "first.typ")\n#entry("second.typ", include "second.typ")\n'
  for (const [file, title, count] of [['first', 'First note', 40], ['second', 'Second note', 25]]) {
    await writeFile(path.join(root, `${file}.typ`), `#import "@local/research-note:0.2.0": note\n#show: note.with(title: [${title}])\n= ${title} section\n` + Array.from({ length: count }, (_, i) => `Paragraph ${i + 1}. A handbook keeps notes and equations together. This paragraph provides enough content to verify navigation across several pages.\n\n`).join(''))
  }
  return source
}

export async function checkReading(page, evidence) {
  const source = await page.locator('.cm-content').innerText()
  const divider = await page.locator('#divider').boundingBox()
  await page.mouse.move(divider.x + 2, divider.y + 100)
  await page.mouse.down()
  await page.mouse.move(page.viewportSize().width * 0.4, divider.y + 100)
  await page.mouse.up()
  await page.waitForTimeout(700)
  const splitWidth = await page.locator('#source').evaluate(node => node.getBoundingClientRect().width)
  const link = page.locator('#typst-app a[onclick^="handleTypstLocation(this, 4,"]').first()
  const destination = (await link.getAttribute('onclick')).match(/this, (\d+), ([\d.]+), ([\d.]+)/).slice(1).map(Number)
  await link.click()
  const landed = await page.evaluate(async ([pageNo, x, y]) => {
    await new Promise(requestAnimationFrame)
    const target = document.querySelector(`g.typst-page[data-page-number="${pageNo - 1}"]`)
    const point = new DOMPoint(x, y).matrixTransform(target.getScreenCTM())
    const scroller = document.querySelector('#typst-container-main')
    return { top: point.y - scroller.getBoundingClientRect().top, scrollTop: scroller.scrollTop }
  }, destination)
  await writeFile(path.join(evidence, 'reading-jump.json'), JSON.stringify(landed, null, 2))
  assert.ok(landed.top >= 0 && landed.top <= 24, `Directory link must land at the destination immediately: ${JSON.stringify(landed)}`)
  await page.waitForTimeout(700)
  await page.screenshot({ path: path.join(evidence, 'linked-split.png') })
  const position = () => page.evaluate(() => {
    const scroller = document.querySelector('#typst-container-main')
    const viewport = scroller.getBoundingClientRect()
    const target = document.querySelector('g.typst-page[data-page-number="3"]')
    return { y: new DOMPoint(viewport.left, viewport.top).matrixTransform(target.getScreenCTM().inverse()).y, width: viewport.width }
  })
  const before = await position()
  await page.getByRole('button', { name: 'Reading view', exact: true }).click()
  await page.waitForFunction(() => {
    const viewport = document.querySelector('#typst-container-main')
    const svg = document.querySelector('#typst-app > svg')
    return Math.abs(svg.getBoundingClientRect().width - viewport.clientWidth) < 2
  })
  await page.waitForTimeout(700)
  const after = await position()
  assert.ok(after.width > before.width * 1.6)
  assert.ok(Math.abs(after.y - before.y) < 2, `Reading position must survive expanding: ${JSON.stringify({ before, after })}`)
  assert.equal(await page.locator('#source').isVisible(), false)
  await page.screenshot({ path: path.join(evidence, 'reading-view.png') })
  const home = page.locator('g.typst-page[data-page-number="3"] a[onclick^="handleTypstLocation(this, 1,"]').first()
  await home.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('#typst-container-main').scrollTop < 200)
  await page.waitForTimeout(250)
  assert.equal(await page.locator('.cm-editor').evaluate(node => node.contains(document.activeElement)), false, 'Following a reading link must not focus the hidden source')
  await page.locator('#typst-container-main').hover()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -200)
  await page.keyboard.up('Control')
  await page.waitForFunction(() => document.querySelector('#typst-app > svg').getBoundingClientRect().width > document.querySelector('#typst-container-main').clientWidth * 1.05)
  await page.getByRole('button', { name: 'Fit width', exact: true }).click()
  await page.waitForFunction(() => Math.abs(document.querySelector('#typst-app > svg').getBoundingClientRect().width - document.querySelector('#typst-container-main').clientWidth) < 2)
  await page.screenshot({ path: path.join(evidence, 'reading-index.png') })
  await page.getByRole('button', { name: 'Split view', exact: true }).click()
  await page.waitForTimeout(700)
  assert.equal(await page.locator('#source').isVisible(), true)
  assert.ok(Math.abs(await page.locator('#source').evaluate(node => node.getBoundingClientRect().width) - splitWidth) < 2)
  assert.equal(await page.locator('.cm-content').innerText(), source)
  await writeFile(path.join(evidence, 'reading-result.json'), JSON.stringify({ passed: true, instantDirectoryJump: landed, keyboardReturn: true, sourceUnchanged: true, splitWidthRestored: true, fitWidthAfterZoom: true, before, after }, null, 2))
}
