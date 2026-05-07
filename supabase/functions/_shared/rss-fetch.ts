// ============================================================
// _shared/rss-fetch.ts
//
// Self-contained RSS / Atom feed fetcher used by morning-brief-agent.
// No third-party deps — RSS 2.0 and Atom 1.0 are parsed by hand from
// the feed XML (well-formed publisher feeds only; not robust against
// arbitrary user input).
//
// Returns a "feed pack" of recent items the brief author can pick
// from, plus per-feed stats so we can see which feeds are healthy
// after each cron run.
//
// Why RSS pre-fetch instead of Claude's web_search tool:
//   The big AU mastheads (AFR, The Australian, SMH, The Age, ABC,
//   Domain, news.com.au, realestate.com.au) all block Anthropic's
//   web-search crawler in robots.txt. Their public RSS feeds are
//   designed to be machine-read so the same content is freely
//   available via this path.
// ============================================================

export type FeedSource = {
  name: string
  url: string
  /** True for broad-topic feeds (mainstream business). Items must match
   *  the property keyword regex to be kept. */
  needsKeywordFilter: boolean
}

export type FeedItem = {
  source: string
  title: string
  url: string
  summary: string
  publishedAt: Date
}

export type FeedStats = {
  feed: string
  url: string
  status: 'ok' | 'http_error' | 'parse_error' | 'fetch_error' | 'empty'
  httpStatus?: number
  itemsParsed: number
  itemsKept: number
  errorMessage?: string
}

export type FeedPack = {
  items: FeedItem[]
  stats: FeedStats[]
  fetchedAt: Date
}

// Property-relevance regex applied to broad-topic feeds.
const PROPERTY_REGEX = /\b(propert(?:y|ies)|housing|house\s+price|home\s+loan|mortgage|rental|rents?|vacanc(?:y|ies)|auction|clearance\s+rate|real\s+estate|developer|construction|apartment|townhouse|rba|reserve\s+bank|cash\s+rate|interest\s+rate|inflation|cpi|first[- ]home\s+buyer|investor|corelogic|cotality|sqm\s+research|building\s+approval|dwelling|negative\s+gearing|stamp\s+duty|capital\s+gains|land\s+tax|home\s+value|median\s+price|listings?|new\s+homes?)\b/i

export async function fetchFeedPack(opts: {
  feeds: FeedSource[]
  maxAgeHours?: number
  maxPerFeed?: number
  perFeedTimeoutMs?: number
}): Promise<FeedPack> {
  const maxAgeHours = opts.maxAgeHours ?? 48
  const maxPerFeed = opts.maxPerFeed ?? 5
  const perFeedTimeoutMs = opts.perFeedTimeoutMs ?? 5000
  const cutoff = Date.now() - maxAgeHours * 3600_000

  // Fan out across all feeds in parallel. One bad feed must not break the others.
  const results = await Promise.all(opts.feeds.map(feed =>
    fetchOneFeed(feed, perFeedTimeoutMs).catch(e => ({
      stats: {
        feed: feed.name, url: feed.url, status: 'fetch_error' as const,
        itemsParsed: 0, itemsKept: 0, errorMessage: (e as Error).message,
      },
      items: [] as FeedItem[],
    }))
  ))

  // Per-feed: filter by recency, keyword-filter broad feeds, cap to top N newest.
  const allItems: FeedItem[] = []
  const stats: FeedStats[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const feed = opts.feeds[i]
    const recent = r.items
      .filter(it => it.publishedAt.getTime() >= cutoff)
      .filter(it => !feed.needsKeywordFilter || PROPERTY_REGEX.test(it.title + ' ' + it.summary))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, maxPerFeed)
    allItems.push(...recent)
    stats.push({ ...r.stats, itemsKept: recent.length })
  }

  // Cross-feed dedupe by URL (some stories syndicate across mastheads).
  const seenUrls = new Set<string>()
  const finalItems: FeedItem[] = []
  for (const it of allItems) {
    if (seenUrls.has(it.url)) continue
    seenUrls.add(it.url)
    finalItems.push(it)
  }
  finalItems.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())

  return { items: finalItems, stats, fetchedAt: new Date() }
}

