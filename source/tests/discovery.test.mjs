import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, utimes } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { startBackend } from '../worker/client.mjs'

const text = '= Notes\nBody\n'
const hash = createHash('sha256').update(text).digest('hex')

test('file menu lists metadata newest first, without using contents or a stale candidate', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-file-menu-')))
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-file-menu-outside-')))
  const backend = await startBackend()
  try {
    for (const [name, time] of [['recent.typ', 300], ['older.typ', 100], ['same-time.typ', 100]]) {
      await writeFile(path.join(root, name), text)
      await utimes(path.join(root, name), time, time)
    }
    await writeFile(path.join(outside, 'outside.typ'), text)
    await symlink(path.join(outside, 'outside.typ'), path.join(root, 'escape.typ'))
    const found = await backend.call({ method: 'files', roots: [root], preferredPath: path.join(root, 'older.typ'), hash })
    assert.deepEqual(found.files.map(file => path.basename(file.path)), ['recent.typ', 'older.typ', 'same-time.typ'])
    assert.deepEqual(found.files.map(file => file.modifiedAt), [300000, 100000, 100000])
    assert.ok(found.files.every(file => !('match' in file)))
    assert.equal(found.truncated, false)
    await utimes(path.join(root, 'older.typ'), 400, 400)
    assert.equal((await backend.call({ method: 'files', roots: [root] })).files[0].path, path.join(root, 'older.typ'))
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('a verified session candidate skips discovery even with identical sibling files', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-candidate-')))
  const backend = await startBackend()
  try {
    const file = path.join(root, 'note.typ')
    await writeFile(file, '\uFEFF= Notes\r\nBody\r\n')
    await writeFile(path.join(root, 'twin.typ'), text)
    await symlink(file, path.join(root, 'alias.typ'))
    const result = await backend.call({ method: 'discover', roots: [root], hash, preferredPath: path.join(root, 'alias.typ') })
    assert.deepEqual(result.files, [{ path: file, root, match: true }], 'only the verified canonical candidate is returned')
    assert.equal(result.truncated, false)
    assert.equal(result.source, 'candidate')
    const scanned = await backend.call({ method: 'discover', roots: [root], hash })
    assert.equal(scanned.files.length, 2, 'without the session hint the identical files remain ambiguous')
    assert.equal(scanned.source, 'scan')
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})

test('invalid, stale and foreign candidates fall back to scanning the bound workspace', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-candidate-fallback-')))
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-candidate-outside-')))
  const backend = await startBackend()
  try {
    const file = path.join(root, 'note.typ')
    await writeFile(file, text)
    await writeFile(path.join(root, 'stale.typ'), '= Different document')
    await writeFile(path.join(root, 'large.typ'), 'x'.repeat(8 * 1024 * 1024 + 1))
    await writeFile(path.join(root, 'not-typ.txt'), text)
    await mkdir(path.join(root, 'directory.typ'))
    await writeFile(path.join(outside, 'note.typ'), text)
    await symlink(path.join(outside, 'note.typ'), path.join(root, 'escape.typ'))
    await symlink(path.join(root, 'not-typ.txt'), path.join(root, 'wrong-type.typ'))
    for (const preferredPath of [null, 'note.typ', path.join(root, 'missing.typ'), path.join(root, 'stale.typ'), path.join(root, 'large.typ'), path.join(root, 'directory.typ'), path.join(root, 'wrong-type.typ'), path.join(root, 'escape.typ'), path.join(outside, 'note.typ')]) {
      const result = await backend.call({ method: 'discover', roots: [root], hash, preferredPath })
      assert.equal(result.source, 'scan', String(preferredPath))
      assert.deepEqual(result.files.filter((candidate) => candidate.match).map((candidate) => candidate.path), [file])
    }
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }) }
})

test('an explicitly captured ignored file can be verified without changing fallback discovery', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'typst-candidate-ignored-')))
  const backend = await startBackend()
  try {
    await promisify(execFile)('git', ['init', '--quiet', root])
    await writeFile(path.join(root, '.gitignore'), 'ignored.typ\n')
    const file = path.join(root, 'ignored.typ')
    await writeFile(file, text)
    const found = await backend.call({ method: 'discover', roots: [root], hash, preferredPath: file })
    assert.deepEqual(found.files, [{ path: file, root, match: true }])
    assert.equal(found.source, 'candidate')
    const missing = await backend.call({ method: 'discover', roots: [root], hash })
    assert.deepEqual(missing.files, [])
    assert.equal(missing.source, 'scan')
  } finally { await backend.close(); await rm(root, { recursive: true, force: true }) }
})
