/** Runs on the workspace host; owns live previews and adjacent saved-source PDFs. */
import { spawn, execFile } from 'node:child_process'
import { access, readdir, readFile, realpath, stat, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { gzipSync, gunzipSync } from 'node:zlib'

const sessions = new Map()
const views = new Map()
const sockets = new Map()
const MAX_TEXT = 8 * 1024 * 1024
const skipped = new Set(['.git', '.orca', 'node_modules', '__pycache__', '.venv', 'target', 'dist'])
let lastContact = Date.now()
let stopping = false
const wireNonce = process.env.TYPST_PREVIEW_WIRE
const outputQueue = []
let outputOffset = 0; let wireSequence = 0; let awaitingAck = 0; let queuedBytes = 0
function pump() {
  if (!wireNonce || awaitingAck || stopping) return
  // Orca retains only 4,000 characters of a partial terminal line. Keep each
  // frame below that bound even when PTY reads split a line arbitrarily.
  // Keep the acknowledgement window conservative: remote CLI replies may
  // apply a smaller output budget than the retained terminal transcript.
  for (let count = 0; count < 8 && outputQueue.length; count++) {
    const message = outputQueue[0]
    const chunk = message.slice(outputOffset, outputOffset + 2400)
    queuedBytes -= chunk.length
    outputOffset += chunk.length
    const end = outputOffset >= message.length
    process.stdout.write(`TPREV_${wireNonce}:${++wireSequence}:${end ? 1 : 0}:${chunk}:END\n`)
    if (end) { outputQueue.shift(); outputOffset = 0 }
    awaitingAck = wireSequence
  }
}
function emit(value) {
  if (stopping) return
  const json = JSON.stringify(value)
  if (!wireNonce) { process.stdout.write(`${json}\n`); return }
  const frame = gzipSync(Buffer.from(json), { level: 1 }).toString('base64')
  queuedBytes += frame.length
  if (queuedBytes > 32 * 1024 * 1024) { shutdown(); return }
  outputQueue.push(frame)
  pump()
}
const hash = (text) => createHash('sha256').update(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')).digest('hex')
const inside = (root, file) => { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)) }
const expand = (value) => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value

async function rootsFor(input) {
  if (!Array.isArray(input.roots) || !input.roots.length) throw new Error('The preview has no bound workspace.')
  return [...new Set(await Promise.all(input.roots.map((root) => realpath(expand(root)))))]
}

async function discover(input, matchContent = true) {
  const roots = await rootsFor(input)
  const files = new Map()
  const seen = new Set()
  let visited = 0
  let truncated = false
  async function readCandidate(file, root) {
    try {
      const canonical = await realpath(file)
      if (!inside(root, canonical) || !/\.typ$/i.test(canonical)) return
      const info = await stat(canonical)
      if (!info.isFile() || info.size > MAX_TEXT) return
      if (!matchContent) return { path: canonical, root, modifiedAt: info.mtimeMs }
      const text = await readFile(canonical, 'utf8')
      return { path: canonical, root, match: hash(text) === input.hash }
    } catch { /* A file can disappear during discovery. */ }
  }
  // The desktop session supplies a hint, not an editor document identity.
  // Verify it before enumerating files; stale or foreign hints fall back to scanning.
  if (matchContent && typeof input.preferredPath === 'string' && path.isAbsolute(input.preferredPath)) {
    for (const root of roots) {
      const candidate = await readCandidate(input.preferredPath, root)
      if (candidate?.match) return { files: [candidate], truncated: false, source: 'candidate' }
    }
  }
  async function add(file, root) {
    if (files.size >= 2000) { truncated = true; return }
    const candidate = await readCandidate(file, root)
    if (candidate) files.set(candidate.path, candidate)
  }
  async function scan(dir, root) {
    if (seen.has(dir)) return
    seen.add(dir)
    if (++visited > 10000 || files.size >= 2000) { truncated = true; return }
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.size >= 2000) { truncated = true; return }
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && !skipped.has(entry.name) && !entry.name.startsWith('.')) await scan(file, root)
      else if (entry.isFile() && /\.typ$/i.test(entry.name)) await add(file, root)
    }
  }
  for (const root of roots) {
    try {
      const { stdout } = await promisify(execFile)('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ':(icase)*.typ'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
      for (const name of stdout.split('\0').filter(Boolean)) await add(path.resolve(root, name), root)
    } catch { await scan(root, root) }
  }
  const result = []
  let bytes = 0
  const candidates = [...files.values()]
  if (!matchContent) candidates.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
  for (const file of candidates) {
    bytes += Buffer.byteLength(JSON.stringify(file))
    if (bytes > 650000) { truncated = true; break }
    result.push(file)
  }
  return { files: result, truncated, source: 'scan' }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => { socket.close(); reject(new Error('Tinymist connection timed out.')) }, 10000)
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket) }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to Tinymist.')) }, { once: true })
  })
}

