import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseWorkspace, captureWorkspace, listWorkspaces, workspaceForPath } from '../worker/workspace.mjs'

test('pasted paths select the nearest listed root and reject relative paths and prefix lookalikes', () => {
  const workspaces = [{ id: 'docs', path: '/docs' }, { id: 'nested', path: '/docs/nested' }]
  assert.equal(workspaceForPath('  "/docs/nested/my note.typ"\n', workspaces, 'docs').workspace.id, 'nested')
  assert.equal(workspaceForPath('/docs/nested/../index.typ', workspaces, 'nested').workspace.id, 'docs')
  for (const input of ['/docs-other/note.typ', '/elsewhere/note.typ', 'note.typ', '/docs/note.pdf', '/docs/a.typ\n/docs/b.typ', null]) assert.throws(() => workspaceForPath(input, workspaces, 'docs'))
  const twin = [...workspaces, { id: 'twin', path: '/docs' }]
  assert.throws(() => workspaceForPath('/docs/note.typ', twin, 'nested'), /Several workspaces/)
  assert.equal(workspaceForPath('/docs/note.typ', twin, 'twin').workspace.id, 'twin')
  assert.equal(workspaceForPath('C:\\notes\\my file.typ', [{ id: 'windows', path: 'C:\\notes' }]).workspace.id, 'windows')
})

test('workspace correction lists only the captured host and preserves exact identities', async () => {
  const calls = []
  const current = { id: 'folder:current', path: '/remote/current', hostId: 'runtime:cm03', environment: 'cm03' }
  const cli = { call: async (args, environment) => {
    calls.push([args, environment])
    return { worktrees: [{ id: 'rpc', path: '/remote/rpc', displayName: 'rpc-comm', identity: { key: 'rpc-identity' } }], truncated: false }
  } }
  const result = await listWorkspaces({}, cli, current)
  assert.deepEqual(calls, [[['worktree', 'list', '--limit', '10000'], 'cm03']])
  assert.deepEqual(result.workspaces.map(row => row.id), ['folder:current', 'rpc'])
  assert.equal(result.workspaces[1].selector, 'identity:rpc-identity')
  assert.equal(result.workspaces[1].environment, 'cm03')
  const local = await listWorkspaces({ host: { call: async () => ({ workspaces: [{ id: 'a', name: 'local', path: '/a', hostId: 'local' }, { id: 'other', name: 'other', path: '/other', hostId: 'runtime:unrelated' }] }) } }, null, { id: 'a', path: '/a', hostId: 'local' })
  assert.deepEqual(local.workspaces.map(row => row.id), ['a'])
})

test('public workspace fallback requires an exact id, never a name/branch guess', () => {
  const a = { id: 'a', name: 'notes', branch: 'main' }
  const b = { id: 'b', name: 'notes', branch: 'main' }
  assert.equal(chooseWorkspace({ workspaceId: 'a' }, [a, b]), a)
  assert.equal(chooseWorkspace({ displayName: 'notes', branch: 'refs/heads/main' }, [a]), null)
  assert.equal(chooseWorkspace({ displayName: 'notes', branch: 'main' }, [a, b]), null)
  assert.equal(chooseWorkspace({ workspaceId: 'missing', displayName: 'notes', branch: 'main' }, [a]), null)
})

test('a captured paired workspace never enumerates unrelated saved environments', async () => {
  const calls = []
  const orca = { host: { call: async () => null } }
  const cli = { call: async (args, environment) => {
    calls.push([args, environment])
    if (environment !== 'paired' || args[0] !== 'worktree' || args[1] !== 'show') throw new Error('google: Could not connect to the remote Orca runtime')
    return { worktree: { id: 'raw', identity: { key: 'remote-key' }, displayName: 'v4', branch: 'main', path: '/remote/v4' } }
  } }
  const result = await captureWorkspace(orca, cli, () => ({ id: 'raw', hostId: 'runtime:paired', environment: 'paired', file: '/remote/v4/note.typ' }))
  assert.equal(result.workspace.environment, 'paired')
  assert.equal(result.workspace.path, '/remote/v4')
  assert.equal(result.workspace.selector, 'identity:remote-key')
  assert.deepEqual(calls, [[['worktree', 'show', '--worktree', 'id:raw'], 'paired']])
})

test('missing desktop identity never contacts other hosts or guesses a local namesake', async () => {
  const orca = { host: { call: async (name) => name === 'workspace.readContext' ? { displayName: 'v4', branch: 'main' } : { workspaces: [{ id: 'local', name: 'v4', branch: 'main', path: '/local/v4', hostId: 'local' }] } } }
  const calls = []
  const cli = { call: async (args) => { calls.push(args); throw new Error('google: Could not connect to the remote Orca runtime') } }
  const result = await captureWorkspace(orca, cli, () => null)
  assert.equal(result.workspace, null)
  assert.deepEqual(calls, [], 'even the environment list is unnecessary without a selected host')
  assert.match(result.problem, /desktop session/)
  assert.doesNotMatch(result.problem, /google/)
})

test('empty discovery reports the actual desktop-reader failure', async () => {
  const orca = { host: { call: async (name) => name === 'workspace.readContext' ? { workspaceId: 'remote', displayName: 'v4' } : { workspaces: [] } } }
  assert.match((await captureWorkspace(orca, null)).problem, /CLI is unavailable/)
  assert.match((await captureWorkspace(orca, {}, () => { throw new Error('profile unavailable') })).problem, /Cannot read the desktop's current workspace identity: profile unavailable/)
})
