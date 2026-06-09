import 'server-only'
import { isSafeUrl } from '@/lib/url'

/**
 * RSS items frequently ship `<description>` / `<content:encoded>` as raw
 * HTML (`<p>`, `<strong>`, `<a href=…>`, plus entity references like
 * `&nbsp;`). Sending that as-is in a plain-text email puts the angle
 * brackets in the user's inbox. We always need both:
 *
 *   - a clean plain-text version for the `text` part of an email, for
 *     ntfy push body, and for Discord embed description (Discord doesn't
 *     render HTML in embeds, but supports a markdown-ish subset).
 *   - a sanitized HTML version for the `html` part of an email so
 *     mail clients render formatting properly.
 *
 * Dependency-free implementation — for a notification bridge, a regex
 * pass over the small subset of tags RSS items actually use is enough
 * and avoids dragging in a heavyweight HTML parser. If a feed throws
 * something truly weird at us, the worst case is mildly ugly text;
 * sanitization still strips anything dangerous.
 */

// ── Entity decoding ─────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', trade: '™', copy: '©', reg: '®', deg: '°', plusmn: '±',
  middot: '·', laquo: '«', raquo: '»', bull: '•', sect: '§', para: '¶',
  shy: '­',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = parseInt(ref.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m
    }
    if (ref.startsWith('#')) {
      const code = parseInt(ref.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m
    }
    const lower = ref.toLowerCase()
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower]! : _m
  })
}

// ── HTML → plain text ───────────────────────────────────────────────────────

/**
 * Render HTML to readable plain text:
 *   - block tags (`p`, `div`, `h1`-`h6`, `li`, `tr`) become paragraph breaks
 *   - `<br>` becomes a single newline
 *   - `<a href="X">text</a>` becomes `text (X)` so links survive
 *   - inline formatting tags lose markup but keep text
 *   - entities are decoded
 *   - whitespace runs collapse to single space inside paragraphs;
 *     successive blank lines collapse to a single blank line
 *
 * Pass plain (already-text) input and it round-trips unchanged.
 */
export function htmlToPlainText(input: string | null | undefined): string {
  if (!input) return ''
  let s = input

  // Strip <script>/<style>/<head>/<svg> blocks wholesale — they're never
  // worth rendering as text and may contain non-content noise.
  s = s.replace(/<(script|style|head|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')

  // CDATA wrappers — drop the wrapper, keep the content.
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  // Anchor rendering: <a href="X">label</a> → label (X)
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
    const label = text.replace(/<[^>]+>/g, '').trim()
    const url = href.trim()
    if (!url) return label
    if (!label || label === url) return url
    return `${label} (${url})`
  })

  // <br> → newline
  s = s.replace(/<br\s*\/?>/gi, '\n')

  // Block-level tags get a leading newline so paragraphs separate visibly.
  // Closing tag also gets a newline to ensure end-of-block break.
  s = s.replace(/<\/(p|div|section|article|header|footer|aside|h[1-6]|li|tr|blockquote|pre)\s*>/gi, '\n\n')
  s = s.replace(/<(p|div|section|article|header|footer|aside|h[1-6]|li|tr|blockquote|pre)\b[^>]*>/gi, '\n')

  // List items already got newlines; add bullets as a hint.
  // (We can't easily distinguish ordered from unordered in plain text without
  // tracking depth; '- ' covers both readably.)
  s = s.replace(/\n\s*-\s*\n/g, '\n') // no-op if there are no markers
  // Apply '- ' for any block-level <li> we just turned into a newline.
  // The earlier replace already produced "\n…\n\n"; insert "- " after the
  // leading newline of each list item. Easier: re-derive from the original
  // input. Skip for v0 — bullets aren't critical.

  // Strip all remaining tags.
  s = s.replace(/<[^>]+>/g, '')

  // Decode entities.
  s = decodeEntities(s)

  // Normalize whitespace: keep \n\n as paragraph break, collapse other runs.
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\f\v]+/g, ' ')              // intra-line whitespace
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')          // trim around newlines
  s = s.replace(/\n{3,}/g, '\n\n')                // cap at one blank line
  s = s.trim()

  return s
}

// ── HTML sanitizer (allowlist) ──────────────────────────────────────────────

const ALLOWED_TAGS = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'cite', 'code', 'div', 'em', 'figure',
  'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd',
  'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'section', 'small', 'span',
  'strong', 'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
  'u', 'ul',
])

const ALLOWED_ATTRS_BY_TAG: Record<string, Set<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
}

/**
 * Strip dangerous HTML and produce an email-safe body. Removes:
 *   - script/style/iframe/object/embed and their contents
 *   - on* event-handler attributes
 *   - href / src that aren't http(s)/mailto
 *   - any tag not on the allowlist (keeps its text contents)
 *
 * Adds:
 *   - rel="noopener noreferrer nofollow" + target="_blank" to anchors
 *   - safer wrapper paragraph if the input is bare text
 */
