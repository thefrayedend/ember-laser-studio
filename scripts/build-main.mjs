import { build } from 'esbuild'

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron', 'serialport', '@serialport/*', 'ws', 'bonjour-service'],
  logLevel: 'info',
}
await build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' })
await build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload/preload.js' })
await build({ ...common, entryPoints: ['src/server/server.ts'], outfile: 'dist/server/server.js' })
