/** Real Chromium + Tinymist, with an Orca document/worker bridge test fixture. */
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, mkdtemp, rm, access, utimes } from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import activate, { deactivate } from '../worker/main.mjs'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const remote = process.env.TYPST_TEST_WORKSPACE ? JSON.parse(process.env.TYPST_TEST_WORKSPACE) : null
const evidence = path.resolve(root, '../../outputs/tasks/orca-typst-preview', process.env.TYPST_TEST_TAG || (remote ? 'paired-ui' : 'ui'))
await mkdir(evidence, { recursive: true })
const fixture = '#import "@local/research-note:0.2.0": note\n#show: note.with(title: [Preview test], owner: [Local fixture])\n\n= Live notes\nThis document uses the local g3doc template.\n\n#table(columns: (1fr, 1fr), [Budget], [Success], [4 steps], [42.1%])\n'
const workspaceRoot = process.env.TYPST_TEST_ROOT || await mkdtemp('/tmp/typst-browser-')
await writeFile(path.join(workspaceRoot, 'preview.typ'), fixture)
await writeFile(path.join(workspaceRoot, 'older.typ'), fixture)
await utimes(path.join(workspaceRoot, 'older.typ'), 1, 1)
const correction = !!process.env.TYPST_TEST_CORRECTION && !remote
const pastePath = !!process.env.TYPST_TEST_PASTE_PATH
const staleRoot = correction ? await mkdtemp('/tmp/typst-browser-stale-') : null
if (staleRoot) await writeFile(path.join(staleRoot, 'preview.typ'), fixture)
const handlers = new Map()
const retryEmpty = !!process.env.TYPST_TEST_RETRY
let workspaceReads = 0
const explicitCli = process.env.ORCA_CLI_COMMAND
if (!remote) delete process.env.ORCA_CLI_COMMAND
activate({
  settings: { get: async () => ({ tinymist: process.env.TINYMIST_BIN || 'tinymist' }) },
  panels: { handle: (name, handler) => { handlers.set(name, handler); return { dispose() {} } } },
  host: { call: async (name) => name === 'workspace.readContext' ? { workspaceId: remote?.id || (correction ? 'stale' : 'browser') } : { workspaces: remote ? [{ ...remote, name: remote.displayName || 'Research notes', hostId: `runtime:${process.env.TYPST_TEST_ENVIRONMENT}` }] : (retryEmpty && workspaceReads++ === 0) ? [] : [{ id: 'browser', name: 'Research notes', path: workspaceRoot, hostId: 'local' }, ...(staleRoot ? [{ id: 'stale', name: 'Stale workspace', path: staleRoot, hostId: 'local' }] : [])] } }
})
if (!remote && explicitCli !== undefined) process.env.ORCA_CLI_COMMAND = explicitCli
const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.wasm': 'application/wasm' }
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
    const file = path.resolve(root, 'dist', '.' + rel)
    if (!file.startsWith(path.join(root, 'dist') + path.sep)) { res.writeHead(403); res.end(); return }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream')
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'none'; object-src 'none'")
    res.end(await readFile(file))
  } catch { res.writeHead(404); res.end() }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
