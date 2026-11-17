/** Keep a refused or conflicting draft visible until its owner resolves it. */
import type { EditorDocument, EditorDocumentApi, EditorEdit } from 'orca/frame'

export class DocumentSync {
  draft: string
  base: EditorDocument
  conflict: EditorDocument | null = null
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(readonly api: EditorDocumentApi, initial: EditorDocument,
    readonly replace: (text: string) => void, readonly problem: (message: string) => void) {
    this.base = initial
    this.draft = this.text(initial)
  }
  private text(doc: EditorDocument) { return doc.content.kind === 'text' ? doc.content.text : '' }
  receive(doc: EditorDocument) {
    if (doc.version === this.base.version) return
    const outside = this.text(doc)
    if (this.draft !== this.text(this.base) && this.draft !== outside) {
      this.conflict = doc
      this.problem('The file changed outside this editor. Your draft is kept. Choose which version to use before saving.')
      return
    }
    this.base = doc; this.draft = outside; this.conflict = null
    this.replace(outside)
  }
  change(text: string) {
    this.draft = text
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush().catch((error) => this.problem(error.message)), 120)
  }
  async resolve(keepDraft: boolean) {
    if (!this.conflict) return
    this.base = this.conflict; this.conflict = null
    if (!keepDraft) { this.draft = this.text(this.base); this.replace(this.draft) }
    else await this.flush()
  }
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    if (this.pending) { await this.pending; return this.flush() }
    if (this.conflict) throw new Error('Resolve the outside file change before saving. Your draft is kept.')
    if (this.draft === this.text(this.base)) return
    if (this.base.readOnly) throw new Error('This file is read-only.')
    const edit: EditorEdit = { baseVersion: this.base.version, content: { kind: 'text', text: this.draft } }
    this.pending = this.api.applyEdit(edit).then(() => {
      if (this.base.version === edit.baseVersion) this.base = { ...this.base, content: edit.content }
    }).catch(async (error) => {
      if (error.code === 'conflict') this.receive(await this.api.get())
      throw error
    }).finally(() => { this.pending = null })
    await this.pending
    if (this.draft !== this.text(this.base)) await this.flush()
  }
  dispose() { clearTimeout(this.timer) }
}
