import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import activate, { deactivate } from '../worker/main.mjs'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const openPort = (port) => new Promise((resolve) => { const socket = net.connect(port, '127.0.0.1'); socket.on('connect', () => { socket.destroy(); resolve(true) }); socket.on('error', () => resolve(false)) })

test('closing an Orca frame aborts its long poll and releases its compiler', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-worker-test-'))
  await writeFile(path.join(root, 'note.typ'), '= Frame lifecycle')
  const handlers = new Map()
  activate({ settings: { get: async () => ({ tinymist: process.env.TINYMIST_BIN || 'tinymist' }) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async (method) => method === 'workspace.readContext' ? { workspaceId: 'test' } : { workspaces: [{ id: 'test', path: root, hostId: 'local' }] } } })
  const context = () => ({ panel: { id: 'test-frame' }, signal: new AbortController().signal })
  try {
    const opened = await handlers.get('preview.open')({ path: path.join(root, 'note.typ') }, context())
    let aborted = false
    for (let n = 0; n < 20 && !aborted; n++) {
      const control = new AbortController()
      const timer = setTimeout(() => control.abort(), 30)
      await handlers.get('preview.poll')({ view: opened.view }, { panel: { id: 'test-frame' }, signal: control.signal })
      aborted = control.signal.aborted
      clearTimeout(timer)
    }
    assert.ok(aborted, 'a live long poll was cancelled by the host')
    for (let n = 0; n < 100 && await openPort(opened.dataPort); n++) await delay(50)
    assert.equal(await openPort(opened.dataPort), false)
    await assert.rejects(handlers.get('preview.send')({ view: opened.view, method: 'diagnostics' }, context()), /preview is closed/)
  } finally { await deactivate(); await rm(root, { recursive: true, force: true }) }
})

test('identical documents stay in their captured workspaces after focus changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-workspaces-'))
  const text = '= Identical notes'
  const workspaces = ['a', 'b'].map((id) => ({ id, name: id, path: path.join(root, id), hostId: 'local' }))
  for (const workspace of workspaces) { await mkdir(workspace.path); await writeFile(path.join(workspace.path, 'note.typ'), text) }
  let active = 'a'
  const handlers = new Map()
  activate({ settings: { get: async () => ({ exportPdf: true }) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async (method) => method === 'workspace.readContext' ? { workspaceId: active } : { workspaces } } })
  const call = (panel, name, input = {}) => handlers.get(`preview.${name}`)(input, { panel: { id: panel }, signal: new AbortController().signal })
  const hash = createHash('sha256').update(text).digest('hex')
  try {
    assert.equal((await call('first', 'workspace')).workspace.id, 'a')
    active = 'b'
    assert.equal((await call('second', 'workspace')).workspace.id, 'b')
    const a = await call('first', 'discover', { hash })
    const b = await call('second', 'discover', { hash })
    assert.deepEqual(a.files.map((file) => file.path), [path.join(root, 'a/note.typ')])
    assert.deepEqual(b.files.map((file) => file.path), [path.join(root, 'b/note.typ')])
    await writeFile(path.join(root, 'a/twin.typ'), text)
    const untrustedHint = await call('first', 'discover', { hash, preferredPath: path.join(root, 'a/twin.typ') })
    assert.equal(untrustedHint.files.length, 2, 'a caller-supplied hint cannot bypass the captured desktop selection')
    assert.equal(untrustedHint.source, 'scan')
    await assert.rejects(call('first', 'open', { path: b.files[0].path }), /outside this workspace/)
    const first = await call('first', 'open', { path: a.files[0].path })
    const second = await call('second', 'open', { path: b.files[0].path })
    assert.notEqual(first.pid, second.pid)
    assert.equal(first.pdf, path.join(root, 'a/note.pdf'))
    assert.equal(second.pdf, path.join(root, 'b/note.pdf'))
    await call('first', 'close', { view: first.view })
    assert.equal(await openPort(second.dataPort), true)
    await call('second', 'close', { view: second.view })
  } finally { await deactivate(); await rm(root, { recursive: true, force: true }) }
})

