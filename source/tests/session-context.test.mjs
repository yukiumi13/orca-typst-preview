import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionSelection } from '../worker/session-context.mjs'
import { captureWorkspace } from '../worker/workspace.mjs'

test('desktop selection uses the scoped workspace key, host and active file', () => {
  const id = 'repo::/remote/v4'
  const host = 'runtime:server'
  const session = {
    activeWorkspaceKey: `worktree:${id}`, activeWorktreeId: 'stale-local', activeWorkspaceExecutionHostId: host,
    activeFileIdByWorktree: { [`${host}|${id}`]: '/remote/v4/note.typ' },
    activeTabTypeByWorktree: { [`${host}|${id}`]: 'editor' },
    openFilesByWorktree: { [`${host}|${id}`]: [{ filePath: '/remote/v4/note.typ', worktreeId: id, runtimeEnvironmentId: 'server' }] }
  }
  assert.deepEqual(sessionSelection(session), { id, hostId: host, environment: 'server', file: '/remote/v4/note.typ' })
  session.activeFileIdByWorktree[`${host}|${id}`] = `editor:${encodeURIComponent(id)}:server:${encodeURIComponent('/remote/v4/note.typ')}`
  assert.equal(sessionSelection(session).file, '/remote/v4/note.typ', 'host-qualified editor file ids resolve to their owned path')
  session.openFilesByWorktree[`${host}|${id}`][0].runtimeEnvironmentId = 'another-server'
  assert.equal(sessionSelection(session).file, null, 'a different host cannot lend its file path')
  assert.equal(sessionSelection({ activeWorktreeId: id }), null, 'an unscoped id cannot identify a host')
  assert.equal(sessionSelection({ activeWorkspaceKey: 'folder:abc', activeWorkspaceExecutionHostId: 'local', activeTabTypeByWorktree: { 'folder:abc': 'editor' } }).id, 'folder:abc')
  session.activeTabTypeByWorktree[`${host}|${id}`] = 'terminal'
  assert.equal(sessionSelection(session).file, null, 'a terminal selection cannot lend a stale file hint')
})

test('captured desktop identity resolves a remote workspace without listing or choosing names', async () => {
  let selection = { id: 'remote-a', hostId: 'runtime:server-a', environment: 'server-a', file: '/remote/a/note.typ' }
  const calls = []
  const orca = { host: { call: async (method) => {
    assert.equal(method, 'workspace.readContext')
    // Focus changes while an old Orca version is answering without a workspace id.
    selection = { id: 'remote-b', hostId: 'runtime:server-b', environment: 'server-b', file: '/remote/b/note.typ' }
    return null
  } } }
  const cli = { call: async (args, environment) => {
    calls.push([args, environment])
    return { worktree: { id: 'remote-a', path: '/remote/a', displayName: 'v4', branch: 'main', hostId: 'local' } }
  } }
  const result = await captureWorkspace(orca, cli, () => selection)
  assert.deepEqual(calls, [[['worktree', 'show', '--worktree', 'id:remote-a'], 'server-a']])
  assert.equal(result.workspace.environment, 'server-a')
  assert.equal(result.file, '/remote/a/note.typ')
  assert.equal(result.source, 'desktop-session')
})

test('desktop identity cannot silently bind a twin on a different host', async () => {
  const orca = { host: { call: async () => null } }
  const cli = { call: async () => ({ worktree: { id: 'same', path: '/v4', hostId: 'local' } }) }
  await assert.rejects(captureWorkspace(orca, cli, () => ({ id: 'same', hostId: 'ssh:remote', environment: null })), /another host/)
})

test('Orca 1.4.247 null host stamps use the active file owner, then exact-id lookup', async () => {
  const id = 'repo::/notes'
  const file = { worktreeId: id, filePath: '/notes/note.typ', runtimeEnvironmentId: null }
  const session = { activeWorkspaceKey: `worktree:${id}`, activeWorkspaceExecutionHostId: null, activeTabTypeByWorktree: { [id]: 'editor' }, activeFileIdByWorktree: { [id]: file.filePath }, openFilesByWorktree: { [id]: [file] } }
  assert.deepEqual(sessionSelection(session), { id, hostId: null, environment: null, file: file.filePath })
  file.runtimeEnvironmentId = 'paired-247'
  const selected = sessionSelection(session)
  assert.equal(selected.hostId, 'runtime:paired-247')
  const calls = []
  const captured = await captureWorkspace({ host: { call: async () => null } }, { call: async (args, env) => { calls.push([args, env]); return { worktree: { id, path: '/notes', hostId: 'local' } } } }, () => selected)
  assert.equal(captured.workspace.environment, 'paired-247')
  assert.equal(calls[0][1], 'paired-247')
})

test('partitioned remote files resolve against the global focus even with a null host stamp', () => {
  const id = 'repo::/remote/v4'
  const file = '/remote/v4/note.typ'
  const state = { activeWorkspaceKey: `worktree:${id}`, activeWorktreeId: id, activeWorkspaceExecutionHostId: null }
  const partition = { activeWorktreeId: 'stale-partition-focus', activeTabTypeByWorktree: { [id]: 'editor' }, activeFileIdByWorktree: { [id]: file }, openFilesByWorktree: { [id]: [{ filePath: file, worktreeId: id, runtimeEnvironmentId: 'cm03' }] } }
  const partitions = { 'runtime:cm03': partition, 'runtime:google': { activeWorktreeId: 'other', openFilesByWorktree: {} } }
  assert.equal(sessionSelection(state), null, 'local focus contains no remote file rows')
  assert.deepEqual(sessionSelection(state, partitions), { id, hostId: 'runtime:cm03', environment: 'cm03', file })
  state.activeWorkspaceExecutionHostId = 'runtime:cm03'
  assert.equal(sessionSelection(state, partitions).file, file)
  const twin = structuredClone(partition)
  twin.openFilesByWorktree[id][0].runtimeEnvironmentId = 'google'
  partitions['runtime:google'] = twin
  assert.equal(sessionSelection(state, partitions).environment, 'cm03', 'a stamped host wins over a twin in another partition')
  state.activeWorkspaceExecutionHostId = null
  assert.equal(sessionSelection(state, partitions), null, 'an unstamped id claimed by two hosts stays unresolved')
  delete state.activeWorkspaceKey
  state.activeWorktreeId = null
  assert.equal(sessionSelection(state, partitions), null, 'partition-local focus cannot replace missing global focus')
})
