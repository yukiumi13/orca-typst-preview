/** Reading controls for the bundled Tinymist SVG renderer. */
type Renderer = {
  currentScaleRatio: number
  clearSvgResizeAnchor(): void
  addViewportChange(): void
}

function renderers(): Renderer[] {
  const container = document.getElementById('typst-container') as HTMLElement & { documents?: { impl: Renderer }[] }
  return container.documents?.map(document => document.impl) || []
}

export function fitPreviewWidth() {
  for (const renderer of renderers()) {
    renderer.currentScaleRatio = 1
    renderer.addViewportChange()
  }
}

export function installReadingNavigation() {
  const container = document.getElementById('typst-container')!
  const scroller = document.getElementById('typst-container-main')!
  container.addEventListener('click', event => {
    const link = (event.target as Element).closest('a')
    // Recognize only the pinned renderer's numeric destinations; never evaluate
    // a document's inline handler. Other links keep their native behavior.
    const match = link?.getAttribute('onclick')?.match(/^handleTypstLocation\(this,\s*(\d+),\s*([-+\d.e]+),\s*([-+\d.e]+)\);?\s*return false;?$/i)
    if (!match) return
    const [page, x, y] = match.slice(1).map(Number)
    if (![page, x, y].every(Number.isFinite)) return
    const target = container.querySelector<SVGGraphicsElement>(`g.typst-page[data-page-number="${page - 1}"]`)
    const matrix = target?.getScreenCTM()
    if (!matrix) return
    const point = new DOMPoint(x, y).matrixTransform(matrix)
    const viewport = scroller.getBoundingClientRect()
    // Consume the link before Tinymist also treats the click as a source jump.
    event.preventDefault()
    event.stopPropagation()
    for (const renderer of renderers()) renderer.clearSvgResizeAnchor()
    scroller.scrollTo({
      top: scroller.scrollTop + point.y - viewport.top - 16,
      left: point.x < viewport.left || point.x > viewport.right
        ? scroller.scrollLeft + point.x - viewport.left - 16 : scroller.scrollLeft,
      behavior: 'instant',
    })
    for (const renderer of renderers()) renderer.addViewportChange()
  }, true)
}