test('an empty workspace result can be retried without recreating the editor frame', async () => {
  const handlers = new Map()
  let available = false
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  activate({ settings: { get: async () => ({}) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async (method) => method === 'workspace.readContext' ? { workspaceId: 'retry', displayName: 'Retry' } : { workspaces: available ? [{ id: 'retry', name: 'Retry', path: '/tmp/retry', hostId: 'local' }] : [] } } })
  if (explicit !== undefined) process.env.ORCA_CLI_COMMAND = explicit
  const context = { panel: { id: 'retry-frame' }, signal: new AbortController().signal }
  try {
    const empty = await handlers.get('preview.workspace')({}, context)
    assert.equal(empty.workspace, null)
    assert.ok(empty.problem)
    available = true
    assert.equal((await handlers.get('preview.workspace')({}, context)).workspace.id, 'retry')
  } finally { await deactivate() }
})

test('an explicit workspace correction cannot be forged and confines compilation to that root', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-correct-workspace-'))
  const workspaces = ['stale', 'intended'].map(id => ({ id, name: id, path: path.join(root, id), hostId: 'local' }))
  for (const workspace of workspaces) { await mkdir(workspace.path); await writeFile(path.join(workspace.path, 'index.typ'), '= Same initial template') }
  const handlers = new Map()
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  activate({ settings: { get: async () => ({ exportPdf: false }) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async method => method === 'workspace.readContext' ? { workspaceId: 'stale' } : { workspaces } } })
  if (explicit !== undefined) process.env.ORCA_CLI_COMMAND = explicit
  const call = (name, input = {}) => handlers.get(`preview.${name}`)(input, { panel: { id: 'corrected-frame' }, signal: new AbortController().signal })
  try {
    assert.equal((await call('workspace')).workspace.id, 'stale')
    assert.equal((await call('files')).files[0].root, workspaces[0].path)
    await assert.rejects(call('selectWorkspace', { id: 'intended' }), /current list/)
    await call('workspaces')
    await assert.rejects(call('selectWorkspace', { id: 'forged', path: '/elsewhere' }), /current list/)
    assert.equal((await call('selectWorkspace', { id: 'intended' })).workspace.id, 'intended')
    const files = await call('files')
    assert.equal(files.files[0].root, workspaces[1].path)
    await assert.rejects(call('open', { path: path.join(workspaces[0].path, 'index.typ') }), /outside this workspace/)
    const opened = await call('open', { path: files.files[0].path })
    assert.equal(opened.root, workspaces[1].path)
    await call('workspaces')
    await assert.rejects(call('selectWorkspace', { id: 'stale' }), /Close this preview/)
    await call('close', { view: opened.view })
  } finally { await deactivate(); await rm(root, { recursive: true, force: true }) }
})

test('pasting a path corrects only its own frame and failed paths leave the binding intact', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-paste-path-'))
  const workspaces = ['stale', 'intended', 'foreign'].map(id => ({ id, name: id, path: path.join(root, id), hostId: id === 'foreign' ? 'runtime:other' : 'local' }))
  for (const workspace of workspaces) { await mkdir(workspace.path); await writeFile(path.join(workspace.path, 'my note.typ'), '= Same initial template') }
  await symlink(path.join(workspaces[2].path, 'my note.typ'), path.join(workspaces[1].path, 'escape.typ'))
  await mkdir(path.join(workspaces[1].path, 'directory.typ'))
  const handlers = new Map()
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  activate({ settings: { get: async () => ({ exportPdf: false }) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async method => method === 'workspace.readContext' ? { workspaceId: 'stale' } : { workspaces } } })
  if (explicit !== undefined) process.env.ORCA_CLI_COMMAND = explicit
  const call = (panel, name, input = {}) => handlers.get(`preview.${name}`)(input, { panel: { id: panel }, signal: new AbortController().signal })
  try {
    await call('other-tab', 'workspace')
    for (const file of [path.join(workspaces[1].path, 'missing.typ'), path.join(workspaces[1].path, 'escape.typ'), path.join(workspaces[1].path, 'directory.typ'), path.join(workspaces[2].path, 'my note.typ')]) {
      await assert.rejects(call('pasted-tab', 'openPath', { path: file }))
      assert.equal((await call('pasted-tab', 'workspace')).workspace.id, 'stale')
    }
    const opened = await call('pasted-tab', 'openPath', { path: `"${workspaces[1].path}/my note.typ"` })
    assert.equal(opened.workspace.id, 'intended')
    assert.equal(opened.root, workspaces[1].path)
    assert.equal((await call('pasted-tab', 'workspace')).workspace.id, 'intended')
    assert.equal((await call('other-tab', 'workspace')).workspace.id, 'stale')
    await assert.rejects(call('pasted-tab', 'openPath', { path: `${workspaces[0].path}/my note.typ` }), /Close this preview/)
    await call('pasted-tab', 'close', { view: opened.view })
  } finally { await deactivate(); await rm(root, { recursive: true, force: true }) }
})

