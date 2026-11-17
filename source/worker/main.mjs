/** Bind editor views to workspaces, route compilation, and bound preview traffic. */
import { randomUUID } from 'node:crypto'
import { startBackend } from './client.mjs'
import { findOrcaCli } from './orca-cli.mjs'
import { captureWorkspace, listWorkspaces, workspaceForPath } from './workspace.mjs'

let dispose = async () => {}
export default function activate(orca) {
  const cli = findOrcaCli()
  const bindings = new Map()
  const connections = new Map()
  const views = new Map()
  const workspaceChoices = new Map()
  const openingPanels = new Map()
  const disposables = []
  let disposed = false

  const describe = (workspace) => workspace && ({ id: workspace.id, name: workspace.name, path: workspace.path, host: workspace.hostName || workspace.hostId || 'local' })
  async function binding(context) {
    let result = bindings.get(context.panel.id)
    if (!result) {
      result = captureWorkspace(orca, cli)
      bindings.set(context.panel.id, result)
      const forget = () => { if (bindings.get(context.panel.id) === result) bindings.delete(context.panel.id) }
      result.then((current) => {
        if (!current.workspace) { forget(); return }
        orca.log?.('Typst Preview workspace: ' + JSON.stringify({ source: current.source, id: current.workspace.id, host: current.workspace.hostId, file: current.file ?? null }))
      }, forget)
    }
    return result
  }
  async function bound(context) {
    const current = await binding(context)
    if (!current.workspace) throw new Error(current.problem || 'Cannot identify this editor’s workspace. Retry Preview from the document tab.')
    return current.workspace
  }
  function enqueue(view, event) {
    if (!view) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (view.bytes + bytes > 16 * 1024 * 1024) {
      view.queue = [{ event: 'error', message: 'Preview fell behind. Close and reopen Preview to reconnect.' }]
      view.bytes = 0
      void close(view.id)
    } else { view.queue.push(event); view.bytes += bytes }
    view.wake?.()
  }
  async function release(holder) {
    if ([...views.values()].some((view) => view.holder === holder) || holder.opening) return
    clearTimeout(holder.idle)
    if (connections.get(holder.key) === holder) connections.delete(holder.key)
    await holder.ready.then((connection) => connection.close()).catch(() => {})
  }
  async function backend(workspace) {
    const options = await orca.settings.get()
    const key = `${workspace.environment || workspace.hostId || 'local'}:${workspace.id}:${JSON.stringify(options)}`
    let holder = connections.get(key)
    if (!holder) {
      holder = { key, workspace, options, opening: 0, idle: null, ready: null }
      connections.set(key, holder)
      holder.ready = startBackend(options, { workspace, cli }).then(async (connection) => {
        if (disposed) { await connection.close(); throw new Error('Plugin was disabled.') }
        connection.on('event', (event) => enqueue(views.get(event.view), event))
        connection.on('closed', (message) => {
          if (connections.get(key) === holder) connections.delete(key)
          for (const view of views.values()) if (view.holder === holder) enqueue(view, { event: 'error', message })
        })
        await connection.call({ method: 'ping' })
        return connection
      }).catch((error) => { if (connections.get(key) === holder) connections.delete(key); throw error })
    }
    clearTimeout(holder.idle)
    holder.idle = setTimeout(() => void release(holder), 60000)
    holder.idle.unref()
    return holder
  }
  async function close(id) {
    const view = views.get(id)
    if (!view) return
    views.delete(id)
    clearTimeout(view.release)
    view.wake?.()
    await view.holder.ready.then((connection) => connection.call({ method: 'close', view: id })).catch(() => {})
    await release(view.holder)
  }
  function own(input, context) {
    const view = views.get(input?.view)
    if (!view || view.panel !== context.panel.id) throw new Error('This preview is closed. Open Preview again.')
    view.touched = Date.now()
    clearTimeout(view.release)
    return view
  }
  function handler(name, fn) {
    disposables.push(orca.panels.handle(name, (input, context) => {
      // Public caller ids can be shared by all instances of an editor. Keep
      // direct diagnostic callers in their legacy scope; the UI always sends
      // its own nonce, including for polling, closing and workspace changes.
      const frame = input?.frame
      if (frame !== undefined && (typeof frame !== 'string' || !/^[a-f0-9-]{36}$/.test(frame))) throw new Error('Invalid preview frame identity.')
      return fn(input, frame === undefined ? context : { ...context, panel: { ...context.panel, id: `${context.panel.id}:${frame}` } })
    }))
  }

  handler('preview.workspace', async (_input, context) => {
    const current = await binding(context)
    return { workspace: describe(current.workspace), file: current.file ?? null, problem: current.problem ?? null }
  })
  handler('preview.workspaces', async (_input, context) => {
    const current = await bound(context)
    const result = await listWorkspaces(orca, cli, current)
    workspaceChoices.set(context.panel.id, result.workspaces)
    return { workspaces: result.workspaces.map(describe), truncated: result.truncated }
  })
  handler('preview.selectWorkspace', async (input, context) => {
    if (openingPanels.has(context.panel.id) || [...views.values()].some(view => view.panel === context.panel.id)) throw new Error('Close this preview before changing its workspace.')
    const workspace = workspaceChoices.get(context.panel.id)?.find(row => row.id === input?.id)
    if (!workspace) throw new Error('Choose a workspace from the current list.')
    const previous = await bound(context)
    bindings.set(context.panel.id, Promise.resolve({ workspace, file: null, source: 'selected' }))
    workspaceChoices.delete(context.panel.id)
    for (const holder of connections.values()) if (holder.workspace.id === previous.id && holder.workspace.hostId === previous.hostId) await release(holder)
    return { workspace: describe(workspace), file: null, problem: null }
  })
  handler('preview.discover', async (input, context) => {
    if (!/^[a-f0-9]{64}$/.test(input?.hash)) throw new Error('Invalid document fingerprint.')
    const workspace = await bound(context)
    const { file } = await binding(context)
    const started = performance.now()
    const holder = await backend(workspace)
    const connection = await holder.ready
    const ready = performance.now()
    const result = await connection.call({ method: 'discover', roots: [workspace.path], hash: input.hash, preferredPath: file ?? null })
    orca.log?.('Typst Preview discovery: ' + JSON.stringify({ source: result.source, backendMs: Math.round(ready - started), lookupMs: Math.round(performance.now() - ready), files: result.files.length }))
    return result
  })
  handler('preview.files', async (_input, context) => {
    const workspace = await bound(context)
    const started = performance.now()
    const holder = await backend(workspace)
    const connection = await holder.ready
    const ready = performance.now()
    const result = await connection.call({ method: 'files', roots: [workspace.path] })
    orca.log?.('Typst Preview files: ' + JSON.stringify({ backendMs: Math.round(ready - started), lookupMs: Math.round(performance.now() - ready), files: result.files.length }))
    return result
  })
  async function open(input, context, pasted = false) {
    if (openingPanels.has(context.panel.id)) throw new Error('This preview is already opening.')
    if ([...views.values()].some(view => view.panel === context.panel.id)) throw new Error('Close this preview before changing its file.')
    const opening = new AbortController()
    openingPanels.set(context.panel.id, opening)
    try {
      const previous = await bound(context)
      const { workspace, file } = pasted
        ? workspaceForPath(input?.path, (await listWorkspaces(orca, cli, previous)).workspaces, previous.id)
        : { workspace: previous, file: input.path }
      if (opening.signal.aborted || context.signal.aborted || disposed) throw new Error('Preview was closed during startup.')
      const holder = await backend(workspace)
      if (opening.signal.aborted || context.signal.aborted || disposed) { await release(holder); throw new Error('Preview was closed during startup.') }
      holder.opening++
      const id = randomUUID()
      const view = { id, holder, panel: context.panel.id, queue: [], bytes: 0, touched: Date.now(), wake: null, release: null, upload: null }
      views.set(id, view)
      try {
        const result = await (await holder.ready).call({ ...holder.options, method: 'open', path: file, roots: [workspace.path], view: id })
        if (opening.signal.aborted || context.signal.aborted || disposed || !views.has(id)) { await close(id); throw new Error('Preview was closed during startup.') }
        if (pasted) {
          bindings.set(context.panel.id, Promise.resolve({ workspace, file: result.path, source: 'pasted-path' }))
          workspaceChoices.delete(context.panel.id)
          for (const previousHolder of connections.values()) if (previousHolder !== holder && previousHolder.workspace.id === previous.id && previousHolder.workspace.hostId === previous.hostId) await release(previousHolder)
        }
        return { view: id, workspace: describe(workspace), ...result }
      } catch (error) { await close(id); throw error }
      finally { holder.opening--; if (!views.has(id)) await release(holder) }
    } finally { openingPanels.delete(context.panel.id) }
  }
  handler('preview.open', (input, context) => open(input, context))
  handler('preview.openPath', (input, context) => open(input, context, true))
  handler('preview.poll', async (input, context) => {
    const view = own(input, context)
    if (view.wake) throw new Error('A preview poll is already pending.')
    if (!view.queue.length) await new Promise((resolve) => {
      let timer
      const finish = () => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); view.wake = null; resolve() }
      const abort = () => {
        view.release = setTimeout(() => { void close(view.id); bindings.delete(view.panel) }, 3000)
        finish()
      }
      view.wake = finish
      timer = setTimeout(finish, 15000)
      context.signal.addEventListener('abort', abort, { once: true })
      if (context.signal.aborted) abort()
    })
    const events = []
    let bytes = 0
    while (view.queue.length) {
      const size = Buffer.byteLength(JSON.stringify(view.queue[0]))
      if (bytes + size > 700000) break
      events.push(view.queue.shift()); bytes += size
    }
    view.bytes = Math.max(0, view.bytes - bytes)
    return { events }
  })
  handler('preview.send', async (input, context) => {
    const view = own(input, context)
    if (!['socket.open', 'socket.send', 'socket.close', 'cursor', 'diagnostics'].includes(input.method)) throw new Error('Unsupported preview operation.')
    return (await view.holder.ready).call({ ...input, view: view.id })
  })
  handler('preview.upload', async (input, context) => {
    const view = own(input, context)
    if (typeof input.part !== 'string' || input.part.length > 12000) throw new Error('Invalid document chunk.')
    if (input.index === 0) view.upload = { id: input.upload, next: 0, parts: [], length: 0 }
    const upload = view.upload
    if (!upload || upload.id !== input.upload || upload.next !== input.index) throw new Error('Document chunks arrived out of order.')
    upload.parts.push(input.part); upload.next++; upload.length += Buffer.byteLength(input.part)
    if (upload.length > 8 * 1024 * 1024) { view.upload = null; throw new Error('Document exceeds the 8 MiB preview limit.') }
    if (input.end) {
      view.upload = null
      await (await view.holder.ready).call({ method: 'update', view: view.id, text: upload.parts.join('') })
    }
    return { ok: true }
  })
  handler('preview.close', async (input, context) => { const view = own(input, context); await close(view.id); return { ok: true } })
  handler('preview.detach', async (_input, context) => {
    openingPanels.get(context.panel.id)?.abort()
    bindings.delete(context.panel.id)
    workspaceChoices.delete(context.panel.id)
    await Promise.allSettled([...views.values()].filter(view => view.panel === context.panel.id).map(view => close(view.id)))
    return { ok: true }
  })
  if (orca.settings.onDidChange) disposables.push(orca.settings.onDidChange(() => {
    for (const view of views.values()) enqueue(view, { event: 'error', message: 'Preview settings changed. Close and reopen Preview to reconnect.' })
    for (const holder of connections.values()) { clearTimeout(holder.idle); holder.ready.then((connection) => connection.close()).catch(() => {}) }
    connections.clear()
  }))
  const sweep = setInterval(() => {
    for (const view of views.values()) if (Date.now() - view.touched > 60000 && !view.wake) void close(view.id)
  }, 10000)
  sweep.unref()
  dispose = async () => {
    disposed = true
    clearInterval(sweep)
    for (const view of views.values()) { clearTimeout(view.release); view.wake?.() }
    views.clear(); bindings.clear(); workspaceChoices.clear(); openingPanels.clear()
    for (const item of disposables) item.dispose()
    await Promise.allSettled([...connections.values()].map((holder) => { clearTimeout(holder.idle); return holder.ready.then((connection) => connection.close()) }))
    connections.clear()
  }
}
export function deactivate() { return dispose() }
