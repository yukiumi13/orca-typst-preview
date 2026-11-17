/** Read the owning desktop's current workspace identity without changing its profile. */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)

function isActiveFile(entry, active, workspaceId) {
  if (!entry || typeof entry.filePath !== 'string') return false
  const ownedId = `editor:${encodeURIComponent(workspaceId)}:${encodeURIComponent(entry.runtimeEnvironmentId || 'local')}:${encodeURIComponent(entry.filePath)}`
  return (!entry.worktreeId || entry.worktreeId === workspaceId) && (entry.filePath === active || ownedId === active)
}

function activeFile(session, id, hostId) {
  const scoped = `${hostId}|${id}`
  const active = session?.activeFileIdByWorktree?.[scoped] ?? session?.activeFileIdByWorktree?.[id]
  const type = session?.activeTabTypeByWorktree?.[scoped] ?? session?.activeTabTypeByWorktree?.[id]
  const files = session?.openFilesByWorktree?.[scoped] ?? session?.openFilesByWorktree?.[id] ?? []
  return type === 'editor' ? files.find((entry) => isActiveFile(entry, active, id)) : null
}

function fileHost(file) {
  if (file?.runtimeEnvironmentId) return `runtime:${encodeURIComponent(file.runtimeEnvironmentId)}`
  if (file?.externalSshTargetId) return `ssh:${encodeURIComponent(file.externalSshTargetId)}`
  return file?.runtimeEnvironmentId === null ? 'local' : null
}

export function sessionSelection(session, partitions = {}) {
  if (!session || typeof session !== 'object') return null
  const key = session.activeWorkspaceKey
  const id = typeof key === 'string' && key.startsWith('worktree:') ? key.slice(9)
    : typeof key === 'string' && key.startsWith('folder:') ? key : session.activeWorktreeId
  let hostId = session.activeWorkspaceExecutionHostId
  if (typeof id !== 'string' || !id) return null
  let file
  if (typeof hostId !== 'string' || !hostId) {
    // 1.4.247 can leave the global host stamp null while remote file metadata
    // lives in a separate locally persisted host partition. Inspect only the
    // globally selected workspace id; partition-local focus is not authoritative.
    const owners = new Map()
    const legacy = activeFile(session, id, null)
    if (fileHost(legacy)) owners.set(fileHost(legacy), legacy)
    for (const [owner, state] of Object.entries(partitions || {})) {
      const entry = activeFile(state, id, owner)
      if (entry && fileHost(entry) === owner) owners.set(owner, entry)
    }
    if (owners.size !== 1) return null
    ;[hostId, file] = owners.entries().next().value
    if (hostId === 'local') hostId = null
  } else {
    // Never mix a remote partition's file rows with a local namesake.
    file = activeFile(partitions?.[hostId] ?? session, id, hostId)
  }
  // A tab's own remote owner, when present, must agree with the captured workspace.
  const environment = hostId?.startsWith('runtime:') ? decodeURIComponent(hostId.slice(8)) : null
  const sameHost = file && fileHost(file) === (hostId || 'local')
  return { id, hostId, environment, file: sameHost && /\.typ$/i.test(file.filePath) ? file.filePath : null }
}

/** Older public APIs omit remote workspace ids. Use Orca's own read-only domain reader. */
export function readDesktopSelection(cli) {
  const profile = cli?.env?.ORCA_USER_DATA_PATH
  const entry = cli?.prefix?.[0]
  if (!profile || !entry) return null
  const helpers = path.resolve(path.dirname(entry), '../main/persistence/profile-state')
  const { getActiveProfileStateLocation } = require(path.join(helpers, 'profile-state-active-location.js'))
  const location = getActiveProfileStateLocation(profile)
  if (!location) return null
  let session
  let partitions
  if (existsSync(location.databaseFile)) {
    const { readProfileStateDomains } = require(path.join(helpers, 'profile-state-domain-reader.js'))
    const result = readProfileStateDomains(location.databaseFile, location.profileId, ['workspaceSession', 'workspaceSessionsByHostId'])
    if (result.kind === 'unreadable') throw result.error
    session = result.values.get('workspaceSession')
    partitions = result.values.get('workspaceSessionsByHostId')
  } else if (existsSync(location.dataFile)) {
    const state = JSON.parse(readFileSync(location.dataFile, 'utf8'))
    session = state.workspaceSession
    partitions = state.workspaceSessionsByHostId
  }
  return sessionSelection(session, partitions)
}
