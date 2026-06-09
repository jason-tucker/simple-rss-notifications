// @ts-check

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',

  // Keep these CJS / native-binding packages OUT of the webpack bundle so
  // they resolve from node_modules at runtime instead. nodemailer relies
  // on dynamic require() patterns that webpack can't trace; @node-rs/argon2
  // is a Rust native binding and can't be bundled at all.
  serverExternalPackages: ['nodemailer', '@node-rs/argon2'],

  async headers() {
    // Content-Security-Policy: a backstop against injection (defense-in-depth
    // for the feed-controlled-content XSS class). This baseline is chosen to
    // NOT break Next 15 SSR/hydration or Tailwind.
    //
    // INTERIM CAVEAT: `script-src`/`style-src` include `'unsafe-inline'`
    // because Next's inline bootstrap/hydration scripts and Tailwind's inline
    // styles aren't nonce-tagged here. `'unsafe-inline'` weakens the script
    // protection. The recommended follow-up is a nonce-based strict CSP via
    // middleware (generate a per-request nonce, inject it into Next's scripts,
    // and replace `'unsafe-inline'` with `'nonce-...'` + `'strict-dynamic'`).
    // That pipeline can't be safely build-tested in this environment, so it's
    // intentionally deferred.
    const csp = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
    ].join('; ')
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
    ]
  },
}

export default nextConfig
