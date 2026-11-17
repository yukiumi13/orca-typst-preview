import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { startBackend, shellQuote } from '../worker/client.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const openPort = (port) => new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true) }); socket.on('error', () => resolve(false)) })
async function eventually(check) { for (let n = 0; n < 60; n++) { if (await check()) return; await delay(50) } assert.fail('Condition did not become true') }

test('independent documents, shared views, memory updates, imports, and port cleanup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-preview-test-'))
  const original = '#import "shared.typ": label\n= Original\n#label'
  await writeFile(path.join(root, 'shared.typ'), '#let label = "Imported text"')
  await writeFile(path.join(root, 'first.typ'), original)
  await writeFile(path.join(root, 'second.typ'), '= Second document')
  const backend = await startBackend()
  const events = []
  backend.on('event', (event) => events.push(event))
  const open = (name, view) => backend.call({ method: 'open', roots: [root], path: path.join(root, name), tinymist: process.env.TINYMIST_BIN || 'tinymist', view })
  try {
    const found = await backend.call({ method: 'discover', roots: [root], hash: createHash('sha256').update(original).digest('hex') })
    assert.deepEqual(found.files.filter((file) => file.match).map((file) => path.basename(file.path)), ['first.typ'])
    const [first, second] = await Promise.all([open('first.typ', 'a'), open('second.typ', 'b')])
    const shared = await open('first.typ', 'c')
    assert.equal(first.pid, shared.pid)
    assert.notEqual(first.pid, second.pid)
    assert.equal(new Set([first.dataPort, first.controlPort, second.dataPort, second.controlPort]).size, 4)
    await backend.call({ method: 'socket.open', view: 'a', socket: '1' })
    await eventually(() => events.some((event) => event.event === 'socket.open'))
    await backend.call({ method: 'socket.send', view: 'a', socket: '1', data: 'current' })
    await backend.call({ method: 'update', view: 'a', text: '#import "shared.typ": label\n= Unsaved title\n#label' })
    await eventually(() => events.some((event) => event.value?.items?.some((item) => item.title === 'Unsaved title')))
    assert.equal(await readFile(path.join(root, 'first.typ'), 'utf8'), original)
    await eventually(() => events.some((event) => event.event === 'socket.data' && event.binary))
    const beforeCursor = events.length
    await backend.call({ method: 'cursor', view: 'a', line: 1, character: 3 })
    await eventually(() => events.slice(beforeCursor).some((event) => event.event === 'socket.data' && Buffer.from(event.part || '', 'base64').toString().startsWith('jump,')))
    await backend.call({ method: 'close', view: 'a' })
    assert.equal(await openPort(first.dataPort), true, 'another view retains the shared process')
    await backend.call({ method: 'close', view: 'c' })
    await eventually(async () => !(await openPort(first.dataPort)) && !(await openPort(first.controlPort)))
    assert.equal(await openPort(second.dataPort), true, 'other document remains live')
    await backend.close()
    await eventually(async () => !(await openPort(second.dataPort)))
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})

test('Native terminal command quotes preserve arbitrary source text', () => {
  assert.equal(shellQuote("a'b$(`x`)"), "'a'\\''b$(`x`)'  ".trimEnd())
})


test('saved PDFs are atomic, ignore unsaved buffers, and retain the last good PDF on error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-pdf-test-'))
  const file = path.join(root, 'note.typ')
  await writeFile(file, '= Saved original')
  const backend = await startBackend()
  const events = []
  backend.on('event', (event) => events.push(event))
  const saved = () => events.filter((event) => event.event === 'pdf' && event.saved).length
  try {
    const opened = await backend.call({ method: 'open', roots: [root], path: file, view: 'pdf' })
    await eventually(() => saved() === 1)
    const original = await readFile(opened.pdf)
    await backend.call({ method: 'socket.open', view: 'pdf', socket: 'pdf' })
    await eventually(() => events.some((event) => event.event === 'socket.open'))
    await backend.call({ method: 'socket.send', view: 'pdf', socket: 'pdf', data: 'current' })
    await backend.call({ method: 'update', view: 'pdf', text: '= Unsaved draft' })
    await eventually(() => events.some((event) => event.value?.items?.some((item) => item.title === 'Unsaved draft')))
    assert.deepEqual(await readFile(opened.pdf), original)
    await writeFile(file, '#unknown-function()')
    await eventually(() => events.some((event) => event.event === 'pdf' && !event.saved))
    assert.deepEqual(await readFile(opened.pdf), original)
    await writeFile(file, '= Newly saved source')
    await eventually(() => saved() === 2)
    assert.notDeepEqual(await readFile(opened.pdf), original)
    assert.equal(await readFile(file, 'utf8'), '= Newly saved source')
    await backend.close()
    assert.deepEqual((await readdir(root)).sort(), ['note.pdf', 'note.typ'])
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})

test('discovery normalizes line endings and rejects symlinks escaping the workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-discovery-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'typst-outside-'))
  const backend = await startBackend()
  try {
    await writeFile(path.join(root, 'note.typ'), '\uFEFF= Notes\r\nBody\r\n')
    await writeFile(path.join(outside, 'secret.typ'), '= Secret')
    await symlink(path.join(outside, 'secret.typ'), path.join(root, 'link.typ'))
    const result = await backend.call({ method: 'discover', roots: [root], hash: createHash('sha256').update('= Notes\nBody\n').digest('hex') })
    assert.deepEqual(result.files.map((file) => [path.basename(file.path), file.match]), [['note.typ', true]])
    await assert.rejects(backend.call({ method: 'open', roots: [root], path: path.join(root, 'link.typ'), view: 'escape' }), /outside this workspace/)
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})