test('frames with the same native caller id cannot share bindings, file lists or view leases', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'typst-shared-caller-'))
  const workspaces = ['a', 'b'].map(id => ({ id, name: id, path: path.join(root, id), hostId: 'local' }))
  for (const workspace of workspaces) { await mkdir(workspace.path); await writeFile(path.join(workspace.path, 'note.typ'), '= Identical template') }
  const handlers = new Map()
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  let active = 'a'
  activate({ settings: { get: async () => ({ exportPdf: false }) }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async method => method === 'workspace.readContext' ? { workspaceId: active } : { workspaces } } })
  if (explicit !== undefined) process.env.ORCA_CLI_COMMAND = explicit
  const a = randomUUID(), b = randomUUID()
  const call = (frame, name, input = {}) => handlers.get(`preview.${name}`)({ ...input, frame }, { panel: { id: 'same-native-editor' }, signal: new AbortController().signal })
  try {
    assert.equal((await call(a, 'workspace')).workspace.id, 'a')
    active = 'b'
    assert.equal((await call(b, 'workspace')).workspace.id, 'b')
    assert.equal((await call(a, 'files')).files[0].root, workspaces[0].path)
    assert.equal((await call(b, 'files')).files[0].root, workspaces[1].path)
    await call(a, 'workspaces')
    await assert.rejects(call(b, 'selectWorkspace', { id: 'a' }), /current list/)
    const openedA = await call(a, 'open', { path: `${workspaces[0].path}/note.typ` })
    const openedB = await call(b, 'open', { path: `${workspaces[1].path}/note.typ` })
    await assert.rejects(call(b, 'send', { view: openedA.view, method: 'diagnostics' }), /preview is closed/)
    await assert.rejects(call(b, 'close', { view: openedA.view }), /preview is closed/)
    await call(a, 'detach')
    assert.equal(await openPort(openedA.dataPort), false)
    assert.equal(await openPort(openedB.dataPort), true)
    assert.equal((await call(b, 'workspace')).workspace.id, 'b')
    await call(b, 'close', { view: openedB.view })
  } finally { await deactivate(); await rm(root, { recursive: true, force: true }) }
})

test('detaching during workspace lookup prevents a late preview from opening', async () => {
  const handlers = new Map()
  let finishLookup
  const lookup = new Promise(resolve => { finishLookup = resolve })
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  activate({ settings: { get: async () => { throw new Error('A detached frame must not start a backend') } }, panels: { handle: (name, fn) => { handlers.set(name, fn); return { dispose() {} } } }, host: { call: async method => method === 'workspace.readContext' ? lookup : { workspaces: [{ id: 'test', name: 'Test', path: '/unused', hostId: 'local' }] } } })
  if (explicit !== undefined) process.env.ORCA_CLI_COMMAND = explicit
  const frame = randomUUID()
  const context = { panel: { id: 'shared-caller' }, signal: new AbortController().signal }
  try {
    const opening = handlers.get('preview.open')({ frame, path: '/unused/note.typ' }, context)
    await handlers.get('preview.detach')({ frame }, context)
    finishLookup({ workspaceId: 'test' })
    await assert.rejects(opening, /closed during startup/)
  } finally { await deactivate() }
})
