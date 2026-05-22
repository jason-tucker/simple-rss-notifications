import 'server-only'
import { createHash } from 'node:crypto'

/**
 * Minimal, dependency-free RSS 2.0 / Atom 1.0 parser. Handles the 95%
 * case for items we want to fan out as notifications: title, link,
 * summary/description, guid/id, published/updated.
 *
 * We pull in NO npm parser dep — those tend to be either heavyweight
 * (rss-parser bundles xml2js etc.) or aggressive at "normalizing" date
 * strings in ways that mis-handle obscure feeds. A regex pass over
 * the XML is unambiguous, easy to debug, and adequate for the
 * subset of fields we read.
 *
 * If a feed has bizarre namespacing or non-standard structure we'll
 * still extract title+link and dedup via the link as a guid fallback.
 */

export interface ParsedItem {
  /** Stable dedup key. RSS <guid> if present, else hash(link). */
  guid: string
  title: string | null
  link: string | null
  summary: string | null
  publishedAt: Date | null
}

/** Returns the parsed items in feed order (newest-first when the feed itself is sorted that way). */
export function parseFeedBody(body: string): ParsedItem[] {
  const items: ParsedItem[] = []
  for (const block of iterItemBlocks(body)) {
    const guidRaw = extractTag(block, ['guid', 'id'])
    const link = extractLink(block)
    const guid = guidRaw ?? (link ? hashKey(link) : hashKey(block.slice(0, 200)))
    items.push({
      guid: guid.trim(),
      title: extractTag(block, ['title']),
      link,
      summary: extractTag(block, ['summary', 'description', 'content']),
      publishedAt: parseDate(extractTag(block, ['pubDate', 'published', 'updated', 'dc:date'])),
    })
  }
  return items
}

function* iterItemBlocks(body: string): Generator<string> {
  // RSS 2.0: <item>...</item>; Atom 1.0: <entry>...</entry>.
  // Lazy regex so we don't slurp across multiple items.
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    yield m[2]!
  }
}

function extractTag(block: string, names: string[]): string | null {
  for (const name of names) {
    // Self-closing, e.g. <link href="..."/>, handled by extractLink separately.
    // Match either CDATA, plain, or empty body.
    const re = new RegExp(`<${escapeRegex(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRegex(name)}>`, 'i')
    const m = re.exec(block)
    if (!m) continue
    const raw = m[1] ?? ''
    const text = decodeXml(stripCdata(raw)).trim()
    if (text) return text
  }
  return null
}

/**
 * Atom links are self-closing with rel/type attrs:  <link rel="alternate" href="..."/>
 * RSS 2.0 links are plain text: <link>https://...</link>
 * Try alternate-relation Atom first, then any other Atom link, then RSS plain.
 */
function extractLink(block: string): string | null {
  const atomAlternate = /<link\b[^>]*\brel=["']?alternate["']?[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block)
  if (atomAlternate) return atomAlternate[1] ?? null
  const atomAny = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block)
  if (atomAny) return atomAny[1] ?? null
  const rssLink = /<link\b[^>]*>([\s\S]*?)<\/link>/i.exec(block)
  if (rssLink) return decodeXml(stripCdata(rssLink[1] ?? '')).trim() || null
  return null
}

function stripCdata(s: string): string {
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(s)
  return m ? m[1]! : s
}

function decodeXml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

function parseDate(raw: string | null): Date | null {
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? new Date(t) : null
}

function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 40)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
