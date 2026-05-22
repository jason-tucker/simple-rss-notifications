// Noop stub for esbuild's worker bundle. The real `server-only` package
// throws when imported from a client-side bundle; here in the always-server
// worker the marker has nothing to do.
export {}
