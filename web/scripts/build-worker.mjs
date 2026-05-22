#!/usr/bin/env node
import { build } from 'esbuild'

const BUILD_VERSION = process.env.BUILD_VERSION || '0.0.0-dev'
const GIT_SHA = process.env.GIT_SHA || 'dev'

await build({
  entryPoints: ['src/worker/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/worker/index.js',
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  // Inline BUILD_VERSION / GIT_SHA into the worker bundle so log messages
  // and worker_heartbeats rows show the real version. The Next.js bundle
  // gets these via NEXT_PUBLIC_* env at build time; the worker bundle
  // has to be told explicitly because esbuild doesn't auto-substitute.
  define: {
    'process.env.NEXT_PUBLIC_BUILD_VERSION': JSON.stringify(BUILD_VERSION),
    'process.env.NEXT_PUBLIC_GIT_SHA': JSON.stringify(GIT_SHA),
  },
  // Workaround for argon2 / postgres-js: leave them external so the
  // standalone runtime's traced node_modules can satisfy them (the build
  // step copies node_modules into the standalone output anyway).
  external: ['@node-rs/argon2'],
  tsconfig: 'tsconfig.json',
  logLevel: 'info',
})