async function fetchOneFeed(feed: FeedSource, timeoutMs: number): Promise<{ items: FeedItem[]; stats: FeedStats }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(feed.url, {
      headers: {
        // Identify ourselves so publishers can see traffic source if they audit.
        'User-Agent': 'TPCH-MorningBrief/1.0 (+https://portal.tpch.com.au)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch (e) {
    return { items: [], stats: { feed: feed.name, url: feed.url, status: 'fetch_error', itemsParsed: 0, itemsKept: 0, errorMessage: (e as Error).message } }
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    return { items: [], stats: { feed: feed.name, url: feed.url, status: 'http_error', httpStatus: res.status, itemsParsed: 0, itemsKept: 0 } }
  }

  let xml: string
  try {
    xml = await res.text()
  } catch (e) {
    return { items: [], stats: { feed: feed.name, url: feed.url, status: 'parse_error', itemsParsed: 0, itemsKept: 0, errorMessage: (e as Error).message } }
  }

  let parsed: { title: string; url: string; summary: string; publishedAt: Date | null }[]
  try {
    parsed = parseFeed(xml)
  } catch (e) {
    return { items: [], stats: { feed: feed.name, url: feed.url, status: 'parse_error', itemsParsed: 0, itemsKept: 0, errorMessage: (e as Error).message } }
  }

  const items: FeedItem[] = parsed
    .filter(p => p.title && p.url && p.publishedAt)
    .map(p => ({ source: feed.name, title: p.title, url: p.url, summary: p.summary, publishedAt: p.publishedAt! }))

  return {
    items,
    stats: { feed: feed.name, url: feed.url, status: items.length ? 'ok' : 'empty', itemsParsed: parsed.length, itemsKept: 0 },
  }
}

// ── XML parsing — RSS 2.0 + Atom 1.0 ──────────────────────────
function parseFeed(xml: string): { title: string; url: string; summary: string; publishedAt: Date | null }[] {
  const blockRegex = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi
  const out: { title: string; url: string; summary: string; publishedAt: Date | null }[] = []
  let m: RegExpExecArray | null
  while ((m = blockRegex.exec(xml)) !== null) {
    const block = m[2]
    const title = stripHtml(extractTag(block, 'title'))
    const url = extractLink(block)
    const summaryRaw = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content')
    const summary = stripHtml(summaryRaw).slice(0, 500)
    const dateStr = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated') || extractTag(block, 'dc:date')
    const d = dateStr ? new Date(dateStr) : null
    const publishedAt = d && !isNaN(d.getTime()) ? d : null
    out.push({ title, url, summary, publishedAt })
  }
  return out
}

function extractTag(block: string, tag: string): string {
  // Allow optional namespace prefix on the tag (e.g. dc:date).
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`<${escaped}\\b[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i')
  const m = block.match(re)
  if (!m) return ''
  return decodeXmlEntities(stripCdata(m[1])).trim()
}

function extractLink(block: string): string {
  // RSS shape: <link>https://...</link>
  const rssM = block.match(/<link\b[^>]*>\s*([^<\s][^<]*)\s*<\/link>/i)
  if (rssM && /^https?:\/\//i.test(rssM[1].trim())) return decodeXmlEntities(rssM[1]).trim()
  // Atom shape: <link href="https://..." rel="alternate"/> — prefer alternate over self.
  const allLinks = [...block.matchAll(/<link\b([^>]*?)\/?\s*>(?:\s*<\/link>)?/gi)]
  let fallback = ''
  for (const lm of allLinks) {
    const attrs = lm[1]
    const hrefM = attrs.match(/href="([^"]+)"/i)
    if (!hrefM) continue
    if (/rel="self"/i.test(attrs)) continue
    if (/rel="alternate"/i.test(attrs)) return decodeXmlEntities(hrefM[1]).trim()
    if (!fallback) fallback = decodeXmlEntities(hrefM[1]).trim()
  }
  return fallback
}

function stripCdata(s: string): string {
  const t = s.trim()
  if (t.startsWith('<![CDATA[') && t.endsWith(']]>')) return t.slice(9, -3)
  return s
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
}

// ── Default AU property + business feed list ──────────────────
// Hardcoded for v1 — feeds rarely move. Per-feed health is logged on
// every cron run; if a publisher changes their RSS URL, the next run's
// log will show empty/http_error and we update here.
export const DEFAULT_AU_PROPERTY_FEEDS: FeedSource[] = [
  // Property-specific (no keyword filter — every item is on-topic)
  { name: 'Urban Developer',          url: 'https://www.urban.com.au/feed',                                                  needsKeywordFilter: false },
  { name: 'Property Update',          url: 'https://propertyupdate.com.au/feed/',                                            needsKeywordFilter: false },
  { name: 'Macro Business AU Property', url: 'https://www.macrobusiness.com.au/category/australian-property/feed/',          needsKeywordFilter: false },
  { name: 'API Magazine',             url: 'https://www.apimagazine.com.au/news/feed',                                       needsKeywordFilter: false },
  { name: 'Real Estate Business',     url: 'https://www.realestatebusiness.com.au/rss/news',                                 needsKeywordFilter: false },
  { name: 'Your Investment Property', url: 'https://www.yourinvestmentpropertymag.com.au/feed/',                             needsKeywordFilter: false },
  { name: 'Elite Agent',              url: 'https://eliteagent.com/feed/',                                                   needsKeywordFilter: false },

  // Mainstream business / news (keyword filter to property-relevant items only)
  { name: 'ABC News - Business',      url: 'https://www.abc.net.au/news/feed/51120/rss.xml',                                 needsKeywordFilter: true },
  { name: 'SMH - Business',           url: 'https://www.smh.com.au/rss/business.xml',                                        needsKeywordFilter: true },
  { name: 'The Age - Business',       url: 'https://www.theage.com.au/rss/business.xml',                                     needsKeywordFilter: true },
  { name: 'news.com.au - Business',   url: 'https://www.news.com.au/content-feeds/latest-news-business/',                    needsKeywordFilter: true },
  { name: 'news.com.au - Real Estate', url: 'https://www.news.com.au/content-feeds/latest-news-real-estate/',                needsKeywordFilter: false },

  // Data houses
  { name: 'RBA Media Releases',       url: 'https://www.rba.gov.au/media-releases/index.xml',                                needsKeywordFilter: false },
]

// Domains the validator will accept as article URLs. Superset of the
// feed source domains — used by the brief agent's URL allow-list check.
export const FEED_DOMAIN_ALLOW_LIST = [
  // Property-specific
  'urban.com.au',
  'propertyupdate.com.au',
  'macrobusiness.com.au',
  'apimagazine.com.au',
  'realestatebusiness.com.au',
  'yourinvestmentpropertymag.com.au',
  'eliteagent.com',
  // Mainstream
  'abc.net.au',
  'smh.com.au',
  'theage.com.au',
  'news.com.au',
  // Data houses
  'rba.gov.au',
  'abs.gov.au',
  'corelogic.com.au',
  'sqmresearch.com.au',
  // Kept for web_search fallback (existing v10 list)
  'commercialrealestate.com.au',
  'view.com.au',
]