async function compilerPath(configured) {
  const name = expand(configured || 'tinymist')
  if (name !== 'tinymist') return name
  const candidates = [...String(process.env.PATH || '').split(path.delimiter).map((directory) => path.join(directory, 'tinymist')), path.join(os.homedir(), '.local/bin/tinymist'), path.join(os.homedir(), '.cargo/bin/tinymist'), '/opt/homebrew/bin/tinymist', '/usr/local/bin/tinymist']
  for (const candidate of candidates) { try { await access(candidate); return candidate } catch {} }
  return name
}

async function exportSavedPdf(session) {
  if (session.stopping || session.pdfBusy) return
  session.pdfBusy = true
  let temporary
  try {
    const info = await stat(session.file)
    const signature = `${info.ino}:${info.mtimeMs}:${info.ctimeMs}:${info.size}`
    if (signature === session.pdfSignature) return
    session.pdfSignature = signature
    const before = await readFile(session.file)
    if (session.stopping || stopping) return
    temporary = path.join(path.dirname(session.file), `.${path.basename(session.file)}.preview-${randomUUID()}.pdf`)
    session.pdfTemporary = temporary
    const args = ['compile', '--root', session.root, ...session.compilerOptions, session.file, temporary]
    const child = spawn(session.compiler, args, { cwd: session.root, stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
    session.pdfChild = child
    let errors = ''
    child.stderr.on('data', (chunk) => { errors = (errors + chunk.toString()).slice(-4000) })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    if (session.stopping) return
    if (code !== 0) throw new Error(errors || `PDF compilation exited (${code}).`)
    if (!before.equals(await readFile(session.file))) { session.pdfSignature = null; return }
    await rename(temporary, session.pdf)
    session.pdfState = { saved: true, path: session.pdf }
    for (const [id, view] of views) if (view.session === session) emit({ event: 'pdf', view: id, path: session.pdf, saved: true })
  } catch (error) {
    session.pdfState = { saved: false, path: session.pdf, message: error.message }
    if (!session.stopping) for (const [id, view] of views) if (view.session === session) emit({ event: 'pdf', view: id, path: session.pdf, saved: false, message: error.message })
  } finally {
    session.pdfBusy = false; session.pdfChild = null; session.pdfTemporary = null
    if (temporary) await rm(temporary, { force: true }).catch(() => {})
  }
}

async function stopSession(session) {
  if (session.stopping) return
  session.stopping = true
  clearInterval(session.pdfTimer)
  session.pdfChild?.kill('SIGTERM')
  if (session.pdfTemporary) void rm(session.pdfTemporary, { force: true }).catch(() => {})
  sessions.delete(session.file)
  for (const [id, view] of views) if (view.session === session) closeView(id, false)
  session.control?.close()
  session.child.kill('SIGTERM')
  const timer = setTimeout(() => session.child.kill('SIGKILL'), 1500)
  timer.unref()
  session.child.once('exit', () => clearTimeout(timer))
}

function closeView(id, collect = true) {
  const view = views.get(id)
  if (!view) return
  views.delete(id)
  for (const [key, socket] of sockets) if (key.startsWith(`${id}:`)) { sockets.delete(key); socket.close() }
  if (collect && ![...views.values()].some((other) => other.session === view.session)) void stopSession(view.session)
}

async function startSession(input) {
  const roots = await rootsFor(input)
  const file = await realpath(input.path)
  const root = roots.filter((candidate) => inside(candidate, file)).sort((a, b) => b.length - a.length)[0]
  if (!root || !/\.typ$/i.test(file)) throw new Error('The selected Typst file is outside this workspace.')
  const info = await stat(file)
  if (!info.isFile() || info.size > MAX_TEXT) throw new Error('Choose a regular .typ file no larger than 8 MiB.')
  if (sessions.has(file)) return sessions.get(file).ready
  const args = ['preview', file, '--root', root, '--no-open', '--verbose', '--data-plane-host=127.0.0.1:0', '--control-plane-host=127.0.0.1:0']
  const compilerOptions = []
  for (const [key, flag] of [['fontPath', '--font-path'], ['packagePath', '--package-path']]) if (input[key]) compilerOptions.push(flag, expand(input[key]))
  args.push(...compilerOptions)
  const compiler = await compilerPath(input.tinymist)
  // Another open may have completed path lookup while executable discovery awaited.
  if (sessions.has(file)) return sessions.get(file).ready
  if (stopping) throw new Error('Preview was closed during startup.')
  const child = spawn(compiler, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: process.env })
  const session = { child, file, root, compiler, compilerOptions, pdf: file.replace(/\.typ$/i, '.pdf'), pdfSignature: null, control: null, dataPort: null, controlPort: null, stopping: false, logs: '', ready: null }
  sessions.set(file, session)
  session.ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { void stopSession(session); reject(new Error(`Tinymist did not become ready. ${session.logs.slice(-2000)}`)) }, 20000)
    let connecting = false
    child.on('error', (error) => { clearTimeout(timeout); sessions.delete(file); reject(new Error(`Cannot start Tinymist: ${error.message}`)) })
    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (!session.stopping) {
        for (const [id, view] of views) if (view.session === session) emit({ event: 'error', view: id, message: `Tinymist exited (${code}). ${session.logs.slice(-2000)}` })
        void stopSession(session)
        reject(new Error(`Tinymist exited (${code}). ${session.logs.slice(-2000)}`))
      }
    })
    child.stderr.on('data', async (chunk) => {
      session.logs = (session.logs + chunk.toString()).slice(-16000)
      session.dataPort ??= Number(session.logs.match(/Data plane server listening on:\s*127\.0\.0\.1:(\d+)/)?.[1]) || null
      session.controlPort ??= Number(session.logs.match(/Control panel server listening on:\s*127\.0\.0\.1:(\d+)/)?.[1]) || null
      if (!session.dataPort || !session.controlPort || connecting) return
      connecting = true
      try {
        session.control = await connect(`ws://127.0.0.1:${session.controlPort}`)
        session.control.addEventListener('message', ({ data }) => {
          let value
          try { value = JSON.parse(String(data)) } catch { return }
          for (const [id, view] of views) if (view.session === session) emit({ event: 'control', view: id, value })
        })
        clearTimeout(timeout)
        if (input.exportPdf !== false) {
          session.pdfTimer = setInterval(() => void exportSavedPdf(session), 500)
          session.pdfTimer.unref()
          void exportSavedPdf(session)
        }
        resolve(session)
      } catch (error) { clearTimeout(timeout); void stopSession(session); reject(error) }
    })
  })
  return session.ready
}

