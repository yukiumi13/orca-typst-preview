/** Bundle browser dependencies and their licenses into an installable folder. */
import { build } from 'esbuild'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
await mkdir(path.join(root, 'dist/editor'), { recursive: true })
const result = await build({ entryPoints: [path.join(root, 'editor/main.ts')], outfile: path.join(root, 'dist/editor/main.js'), bundle: true, format: 'esm', target: 'chrome130', sourcemap: true, legalComments: 'linked', metafile: true })
const packages = new Set()
for (const input of Object.keys(result.metafile.inputs)) {
  const parts = path.resolve(input).split(path.sep)
  const index = parts.lastIndexOf('node_modules')
  if (index >= 0) packages.add(parts.slice(0, index + (parts[index + 1].startsWith('@') ? 3 : 2)).join(path.sep))
}
const notices = ['Bundled browser dependencies. Tinymist attribution is in vendor/NOTICE.md.\n']
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  const license = await readFile(path.join(directory, 'LICENSE'), 'utf8')
  notices.push(`${pkg.name} ${pkg.version}\n${'='.repeat(72)}\n${license}`)
}
await writeFile(path.join(root, 'dist/THIRD_PARTY_NOTICES.txt'), notices.join('\n\n'))
for (const file of ['orca-plugin.json', 'README.md', 'LICENSE', 'NOTICE', 'worker', 'vendor', 'editor/index.html', 'editor/style.css']) {
  await cp(path.join(root, file), path.join(root, 'dist', file), { recursive: true })
}
console.log('Install folder: ' + path.join(root, 'dist'))
