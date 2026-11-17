/** One JSON connection per workspace, local or routed through Orca's own runtime. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import { startTerminalTransport } from './native-transport.mjs'
import { nativeTerminalAdapter } from './orca-cli.mjs'

export { shellQuote } from './native-transport.mjs'

export class Backend extends EventEmitter {
  constructor() {
    super()
    this.pending = new Map()
    this.nextId = 0
    this.closed = false
  }
  receive(message) {
    if (message.event) this.emit('event', message)
    else {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      clearTimeout(request.timer)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    }
  }
  fail(error) {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    const message = error instanceof Error ? error.message : String(error)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)) }
    this.pending.clear()
    this.emit('closed', message)
  }
  attach(transport) {
    this.transport = transport
    this.heartbeat = setInterval(() => this.call({ method: 'ping' }).catch(() => this.close()), 10000)
    this.heartbeat.unref()
  }
  call(input) {
    if (this.closed) return Promise.reject(new Error('Compilation host is disconnected.'))
    return new Promise((resolve, reject) => {
      const id = ++this.nextId
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Compilation host timed out (${input.method}).`)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      Promise.resolve(this.transport.write({ ...input, id })).catch((error) => this.fail(error))
    })
  }
  close() {
    this.closing ??= (async () => {
      clearInterval(this.heartbeat)
      try { await this.transport?.close() }
      finally { this.fail('Preview connection closed.') }
    })()
    return this.closing
  }
}

export async function startBackend(settings = {}, { workspace, cli, adapter } = {}) {
  const connection = new Backend()
  if (adapter || (workspace?.hostId && workspace.hostId !== 'local')) {
    if (!adapter && !cli) throw new Error('Install the plugin folder in Orca so it can use this profile’s saved host connections.')
    adapter ??= nativeTerminalAdapter(cli, workspace)
    const transport = await startTerminalTransport(adapter, settings, (packet) => connection.receive(packet), (error) => connection.fail(error))
    connection.attach(transport)
    return connection
  }
  const file = fileURLToPath(new URL('./backend.mjs', import.meta.url))
  const child = spawn(process.execPath, [file], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  let stderr = ''
  createInterface({ input: child.stdout }).on('line', (line) => { try { connection.receive(JSON.parse(line)) } catch (error) { connection.fail(error) } })
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-3000) })
  child.on('error', (error) => connection.fail(error))
  child.on('exit', (code) => connection.fail(`Compilation host disconnected (${code}). ${stderr}`))
  child.stdin.on('error', (error) => connection.fail(error))
  connection.attach({
    write: (message) => { child.stdin.write(`${JSON.stringify(message)}\n`) },
    close: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return }
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGTERM'), 2500)
      timer.unref()
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  })
  return connection
}
