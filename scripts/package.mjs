/** Rebuild the installable subtree without including development dependencies. */
import { execFileSync } from 'node:child_process'
import { cp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: path.join(root, 'source'), stdio: 'inherit' })
await rm(path.join(root, 'plugin'), { recursive: true, force: true })
await cp(path.join(root, 'source/dist'), path.join(root, 'plugin'), { recursive: true })
console.log('Updated plugin/. Validate and commit it before generating the catalog release entry.')
