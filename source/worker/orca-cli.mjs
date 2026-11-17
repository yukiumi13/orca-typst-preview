/** Invoke this desktop's CLI against its own profile and saved environments. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

export class OrcaCli {
  constructor(program, prefix = [], env = process.env) {
    this.program = program
    this.prefix = prefix
    this.env = env
  }
  call(args, environment) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.program, [...this.prefix, ...args, ...(environment ? ['--environment', environment] : []), '--json'], { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''; let stderr = ''; let failed = false
      const fail = (error) => { if (!failed) { failed = true; clearTimeout(timer); child.kill(); reject(error) } }
      const timer = setTimeout(() => fail(new Error(`Orca timed out (${args[0]} ${args[1]}).`)), 30000)
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
        if (stdout.length > 12 * 1024 * 1024) fail(new Error('Orca reply exceeds the preview transport limit.'))
      })
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000) })
      child.on('error', fail)
      child.on('close', () => {
        clearTimeout(timer)
        if (failed) return
        try {
          const result = JSON.parse(stdout)
          if (!result.ok) throw Object.assign(new Error(result.error?.message || 'Orca request failed.'), { code: result.error?.code })
          resolve(result.result)
        } catch (error) { reject(new Error(`${error.message}${stderr ? ` ${stderr}` : ''}`)) }
      })
    })
  }
}

/** Installed plugin paths establish the profile without guessing a different running Orca. */
export function findOrcaCli(moduleUrl = import.meta.url) {
  // Installed releases live at plugins/<key>/<content-hash>/, while some
  // hosts use plugins/<key>/. Resolve the owning profile from its registry.
  let directory = path.dirname(fileURLToPath(moduleUrl))
  let profile = null
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'plugins' && existsSync(path.join(directory, 'plugins.lock.json'))) {
      profile = path.dirname(directory)
      break
    }
    directory = path.dirname(directory)
  }
  const entry = process.argv[1]
  if (profile && entry) {
    for (const candidate of [entry.replace('app.asar/', 'app.asar.unpacked/'), entry]) {
      const cli = path.resolve(path.dirname(candidate), '../cli/index.js')
      if (existsSync(cli)) return new OrcaCli(process.execPath, [cli], { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_USER_DATA_PATH: profile })
    }
  }
  // Managed shells and integration fixtures can explicitly name their own CLI.
  if (process.env.ORCA_CLI_COMMAND && existsSync(process.env.ORCA_CLI_COMMAND)) return new OrcaCli(process.env.ORCA_CLI_COMMAND)
  return null
}

export function cliTerminalAdapter(cli, workspace) {
  const environment = workspace.environment
  const selector = workspace.selector || (workspace.id.startsWith('identity:') ? workspace.id : `id:${workspace.id}`)
  return {
    inputLimit: 24000,
    async create(command) { return (await cli.call(['terminal', 'create', '--worktree', selector, '--title', 'Typst Preview', '--command', command], environment)).terminal.handle },
    async send(id, text) { await cli.call(['terminal', 'send', '--terminal', id, '--text', text + '\n'], environment) },
    async read(id) {
      const terminal = (await cli.call(['terminal', 'read', '--terminal', id, '--limit', '1000'], environment)).terminal
      if (terminal.status === 'exited') throw new Error('The Typst Preview background terminal exited.')
      return terminal.tail
    },
    async close(id) { await cli.call(['terminal', 'close', '--terminal', id], environment) }
  }
}

/** Reuse the owning app's authenticated client instead of spawning a CLI per frame. */
export function nativeTerminalAdapter(cli, workspace) {
  const entry = cli.prefix[0]
  const profile = cli.env.ORCA_USER_DATA_PATH
  // Explicit external CLI wrappers have no version-matched app modules to load.
  if (!entry || !profile) return cliTerminalAdapter(cli, workspace)
  const modulePath = path.join(path.dirname(entry), 'runtime/client.js')
  let RuntimeClient
  try { ({ RuntimeClient } = createRequire(import.meta.url)(modulePath)) }
  catch { return cliTerminalAdapter(cli, workspace) }
  if (typeof RuntimeClient !== 'function') return cliTerminalAdapter(cli, workspace)
  // Resolve only the captured environment, never an ambient pairing code. Once
  // connected, propagate failures rather than retrying mutations through the CLI.
  const client = new RuntimeClient(profile, 30000, null, workspace.environment ?? null, cli.program)
  if (workspace.environment && !client.isRemote) throw new Error('Orca did not resolve the compilation host.')
  const selector = workspace.selector || (workspace.id.startsWith('identity:') ? workspace.id : `id:${workspace.id}`)
  const call = async (method, params) => (await client.call(method, params)).result
  console.log('Typst Preview transport: app runtime client')
  return {
    inputLimit: 24000,
    async create(command) {
      return (await call('terminal.create', { worktree: selector, title: 'Typst Preview', command, focus: false })).terminal.handle
    },
    async send(id, text) {
      // This is raw input for our Node bridge, not an agent prompt. A newline
      // avoids the prompt-submission preflight performed by CLI --enter.
      const { send } = await call('terminal.send', { terminal: id, text: text + '\n', enter: false, interrupt: false, client: { id: 'typst-preview', type: 'desktop' } })
      if (!send.accepted) throw new Error('Orca did not accept preview transport input.')
    },
    async read(id) {
      const { terminal } = await call('terminal.read', { terminal: id, limit: 1000 })
      if (terminal.status === 'exited') throw new Error('The Typst Preview background terminal exited.')
      return terminal.tail
    },
    async close(id) {
      const { close } = await call('terminal.close', { terminal: id })
      if (!close.ptyKilled && close.ptyStopVerdict !== undefined) throw new Error('Orca could not confirm the preview terminal stopped.')
    }
  }
}
