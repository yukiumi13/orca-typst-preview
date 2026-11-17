import { basicSetup } from 'codemirror'
import { EditorView, keymap } from '@codemirror/view'
import { EditorState, Transaction } from '@codemirror/state'
import { indentWithTab } from '@codemirror/commands'
import { StreamLanguage } from '@codemirror/language'
import { DocumentSync } from './sync'
import { request, listen, upload, stopTransport } from './transport'

declare global { interface Window { startTypstPreview: () => void; stopTypstPreview: () => Promise<void> } }
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const status = element('status')
const errorBox = element('problem')
const toggle = element<HTMLButtonElement>('toggle')
const picker = element<HTMLSelectElement>('file-picker')
// Capture the editor's workspace before renderer initialization or later focus changes.
let workspaceReady: Promise<any> | null = request('preview.workspace', {})
void workspaceReady.catch(() => {})
let workspace: { id: string; name: string; path: string; host: string } | null = null
let preview: string | null = null
let selectedPath: string | null = null
let opening = false
let updateTimer: ReturnType<typeof setTimeout> | undefined
let uploadRunning = false
let dirtyPreview = false

function fail(message: string) {
  status.textContent = 'Needs attention'
  errorBox.textContent = message
  errorBox.hidden = false
  element('conflict-actions').hidden = !sync?.conflict
}
const api = orca.document
if (!api) throw new Error('Open a .typ file in the Typst Preview editor.')
const initial = await api.get()
let replacing = false
const sync = new DocumentSync(api, initial, (text) => {
  replacing = true
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, annotations: Transaction.addToHistory.of(false) })
  replacing = false
  schedulePreview()
}, fail)