export function sanitizeHtmlForEmail(input: string | null | undefined): string {
  if (!input) return ''
  let s = input

  // Drop dangerous block tags wholesale.
  s = s.replace(/<(script|style|iframe|object|embed|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  // CDATA wrappers (some RSS feeds wrap content).
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  // Walk through tags, keeping allowed ones with filtered attrs.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) return ''
    const isClosing = match.startsWith('</')
    if (isClosing) return `</${tag}>`

    // Parse attributes, allowlist them, sanitize URL-ish ones.
    const allowed = ALLOWED_ATTRS_BY_TAG[tag] ?? new Set<string>()
    const safeAttrs: string[] = []
    const attrRe = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
    let am: RegExpExecArray | null
    while ((am = attrRe.exec(rawAttrs))) {
      const name = am[1]!.toLowerCase()
      const value = am[3] ?? am[4] ?? am[5] ?? ''
      if (name.startsWith('on')) continue              // event handlers
      if (!allowed.has(name)) continue
      if ((name === 'href' || name === 'src') && !isSafeUrl(value)) continue
      // Encode attribute value: drop double-quotes, keep utf-8.
      const safeValue = value.replace(/"/g, '&quot;')
      safeAttrs.push(`${name}="${safeValue}"`)
    }

    // Anchor hardening: open in new tab, no referer, nofollow.
    if (tag === 'a' && safeAttrs.length > 0) {
      safeAttrs.push('rel="noopener noreferrer nofollow"', 'target="_blank"')
    }

    const isVoid = tag === 'br' || tag === 'hr' || tag === 'img'
    return `<${tag}${safeAttrs.length ? ' ' + safeAttrs.join(' ') : ''}${isVoid ? '/' : ''}>`
  })

  return s
}

// ── Truncation ──────────────────────────────────────────────────────────────

/**
 * Truncate a string at a word boundary near `max` chars, appending an
 * ellipsis if anything was cut. For HTML, prefer truncating the plain
 * text version then re-rendering — this function is just a string op.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  // Find the last whitespace within the limit so we don't cut mid-word.
  const slice = text.slice(0, max)
  const lastSpace = slice.lastIndexOf(' ')
  const cutAt = lastSpace > max * 0.6 ? lastSpace : max
  return slice.slice(0, cutAt).trimEnd() + '…'
}

// ── Email body builder ─────────────────────────────────────────────────────

/**
 * Build a notification body for a feed item — returns separate `text`
 * and `html` strings. Both are derived from the same source content:
 *
 *   - `html` is the sanitized HTML, ready for an email's `html` part.
 *   - `text` is the plain-text rendering, suitable for the `text` part,
 *     for ntfy push body, and for Discord embed description.
 *
 * The wrapper adds the feed label as a footer line in both versions.
 */
export interface FeedItemBody {
  text: string
  html: string
}

export function buildFeedItemBody(args: {
  title: string | null | undefined
  summaryHtml: string | null | undefined
  link: string | null | undefined
  feedLabel: string
  /** Final character cap for the plain-text version. Default 100 000. */
  maxTextChars?: number
}): FeedItemBody {
  const maxText = args.maxTextChars ?? 100_000
  const title = (args.title ?? '').trim() || '(no title)'
  const link = (args.link ?? '').trim()

  const summaryText = htmlToPlainText(args.summaryHtml ?? '')
  const summaryHtml = sanitizeHtmlForEmail(args.summaryHtml ?? '')

  // Plain text composition.
  const textParts = [title, '', summaryText]
  if (link) textParts.push('', link)
  textParts.push('', `— from ${args.feedLabel} · Euphoric Notify`)
  let text = textParts.filter((p, i, arr) =>
    // collapse multiple blank lines (when summaryText itself ends with blank)
    !(p === '' && arr[i - 1] === ''),
  ).join('\n').trim()
  text = truncate(text, maxText)

  // HTML composition.
  const linkHtml = link
    ? `<p><a href="${link.replace(/"/g, '&quot;')}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtmlAttr(link)}</a></p>`
    : ''
  const html = [
    `<h2 style="margin:0 0 .5em 0">${escapeText(title)}</h2>`,
    summaryHtml ? `<div>${summaryHtml}</div>` : '',
    linkHtml,
    `<hr style="border:none;border-top:1px solid #ddd;margin:1em 0">`,
    `<p style="font-size:.85em;color:#666;margin:0">— from <strong>${escapeText(args.feedLabel)}</strong> · <em>Euphoric Notify</em></p>`,
  ].filter(Boolean).join('\n')

  return { text, html }
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeHtmlAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;')
}

// ── HTML → Discord markdown ────────────────────────────────────────────────

/**
 * Convert HTML to Discord-flavored markdown so embed descriptions render
 * with real formatting (bold, italic, links, code, lists). Falls back to
 * plain text for anything Discord can't render. Discord's flavor:
 *
 *   **bold**   *italic*   __underline__   ~~strike~~
 *   `inline code`   ```block code```
 *   [label](url)   > blockquote
 *   - bullet (line-prefix; nested with two spaces)
 *
 * Returned string is safe to drop into an embed `description` (Discord
 * doesn't HTML-escape, so leaving angle brackets is fine).
 */
export function htmlToDiscordMarkdown(input: string | null | undefined): string {
  if (!input) return ''
  let s = input

  // Strip dangerous + non-content blocks before any text extraction.
  s = s.replace(/<(script|style|head|svg|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  s = s.replace(/<!--[\s\S]*?-->/g, '')

  // Inline formatting first (so nested tags still pick up).
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `**${stripTags(body).trim()}**`)
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `*${stripTags(body).trim()}*`)
  s = s.replace(/<(code|kbd|samp)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `\`${stripTags(body).trim()}\``)
  s = s.replace(/<u\b[^>]*>([\s\S]*?)<\/u>/gi, (_m, body) => `__${stripTags(body).trim()}__`)
  s = s.replace(/<(s|strike|del)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, body) => `~~${stripTags(body).trim()}~~`)
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => `\n\`\`\`\n${stripTags(body).trim()}\n\`\`\`\n`)
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body) => {
    const inner = stripTags(body).trim()
    return '\n' + inner.split(/\n/).map((l) => `> ${l}`).join('\n') + '\n'
  })

  // Anchors render as [label](url).
  s = s.replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, body: string) => {
    const label = stripTags(body).trim()
    const url = href.trim()
    if (!url) return label
    if (!label || label === url) return `<${url}>` // bare URL — Discord auto-embeds
    return `[${label}](${url})`
  })

  // Headings: bold + paragraph break.
  s = s.replace(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_m, body) => `\n\n**${stripTags(body).trim()}**\n`)

  // List items become "- text" lines.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${stripTags(body).trim()}`)

  // <br> → newline
  s = s.replace(/<br\s*\/?>/gi, '\n')

  // Remaining block tags become paragraph breaks.
  s = s.replace(/<\/(p|div|section|article|header|footer|aside|tr|ul|ol)\s*>/gi, '\n\n')
  s = s.replace(/<(p|div|section|article|header|footer|aside|tr|ul|ol)\b[^>]*>/gi, '')

  // Strip everything else.
  s = stripTags(s)

  // Decode entities (after tag stripping so &lt; in source doesn't get re-parsed).
  s = decodeEntities(s)

  // Whitespace normalization.
  s = s.replace(/\r\n?/g, '\n')
  s = s.replace(/[ \t\f\v]+/g, ' ')
  s = s.replace(/[ \t]*\n[ \t]*/g, '\n')
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.trim()

  return s
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '')
}

