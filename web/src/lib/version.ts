/**
 * Build identity surfaced to the UI footer. Set at docker build time via
 * `--build-arg BUILD_VERSION=$(jq -r .version web/package.json)` and
 * `--build-arg GIT_SHA=$(git rev-parse --short HEAD)`.
 *
 * `NEXT_PUBLIC_*` prefix makes these readable in client components without a
 * server round-trip. Defaults make local dev (`pnpm dev`) work without args.
 */
export const BUILD_VERSION = process.env.NEXT_PUBLIC_BUILD_VERSION ?? '0.0.0-dev'
export const GIT_SHA = process.env.NEXT_PUBLIC_GIT_SHA ?? 'dev'

export const RELEASE_URL = `https://github.com/jason-tucker/simple-rss-notifications/releases/tag/v${BUILD_VERSION}`
