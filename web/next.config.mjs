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
    return [
      {
        source: '/:path*',
        headers: [
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