const errors = []
const portOpen = (port) => new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true) }); socket.on('error', () => resolve(false)) })
const started = Date.now()
const opened = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
const signal = new AbortController()
await page.exposeFunction('workerRequest', async (name, input) => {
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 65536, 'Orca request size limit')
  let result
  try { result = await handlers.get(name)(input, { panel: { id: 'browser-test', surface: 'editor' }, signal: signal.signal }) }
  catch (error) { console.log('RPC failed:', name, input.method, error.stack); throw error }
  if (name === 'preview.open' || name === 'preview.openPath') { opened.push(result); console.log('Opened:', result) }
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'Orca worker replies must contain only JSON values')
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1048576, 'Orca reply size limit')
  return result
})
await page.addInitScript(({ text }) => {
  let doc = { version: 1, readOnly: false, content: { kind: 'text', text } }
  window.orca = { plugin: { request: (name, input) => window.workerRequest(name, input) },
    document: { get: async () => doc, onDidChange: (fn) => { fn(doc); return { dispose() {} } }, applyEdit: async (edit) => { doc = { ...doc, content: edit.content }; return null } },
    on: () => ({ dispose() {} }) }
}, { text: fixture })
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/editor/index.html`)
  if (retryEmpty) {
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Needs attention')
    await page.getByRole('button', { name: 'Preview', exact: true }).click()
  }
  await page.waitForFunction(() => document.querySelector('#file-picker')?.options.length > 1)
  assert.equal(opened.length, 0, 'listing files must not compile an automatically guessed document')
  await assert.rejects(access(path.join(workspaceRoot, 'preview.pdf')))
  if (staleRoot) {
    await assert.rejects(access(path.join(staleRoot, 'preview.pdf')))
    assert.equal(await page.locator('#workspace-path').textContent(), staleRoot)
    if (!pastePath) {
      await page.getByRole('button', { name: 'Change preview workspace' }).click()
      await page.locator('#workspace-picker').selectOption('browser')
      await page.waitForFunction(root => document.querySelector('#workspace-path')?.textContent === root, workspaceRoot)
    }
  }
  const options = await page.locator('#file-picker option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent })))
  if (!pastePath || !staleRoot) assert.ok(options.findIndex(option => option.value.endsWith('/preview.typ')) < options.findIndex(option => option.value.endsWith('/older.typ')), 'recent file precedes identical old contents')
  assert.ok(options[1].text.includes('modified'))
  await page.screenshot({ path: path.join(evidence, 'choose-file.png') })
  if (pastePath) {
    await page.locator('#file-path').fill(path.join(workspaceRoot, 'missing.typ'))
    await page.locator('#file-path').press('Enter')
    await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Needs attention')
    assert.equal(await page.locator('#workspace-path').textContent(), staleRoot || workspaceRoot)
    await page.locator('#file-path').fill(`"${path.join(workspaceRoot, 'preview.typ')}"`)
    await page.locator('#file-path').press('t')
    assert.equal(await page.locator('#typst-app').evaluate(element => element.classList.contains('invert-colors')), false, 'typing a path must not toggle preview theme')
    await page.locator('#file-path').press('Backspace')
    await page.locator('#file-path').press('Enter')
  } else await page.locator('#file-picker').selectOption(path.join(workspaceRoot, 'preview.typ'))
  await page.waitForFunction(() => document.querySelector('#typst-app svg, #typst-app canvas'), null, { timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(evidence, 'preview-light.png') })
  console.log('Initial rendering:', await page.locator('#status').textContent(), 'after', Date.now() - started, 'ms')
  const initialGlyphs = await page.locator('#typst-app svg use').count()
  assert.equal(await page.locator('#filename').getAttribute('title'), path.join(workspaceRoot, 'preview.typ'))
  assert.equal(opened[0].workspace.id, remote?.id || 'browser')
  console.log('Initial glyphs:', initialGlyphs)
  const editStarted = Date.now()
  await page.locator('.cm-content').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\n= Edited without saving\nA second section appears immediately.')
  await page.waitForFunction((before) => document.querySelector('#status')?.textContent === 'Live' && document.querySelectorAll('#typst-app svg use').length > before + 20, initialGlyphs, { timeout: 45000 })
  console.log('Unsaved edit rendered after', Date.now() - editStarted, 'ms')
  await page.waitForTimeout(200)
  await page.screenshot({ path: path.join(evidence, 'preview-edited.png') })
  assert.equal(await readFile(path.join(workspaceRoot, 'preview.typ'), 'utf8'), fixture)
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Preview closed')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Live')
  await page.waitForTimeout(1500)
  await page.getByRole('button', { name: 'Close preview', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Preview closed')
  if (staleRoot) await assert.rejects(access(path.join(staleRoot, 'preview.pdf')))
  for (const preview of opened) {
    for (let n = 0; n < 50 && await portOpen(preview.dataPort); n++) await page.waitForTimeout(100)
    assert.equal(await portOpen(preview.dataPort), false, 'closing preview releases its data port')
    assert.equal(await portOpen(preview.controlPort), false, 'closing preview releases its control port')
  }
  await writeFile(path.join(evidence, 'errors.json'), JSON.stringify(errors, null, 2))
  assert.deepEqual(errors.filter((message) => !message.includes('404')), [])
  await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ route: remote ? 'paired Orca server through saved environment' : 'local', explicitFileSelection: true, pastedPath: pastePath, modificationOrder: !pastePath || !staleRoot, correctedWorkspace: correction, rendered: true, unsavedSourcePreserved: true, closeReopen: true, elapsedMs: Date.now() - started, opened }, null, 2))
  console.log('Rendered template; unsaved edits and close/reopen passed. Evidence:', evidence)
} catch (error) {
  console.log('Browser errors:', errors)
  console.log('Page:', (await page.locator('body').innerText()).slice(0,5000))
  await page.screenshot({ path: path.join(evidence, 'failure.png') })
  throw error
} finally { signal.abort(); await browser.close(); await deactivate(); server.close(); await rm(workspaceRoot, { recursive: true, force: true }); if (staleRoot) await rm(staleRoot, { recursive: true, force: true }) }