async function handle(input) {
  lastContact = Date.now()
  switch (input.method) {
    case 'ping': return { ok: true }
    case 'discover': return discover(input)
    case 'files': return discover(input, false)
    case 'open': {
      if (views.has(input.view)) throw new Error('Preview view already open.')
      const session = await startSession(input)
      views.set(input.view, { session })
      return { path: session.file, root: session.root, pdf: session.pdf, pdfState: session.pdfState, exportPdf: !!session.pdfTimer, dataPort: session.dataPort, controlPort: session.controlPort, pid: session.child.pid }
    }
    case 'close': closeView(input.view); return { ok: true }
    case 'socket.open': {
      const session = views.get(input.view)?.session
      if (!session) throw new Error('Preview is closed.')
      const key = `${input.view}:${input.socket}`
      if (sockets.has(key)) throw new Error('Socket already open.')
      const socket = new WebSocket(`ws://127.0.0.1:${session.dataPort}`)
      socket.binaryType = 'arraybuffer'
      sockets.set(key, socket)
      socket.addEventListener('open', () => emit({ event: 'socket.open', view: input.view, socket: input.socket }))
      socket.addEventListener('message', ({ data }) => {
        const binary = data instanceof ArrayBuffer
        const content = binary ? Buffer.from(data).toString('base64') : String(data)
        const chunkSize = 180000
        for (let offset = 0; offset < content.length || offset === 0; offset += chunkSize) {
          emit({ event: 'socket.data', view: input.view, socket: input.socket, binary, part: content.slice(offset, offset + chunkSize), end: offset + chunkSize >= content.length })
        }
      })
      socket.addEventListener('close', () => { sockets.delete(key); emit({ event: 'socket.close', view: input.view, socket: input.socket }) })
      socket.addEventListener('error', () => emit({ event: 'error', view: input.view, message: 'Tinymist preview connection failed.' }))
      return { ok: true }
    }
    case 'socket.send': {
      const socket = sockets.get(`${input.view}:${input.socket}`)
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Preview socket is closed.')
      socket.send(input.data)
      return { ok: true }
    }
    case 'socket.close': sockets.get(`${input.view}:${input.socket}`)?.close(); return { ok: true }
    case 'update': {
      const session = views.get(input.view)?.session
      if (!session) throw new Error('Preview is closed.')
      if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > MAX_TEXT) throw new Error('The document exceeds the 8 MiB preview limit.')
      session.control.send(JSON.stringify({ event: 'updateMemoryFiles', files: { [session.file]: input.text } }))
      return { ok: true }
    }
    case 'cursor': {
      const session = views.get(input.view)?.session
      if (!session) throw new Error('Preview is closed.')
      session.control.send(JSON.stringify({ event: 'panelScrollTo', filepath: session.file, line: input.line, character: input.character }))
      return { ok: true }
    }
    case 'diagnostics': {
      const session = views.get(input.view)?.session
      return { logs: session?.logs.slice(-5000) || '' }
    }
    default: throw new Error(`Unknown backend method: ${input.method}`)
  }
}

