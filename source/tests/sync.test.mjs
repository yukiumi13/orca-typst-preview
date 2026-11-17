import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
const source = await readFile(new URL('../editor/sync.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm' })
const { DocumentSync } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const doc = (version, text) => ({ version, readOnly: false, content: { kind: 'text', text } })

test('conflicting external write keeps the draft and blocks saving until resolved', async () => {
  let current = doc(1, 'original')
  const writes = []
  const api = { get: async () => current, applyEdit: async (edit) => { writes.push(edit); current = { ...current, content: edit.content } } }
  const sync = new DocumentSync(api, current, () => {}, () => {})
  sync.change('my unsaved draft')
  current = doc(2, 'agent write')
  sync.receive(current)
  await assert.rejects(sync.flush(), /Resolve the outside file change/)
  assert.equal(sync.draft, 'my unsaved draft')
  assert.equal(writes.length, 0)
  await sync.resolve(true)
  assert.deepEqual(writes, [{ baseVersion: 2, content: { kind: 'text', text: 'my unsaved draft' } }])
  sync.dispose()
})

test('typing while applyEdit is pending is coalesced without losing the later edit', async () => {
  const writes = []
  let release
  const initial = doc(1, 'original')
  const sync = new DocumentSync({ applyEdit: async (edit) => { writes.push(edit); if (writes.length === 1) await new Promise((resolve) => { release = resolve }) } }, initial, () => {}, () => {})
  sync.change('first edit')
  const flushing = sync.flush()
  sync.change('latest edit')
  release()
  await flushing
  assert.deepEqual(writes.map((edit) => edit.content.text), ['first edit', 'latest edit'])
  assert.equal(sync.draft, 'latest edit')
  sync.dispose()
})
