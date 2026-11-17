/** Resolve a captured Orca context without searching unrelated worktrees for document text. */
import { readDesktopSelection } from './session-context.mjs'
import path from 'node:path'
const shortBranch = (branch) => String(branch || '').replace(/^refs\/heads\//, '')

/** Resolve a pasted host path against its listed workspaces, not the worker OS. */
export function workspaceForPath(input, workspaces, currentId) {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Paste one complete .typ file path.')
  let file = input.trim()
  if (/[\x00-\x1f\x7f]/.test(file)) throw new Error('Paste one complete .typ file path.')
  if ((file.startsWith('"') && file.endsWith('"')) || (file.startsWith("'") && file.endsWith("'"))) file = file.slice(1, -1)
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(file) ? path.win32 : path.posix
  if (!paths.isAbsolute(file) || !/\.typ$/i.test(file)) throw new Error('Paste the absolute path of the .typ file shown at the top of this tab.')
  file = paths.normalize(file)
  const matches = workspaces.filter(workspace => {
    const relative = paths.relative(workspace.path, file)
    return relative !== '' && relative !== '..' && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative)
  }).sort((a, b) => b.path.length - a.path.length)
  if (!matches.length) throw new Error('This path is not inside a listed workspace on this host. Choose its workspace first, then paste again.')
  const closest = matches.filter(workspace => workspace.path.length === matches[0].path.length)
  const workspace = closest.find(workspace => workspace.id === currentId) || (closest.length === 1 ? closest[0] : null)
  if (!workspace) throw new Error('Several workspaces own this directory. Choose the intended workspace first.')
  return { workspace, file }
}

export function chooseWorkspace(context, workspaces) {
  if (!context?.workspaceId) return null
  const found = workspaces.filter((workspace) => workspace.id === context.workspaceId || workspace.aliases?.includes(context.workspaceId))
  return found.length === 1 ? found[0] : null
}

/** Offer workspace corrections only on the already captured execution host. */
export async function listWorkspaces(orca, cli, current) {
  const listed = cli
    ? await cli.call(['worktree', 'list', '--limit', '10000'], current.environment)
    : await orca.host.call('workspace.list', {})
  const rows = cli ? listed.worktrees : listed.workspaces
  const workspaces = rows.filter(row => row.path && row.id &&
    (cli && current.environment || (row.hostId || 'local') === (current.hostId || 'local')))
    .map(row => ({ id: row.id, name: row.displayName || row.name || row.path.split(/[\\/]/).pop(), path: row.path,
      hostId: current.hostId || 'local', ...(current.environment ? { environment: current.environment } : {}),
      selector: row.identity?.key ? `identity:${row.identity.key}` : `id:${row.id}` }))
  // Native folders are not enumerated by some CLI versions. Keep the known root.
  if (!workspaces.some(row => row.id === current.id)) workspaces.push(current)
  workspaces.sort((a, b) => a.path.localeCompare(b.path))
  return { workspaces, truncated: !!listed.truncated }
}

export async function captureWorkspace(orca, cli, readSelection = readDesktopSelection) {
  // Capture before any remote lookup: later focus changes must not retarget this view.
  let selection = null
  let selectionError = null
  try { selection = readSelection(cli) } catch (error) { selectionError = error.message }
  let context = null
  try { context = await orca.host.call('workspace.readContext', {}) }
  catch (error) { if (!selection) throw error }
  // A newly opened desktop profile may not have persisted a workspace identity yet.
  if (!selection && !selectionError && cli?.env?.ORCA_USER_DATA_PATH && cli?.prefix?.[0]) {
    const deadline = Date.now() + 1500
    while (!selection && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      try { selection = readSelection(cli) } catch (error) { selectionError = error.message; break }
    }
  }
  if (selection && cli) {
    const selector = selection.id.startsWith('identity:') ? selection.id : `id:${selection.id}`
    const result = await cli.call(['worktree', 'show', '--worktree', selector], selection.environment)
    const row = result.worktree
    const identity = row?.identity?.key ? `identity:${row.identity.key}` : null
    const aliases = [row?.id, ...(identity ? [identity] : [])]
    if (!row?.path || !aliases.includes(selection.id)) throw new Error('Orca returned a different workspace than the captured editor. Reopen Preview from the document tab.')
    if (!selection.environment && selection.hostId && (row.hostId || 'local') !== selection.hostId) throw new Error('Orca returned this workspace on another host. Reopen Preview after the workspace connection is ready.')
    if (context?.workspaceId && !aliases.includes(context.workspaceId)) throw new Error('The workspace changed while Preview was opening. Open Preview again from the document tab.')
    const workspace = { id: row.id, aliases, name: row.displayName || row.name || row.path.split(/[\\/]/).pop(), path: row.path, branch: shortBranch(row.branch), hostId: selection.hostId || row.hostId || 'local', ...(selection.environment ? { environment: selection.environment } : {}), selector: identity || `id:${row.id}` }
    return { workspace, candidates: [workspace], context, file: selection.file, source: 'desktop-session' }
  }
  const listed = await orca.host.call('workspace.list', {})
  const workspaces = listed.workspaces.map((workspace) => ({ ...workspace, ...(workspace.hostId?.startsWith('runtime:') ? { environment: decodeURIComponent(workspace.hostId.slice(8)) } : {}) }))
  // Names cannot establish ownership when the public list omits paired hosts.
  // Never contact other saved servers to infer which workspace this frame owns.
  const workspace = chooseWorkspace(context, workspaces)
  const problem = workspace ? null : selectionError
    ? `Cannot read the desktop's current workspace identity: ${selectionError}`
    : !cli ? 'Orca CLI is unavailable for this plugin installation. Update Typst Preview or load an installed copy.'
    : 'Cannot identify this document’s workspace from Orca’s desktop session. Close and reopen the document tab, then retry Preview.'
  if (!workspace) orca.log?.('Typst Preview workspace lookup: ' + JSON.stringify({ desktopSelection: !!selection, desktopReader: !!(cli?.env?.ORCA_USER_DATA_PATH && cli?.prefix?.[0]), publicContext: !!context, publicWorkspaceId: context?.workspaceId ?? null, problem }))
  return { workspace, candidates: workspaces, context, problem, file: null, source: 'public-api' }
}
