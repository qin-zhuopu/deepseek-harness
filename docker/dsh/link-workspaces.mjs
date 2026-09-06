// Link every @deepseek-ai workspace package into the root node_modules.
//
// pnpm only links workspace packages that something in the dependency graph
// depends on; the cordis loader resolves plugin packages by name from the
// loader's own location at runtime, so every workspace package must be
// reachable from the root node_modules whether or not install linked it.
// Runs inside the dsh image build right after `pnpm install`.
import { existsSync, readdirSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const nm = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(nm, { recursive: true })

const linked = new Set()
const walk = (dir, depth) => {
  if (depth > 4) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const dirPath = join(dir, entry.name)
    const manifest = join(dirPath, 'package.json')
    if (existsSync(manifest)) {
      const name = JSON.parse(readFileSync(manifest, 'utf8')).name
      if (typeof name === 'string' && name.startsWith('@deepseek-ai/') && !linked.has(name)) {
        linked.add(name)
        const dest = join(nm, name.slice('@deepseek-ai/'.length))
        // The target must be absolute: a relative symlink resolves against the
        // link's own directory (node_modules/@deepseek-ai), not the repo root.
        if (!existsSync(dest)) symlinkSync(join(root, dirPath), dest)
      }
    }
    walk(dirPath, depth + 1)
  }
}

for (const base of ['packages', 'vendor', 'apps', 'native', 'examples']) {
  if (existsSync(base)) walk(base, 0)
}
console.log(`linked ${linked.size} @deepseek-ai workspace packages into root node_modules`)