function shutdown() {
  if (stopping) return
  stopping = true
  for (const session of sessions.values()) void stopSession(session)
  setTimeout(() => process.exit(0), 1700).unref()
}

if (typeof WebSocket === 'undefined') throw new Error('Typst Preview requires Node.js 22 or newer on the compilation host.')
if (wireNonce && process.stdin.isTTY) process.stdin.setRawMode(true)
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let wireInput = ''
input.on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (wireNonce) {
    lastContact = Date.now()
    if (message.shutdown) { shutdown(); return }
    if (message.ack) {
      if (message.ack >= awaitingAck) { awaitingAck = 0; pump() }
      return
    }
    if (typeof message.wire !== 'string') return
    wireInput += message.wire
    if (wireInput.length > 16 * 1024 * 1024) { shutdown(); return }
    if (!message.end) return
    try { message = JSON.parse(gunzipSync(Buffer.from(wireInput, 'base64'), { maxOutputLength: 16 * 1024 * 1024 }).toString('utf8')) } catch { shutdown(); return }
    wireInput = ''
  }
  Promise.resolve().then(() => handle(message)).then(
    (result) => emit({ id: message.id, result }),
    (error) => emit({ id: message.id, error: error.message })
  )
})
input.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)
process.stdout.on('error', shutdown)
setInterval(() => { if (Date.now() - lastContact > 60000) shutdown() }, 10000).unref()
emit({ event: 'ready' })
