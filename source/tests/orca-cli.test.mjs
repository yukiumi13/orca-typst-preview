import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
import { findOrcaCli, nativeTerminalAdapter } from '../worker/orca-cli.mjs'

test('installed CLI discovery stays bound to the plugin profile', async () => {
  const root = await mkdtemp('/tmp/typst-cli-profile-')
  const entry = process.argv[1]
  const explicit = process.env.ORCA_CLI_COMMAND
  delete process.env.ORCA_CLI_COMMAND
  try {
    const profile = path.join(root, 'profile')
    const app = path.join(root, 'app/out')
    await mkdir(path.join(profile, 'plugins'), { recursive: true })
    await writeFile(path.join(profile, 'plugins/plugins.lock.json'), '{}')
    await mkdir(path.join(app, 'cli'), { recursive: true })
    await writeFile(path.join(app, 'cli/index.js'), '// fixture')
    process.argv[1] = path.join(app, 'main/plugin-host-entry.js')
    for (const release of ['', 'a'.repeat(64)]) {
      const installed = pathToFileURL(path.join(profile, 'plugins/local.typst-preview', release, 'worker/orca-cli.mjs'))
      const cli = findOrcaCli(installed)
      assert.ok(cli, 'resolve both a flat install and Orca’s content-addressed release directory')
      assert.equal(cli.env.ORCA_USER_DATA_PATH, profile)
      assert.deepEqual(cli.prefix, [path.join(app, 'cli/index.js')])
    }
    assert.equal(findOrcaCli(pathToFileURL(path.join(root, 'dev/worker/orca-cli.mjs'))), null, 'development paths do not guess the personal profile')
  } finally {
    process.argv[1] = entry
    if (explicit === undefined) delete process.env.ORCA_CLI_COMMAND
    else process.env.ORCA_CLI_COMMAND = explicit
    await rm(root, { recursive: true, force: true })
  }
})

test('native terminal RPC uses only the owning profile and captured host, with raw input', async () => {
  const root = await mkdtemp('/tmp/typst-rpc-client-')
  await mkdir(path.join(root, 'runtime'))
  const modulePath = path.join(root, 'runtime/client.js')
  await writeFile(modulePath, `
    exports.instances = [];
    exports.RuntimeClient = class {
      constructor(...args) { this.args = args; this.isRemote = !!args[3]; this.calls = []; exports.instances.push(this); }
      async call(method, params) {
        this.calls.push([method, params]);
        if (this.error) throw this.error;
        return { ok: true, result: {
          terminal: { handle: 'owned-terminal', status: 'running', tail: ['frame'] },
          send: { accepted: !this.refuse }, close: { ptyKilled: true }
        }};
      }
    };
  `)
  try {
    const cli = { prefix: [path.join(root, 'index.js')], env: { ORCA_USER_DATA_PATH: '/own/profile', ORCA_PAIRING_CODE: 'unused-ambient-fixture' }, program: '/own/orca', call: () => assert.fail('RPC failures must not replay through CLI') }
    const adapter = nativeTerminalAdapter(cli, { id: 'worktree', hostId: 'runtime:chosen', environment: 'chosen' })
    const client = createRequire(import.meta.url)(modulePath).instances[0]
    assert.deepEqual(client.args, ['/own/profile', 30000, null, 'chosen', '/own/orca'])
    const id = await adapter.create('node helper')
    await adapter.send(id, '{"ack":8}')
    assert.deepEqual(await adapter.read(id), ['frame'])
    await adapter.close(id)
    assert.deepEqual(client.calls.map(([method]) => method), ['terminal.create', 'terminal.send', 'terminal.read', 'terminal.close'])
    assert.equal(client.calls[0][1].worktree, 'id:worktree')
    assert.equal(client.calls[0][1].focus, false)
    assert.deepEqual(client.calls[1][1], { terminal: id, text: '{"ack":8}\n', enter: false, interrupt: false, client: { id: 'typst-preview', type: 'desktop' } })
    client.refuse = true
    await assert.rejects(adapter.send(id, 'data'), /did not accept/)
    client.error = new Error('selected host offline')
    await assert.rejects(adapter.create('node helper'), /selected host offline/)
    // Orca-managed SSH terminals are routed by the local runtime, without a
    // paired environment. Keep their captured workspace selector intact.
    const ssh = nativeTerminalAdapter(cli, { id: 'ssh-worktree', hostId: 'ssh:chosen' })
    await ssh.create('node helper')
    const sshClient = createRequire(import.meta.url)(modulePath).instances[1]
    assert.equal(sshClient.args[3], null)
    assert.equal(sshClient.calls[0][1].worktree, 'id:ssh-worktree')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('external CLI wrappers keep the fallback, without prompt submission preflight', async () => {
  const calls = []
  const cli = { prefix: [], env: {}, call: async (...args) => { calls.push(args); return { terminal: { handle: 'own', status: 'running', tail: [] } } } }
  const adapter = nativeTerminalAdapter(cli, { id: 'folder', environment: 'selected' })
  await adapter.create('node helper')
  await adapter.send('own', '{"ack":8}')
  await adapter.read('own')
  await adapter.close('own')
  assert.ok(calls.every(([, host]) => host === 'selected'))
  assert.deepEqual(calls[1][0], ['terminal', 'send', '--terminal', 'own', '--text', '{"ack":8}\n'])
})
