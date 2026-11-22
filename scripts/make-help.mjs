// Writes docs/HELP.md from src/core/help.ts
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
const r = await build({ entryPoints: ['src/core/help.ts'], bundle: true, format: 'esm', write: false, platform: 'node' })
const mod = await import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'))
mkdirSync('docs', { recursive: true })
writeFileSync('docs/HELP.md', mod.helpMarkdown())
console.log('docs/HELP.md written')