const typst = StreamLanguage.define({
  token(stream) {
    if (stream.match('//')) { stream.skipToEnd(); return 'comment' }
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return 'string'
    if (stream.match(/#[\w-]+/)) return 'keyword'
    if (stream.sol() && stream.match(/=+\s.*/)) return 'heading'
    if (stream.match(/\b\d+(?:\.\d+)?(?:pt|em|mm|cm|in|%)?/)) return 'number'
    if (stream.match(/\$[^$]*\$/)) return 'string'
    stream.next(); return null
  }
})
const editor = new EditorView({
  parent: element('source'),
  state: EditorState.create({ doc: sync.draft, extensions: [basicSetup, typst, keymap.of([indentWithTab]), EditorView.lineWrapping,
    EditorState.readOnly.of(initial.readOnly),
    EditorView.theme({ '&': { height: '100%', color: 'var(--orca-foreground)' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, monospace', fontSize: '13px', lineHeight: '1.65' }, '.cm-content': { padding: '18px 8px' }, '.cm-gutters': { backgroundColor: 'var(--orca-background)', color: 'var(--orca-muted-foreground)', border: '0' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--orca-accent)' } }),
    EditorView.updateListener.of((update) => { if (update.docChanged && !replacing) { sync.change(update.state.doc.toString()); schedulePreview() } }),
    EditorView.domEventHandlers({ keydown(event) { event.stopPropagation(); return false } })
  ] })
})
api.onDidChange((doc) => sync.receive(doc))
orca.on('editor.flush', () => sync.flush())

for (const [id, keep] of [['use-outside', false], ['keep-draft', true]] as const) {
  element(id).onclick = async () => {
    try { await sync.resolve(keep); errorBox.hidden = true; element('conflict-actions').hidden = true; schedulePreview() }
    catch (error) { fail(String(error)) }
  }
}

function schedulePreview() {
  dirtyPreview = true
  clearTimeout(updateTimer)
  updateTimer = setTimeout(() => void sendDraft(), 180)
}
async function sendDraft() {
  if (uploadRunning || !preview) return
  uploadRunning = true
  try {
    while (dirtyPreview && preview) {
      dirtyPreview = false
      status.textContent = 'Compiling…'
      await upload(preview, editor.state.doc.toString())
    }
  } catch (error) { if (preview) fail(String(error)) }
  finally { uploadRunning = false }
}
function control(value: any) {
  if (value.event === 'pdf') {
    element('pdf-status').textContent = value.saved ? 'PDF saved' : 'PDF error'
    element('pdf-status').title = value.saved ? value.path : value.message
    return
  }
  if (value.event === 'compileStatus') {
    if (value.kind === 'CompileSuccess') { status.textContent = 'Live'; if (!sync.conflict) errorBox.hidden = true }
    else if (value.kind === 'Compiling') status.textContent = 'Compiling…'
    else {
      status.textContent = 'Compile error'
      void request('preview.send', { view: preview, method: 'diagnostics' }).then((result) => fail(result.logs))
    }
  }
  if (value.event === 'editorScrollTo' && value.filepath === selectedPath) {
    const line = Math.min(editor.state.doc.lines, (value.start?.[0] ?? value.line ?? 0) + 1)
    const at = editor.state.doc.line(Math.max(1, line)).from + (value.start?.[1] ?? 0)
    editor.dispatch({ selection: { anchor: Math.min(at, editor.state.doc.length) }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    editor.focus()
  }
}
async function identify() {
  status.textContent = 'Loading files…'
  element('choose-workspace').hidden = true
  const result = await request('preview.files', {})
  picker.replaceChildren(new Option('Choose the file open in this tab…', ''))
  const dates = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' })
  for (const file of result.files) {
    const relative = file.path.slice(file.root.length + 1)
    picker.add(new Option(`${relative} — modified ${dates.format(new Date(file.modifiedAt))}`, file.path))
  }
  element('workspace-path').textContent = workspace?.path || ''
  element('choose-file').hidden = false
  status.textContent = 'Choose document'
  element('choose-reason').textContent = 'Paste the full file path from Orca’s tab header, or choose a file below. The path can belong to another workspace on this host. Unsaved edits stay in this editor.'
  if (result.truncated) fail('Only part of this workspace’s file list is shown. Choose a listed file, or change workspace.')
  if (!result.files.length) fail(`No .typ files found in ${workspace?.path}. Choose the workspace containing this document. Git-ignored files are excluded from the list.`)
  return null
}
function showWorkspace() {
  if (!workspace) return
  element('workspace').textContent = workspace.name
  element('workspace').title = `${workspace.host}: ${workspace.path}`
}
async function openPreview(pastedPath?: string) {
  if (opening || preview) return
  opening = true; toggle.disabled = true
  errorBox.hidden = true
  element('layout').classList.remove('source-only')
  try {
    if (!workspace) {
      workspaceReady ??= request('preview.workspace', {})
      const result = await workspaceReady
      workspace = result.workspace
      if (!workspace) {
        workspaceReady = null
        throw new Error(result.problem || 'Cannot identify this editor’s workspace. Retry Preview from the document tab.')
      }
    }
    showWorkspace()
    if (!pastedPath) {
      selectedPath ??= await identify()
      if (!selectedPath) return
    }
    status.textContent = 'Starting preview…'
    const result = await request(pastedPath ? 'preview.openPath' : 'preview.open', { path: pastedPath || selectedPath })
    preview = result.view
    workspace = result.workspace
    showWorkspace()
    selectedPath = String(result.path)
    element<HTMLInputElement>('file-path').value = selectedPath
    element('pdf-status').textContent = result.exportPdf ? 'PDF from saved source' : ''
    element('pdf-status').title = result.pdf
    if (result.pdfState) control({ event: 'pdf', ...result.pdfState })
    element('filename').textContent = selectedPath.slice(String(result.root).length + 1)
    element('filename').title = selectedPath
    element('choose-file').hidden = true
    void listen(preview!, control, (message) => { void closePreview().then(() => fail(message)) })
    window.startTypstPreview()
    dirtyPreview = true
    await sendDraft()
    toggle.textContent = 'Close preview'
  } catch (error) { if (!workspace) workspaceReady = null; fail(String(error)) }
  finally { opening = false; toggle.disabled = false }
}
async function closePreview() {
  const view = preview; preview = null
  clearTimeout(updateTimer)
  await window.stopTypstPreview()
  stopTransport()
  if (view) await request('preview.close', { view }).catch(() => {})
  element('layout').classList.add('source-only')
  element('pdf-status').textContent = ''
  toggle.textContent = 'Preview'; status.textContent = 'Preview closed'
}
toggle.onclick = () => { void (preview ? closePreview() : openPreview()) }
picker.onchange = () => { if (picker.value) { selectedPath = picker.value; void openPreview() } }
element<HTMLFormElement>('path-form').onsubmit = event => {
  event.preventDefault()
  const value = element<HTMLInputElement>('file-path').value.trim()
  if (value) void openPreview(value)
}
// Tinymist's page navigation and theme keys must not handle typing in this form.
element('path-form').addEventListener('keydown', event => event.stopPropagation())
element('filename').onclick = () => { void (async () => {
  if (opening) return
  if (preview) await closePreview()
  selectedPath = null
  element('filename').textContent = 'Choose file'
  await openPreview()
})().catch(error => fail(String(error))) }
element('workspace').onclick = () => { void (async () => {
  if (opening || !workspace) return
  opening = true; toggle.disabled = true
  try {
    if (preview) await closePreview()
    element('layout').classList.remove('source-only')
    element('choose-file').hidden = true
    status.textContent = 'Loading workspaces…'
    const result = await request('preview.workspaces', {})
    const select = element<HTMLSelectElement>('workspace-picker')
    select.replaceChildren(new Option('Choose the workspace containing this file…', ''))
    for (const item of result.workspaces) select.add(new Option(`${item.name} — ${item.path}`, item.id))
    element('choose-workspace').hidden = false
    element('workspace-host').textContent = `Workspaces on ${workspace.host}`
    status.textContent = 'Choose workspace'
    if (result.truncated) fail('Only part of this host’s workspace list is available.')
  } finally { opening = false; toggle.disabled = false }
})().catch(error => fail(String(error))) }
element<HTMLSelectElement>('workspace-picker').onchange = () => { void (async () => {
  const id = element<HTMLSelectElement>('workspace-picker').value
  if (!id || opening) return
  opening = true; toggle.disabled = true
  try {
    const result = await request('preview.selectWorkspace', { id })
    workspace = result.workspace
    workspaceReady = Promise.resolve(result)
    selectedPath = null
    element('filename').textContent = 'Choose file'
    errorBox.hidden = true
    showWorkspace()
    await identify()
  } finally { opening = false; toggle.disabled = false }
})().catch(error => fail(String(error))) }
element('reveal').onclick = () => {
  if (!preview) return
  const head = editor.state.selection.main.head
  const line = editor.state.doc.lineAt(head)
  void request('preview.send', { view: preview, method: 'cursor', line: line.number - 1, character: head - line.from }).catch((error) => fail(String(error)))
}
window.addEventListener('pagehide', () => {
  sync.dispose()
  void closePreview()
  void request('preview.detach', {}).catch(() => {})
})
const divider = element('divider')
divider.onpointerdown = (event) => {
  divider.setPointerCapture(event.pointerId)
  divider.onpointermove = (move) => {
    const ratio = Math.min(75, Math.max(25, move.clientX / window.innerWidth * 100))
    element('layout').style.setProperty('--source-width', `${ratio}%`)
    window.dispatchEvent(new Event('resize'))
  }
  divider.onpointerup = () => { divider.onpointermove = null }
}
await import('../vendor/tinymist.js')
await openPreview()