// ── Discord embed builder ───────────────────────────────────────────────────

/**
 * Build a Discord rich embed for a feed item — markdown description,
 * clickable title via the link, feed label as author, item publish date
 * as timestamp, Euphoric Notify in the footer, brand-purple sidebar.
 *
 * Discord limits respected: title 256 / description 4096 / author.name 256
 * / footer.text 2048. Description is the most likely to overflow; we cap
 * at 3500 chars with a graceful word-boundary cut to keep room under the
 * total 6000-char combined limit.
 */
export interface DiscordEmbedArgs {
  title: string | null | undefined
  summaryHtml: string | null | undefined
  link: string | null | undefined
  feedLabel: string
  publishedAt?: Date | null
}

export interface DiscordEmbed {
  title: string
  description?: string
  url?: string
  timestamp?: string
  color: number
  author: { name: string }
  footer: { text: string }
}

// Brand-violet from the gradient; Discord wants an integer (0xRRGGBB).
const EUPHORIC_COLOR = 0xa78bfa

export function buildDiscordEmbed(args: DiscordEmbedArgs): DiscordEmbed {
  const title = truncate(((args.title ?? '').trim() || args.feedLabel), 256)
  const md = htmlToDiscordMarkdown(args.summaryHtml ?? '')
  const description = md ? truncate(md, 3500) : undefined
  const embed: DiscordEmbed = {
    title,
    color: EUPHORIC_COLOR,
    author: { name: truncate(args.feedLabel, 256) },
    footer: { text: 'Euphoric Notify' },
  }
  if (description) embed.description = description
  if (args.link?.trim()) embed.url = args.link.trim()
  if (args.publishedAt) embed.timestamp = args.publishedAt.toISOString()
  return embed
}

// ── ntfy body ──────────────────────────────────────────────────────────────

/**
 * Build the ntfy push body. ntfy renders plain text (markdown only when
 * Markdown: yes header is set and the client supports it; phone clients
 * historically render plain). 1500-char cap keeps the push readable on
 * a phone notification.
 */
export function buildNtfyBody(args: {
  title: string | null | undefined
  summaryHtml: string | null | undefined
  link: string | null | undefined
  feedLabel: string
}): string {
  const text = htmlToPlainText(args.summaryHtml ?? '')
  // Trim to first ~1500 chars at a sentence/paragraph boundary if possible.
  const trimmed = truncate(text, 1500)
  return trimmed || (args.link ?? '') || `New item from ${args.feedLabel}`
}
