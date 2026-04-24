// ============================================================
// TPCH Portal — Regenerate Research Section
// Supabase Edge Function: regenerate-research-section
//
// Feeds admin review comments back into Opus 4.7 to rewrite ONE
// narrative section of a suburb_research draft. Scores, hero
// metrics, endorsements, comparable sales are intentionally NOT
// regeneratable (re-run the full skill instead).
//
// Secrets required:
//   CLAUDE_API_KEY                  = Anthropic API key
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY auto-injected)
//
// POST body:
//   {
//     research_id: uuid,
//     section_key: string,        // see NARRATIVE_SECTIONS below
//     notes?: string,             // admin free-text guidance
//     comment_ids?: uuid[],       // specific comments to address; if omitted,
//                                 //   uses all open comments for this section
//     triggered_by?: string
//   }
//
// Response 200:
//   { version_number, old, new, comments_addressed: [uuid] }
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CLAUDE_API_KEY = Deno.env.get('CLAUDE_API_KEY')!
const sb = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// Narrative sections that can be regenerated. Anything else (hero
// metrics, endorsements, comparable_sales, sources) requires a full
// skill re-run because it is data-driven not prose-driven.
const PILLAR_KEYS = [
  'demographics', 'migration', 'employment', 'supply_pipeline', 'vacancy_trend',
  'price_growth', 'rent_trend', 'affordability', 'infrastructure', 'risk_register',
]
const DIMENSION_KEYS = [
  'demographic_tailwind', 'supply_pressure', 'capital_growth_outlook',
  'income_yield_quality', 'infra_liveability',
]
const NARRATIVE_ALLOWLIST = new Set<string>([
  'exec_summary',
  'narrative_thesis',
  'counter_view',
  ...PILLAR_KEYS.map(k => 'pillar_' + k),
  ...DIMENSION_KEYS.map(k => 'dim_' + k),
])

const SECTION_LABEL: Record<string, string> = {
  exec_summary: 'Executive summary (thesis_main + thesis_short)',
  narrative_thesis: 'Long-form narrative thesis',
  counter_view: 'Counter-view response (counter_view.response only; do not change the cited article)',
}
for (const k of PILLAR_KEYS) SECTION_LABEL['pillar_' + k] = `Pillar narrative: ${k} (headline + narrative only)`
for (const k of DIMENSION_KEYS) SECTION_LABEL['dim_' + k] = `Dimension: ${k} (score + score_reasoning; defend or revise against the challenge)`

const TONE_RULES = `TONE & VOICE (TPCH house style, non-negotiable):
- Australian English throughout. -ise endings, "centre", "metre", "labour", "favour".
- Confident, institutional, precise. No exclamation marks. No hype words.
- NEVER use em dashes (—). Use full stops, commas, semicolons, or round brackets.
- Avoid jargon ("institutional-grade", "blue-chip", "world-class", "prime", "boutique") unless qualified by a specific named feature.
- State findings as sourced facts. Cite inline as "(Source: Publisher, Date)" only. No XML or markdown citation tags.
- If you cannot source a claim, drop the claim. Do not invent numbers.`

// ── Extract current content for a section ───────────────────
function extractOld(section_key: string, row: any): Record<string, any> {
  if (section_key === 'exec_summary') {
    return { thesis_main: row.thesis_main ?? null, thesis_short: row.thesis_short ?? null }
  }
  if (section_key === 'narrative_thesis') {
    return { narrative_thesis: row.narrative_thesis ?? null }
  }
  if (section_key === 'counter_view') {
    return { counter_view: row.counter_view ?? null }
  }
  if (section_key.startsWith('pillar_')) {
    const k = section_key.slice('pillar_'.length)
    const p = (row.pillars && row.pillars[k]) || null
    return {
      pillar_key: k,
      headline: p?.headline ?? null,
      narrative: p?.narrative ?? null,
      status: p?.status ?? null,
    }
  }
  if (section_key.startsWith('dim_')) {
    const k = section_key.slice('dim_'.length)
    const d = (row.dimensions && row.dimensions[k]) || null
    return {
      dimension_key: k,
      score: d?.score ?? null,
      score_reasoning: d?.score_reasoning ?? null,
    }
  }
  return {}
}

// ── Build the regen prompt ───────────────────────────────────
function buildUserPrompt(row: any, section_key: string, oldContent: any, comments: any[], notes: string | null) {
  const label = SECTION_LABEL[section_key] || section_key
  const commentBlock = comments.length
    ? comments.map((c, i) => `[${i + 1}] (${c.kind}) ${c.body}`).join('\n')
    : '(no open comments; use admin notes only)'

  const contextCore = {
    suburb: row.suburb,
    state_code: row.state_code,
    rating: row.rating,
    conviction_score: row.conviction_score,
    thesis_short: row.thesis_short,
    thesis_main: row.thesis_main,
    dimensions: row.dimensions,
    pillars_summary: row.pillars
      ? Object.fromEntries(
          Object.entries(row.pillars).map(([k, v]: any) => [
            k,
            { headline: v?.headline ?? null, status: v?.status ?? null },
          ])
        )
      : null,
    sources_count: Array.isArray(row.sources) ? row.sources.length : 0,
  }

  return `You are revising ONE section of a TPCH suburb research draft. You are NOT producing a full report.

SUBURB: ${row.suburb}, ${row.state_code}

CURRENT FULL-DRAFT CONTEXT (for consistency — do not restate):
${JSON.stringify(contextCore, null, 2)}

SECTION TO REGENERATE: ${label}

CURRENT CONTENT OF THAT SECTION:
${JSON.stringify(oldContent, null, 2)}

ADMIN REVIEW COMMENTS TO ADDRESS:
${commentBlock}

ADMIN FREE-TEXT NOTES:
${notes && notes.trim() ? notes.trim() : '(none)'}

INSTRUCTIONS:
- Rewrite ONLY the fields shown in the "CURRENT CONTENT" block above. Do not touch any other field on the draft.
- If the section is a DIMENSION: treat the admin comments as a direct challenge to the score. DEFEND OR REVISE. Consider the comments and notes honestly against the evidence across the feeding pillars. If the challenge holds up (new data, corrected interpretation, better reading of the existing evidence), MOVE the score (up or down) to reflect the stronger or weaker case, and explain the move in score_reasoning. If the challenge does not hold up against the data, KEEP the score where it is and use score_reasoning to explain why the existing number still stands. Never move the score purely because the admin asked for a higher number; only move it when the evidence warrants. The score must be an integer between 0 and 20 inclusive.
- If the section is counter_view, change only the "response" field. The cited article (source, headline, date, url, excerpt) is fixed.
- If the section is a pillar, you may revise headline and narrative only. Do not touch status, stats, or citation_tags.
- Preserve inline "(Source: Publisher, Date)" citations. If you reference new data, cite a source in the same inline format. Do NOT introduce new URLs that are not already in the draft's sources list unless the admin notes supply one.
- Australian English. No em dashes. No hype jargon. No exclamation marks.

${TONE_RULES}

OUTPUT FORMAT — return ONLY a single JSON object with EXACTLY the keys shown in "CURRENT CONTENT" above, and no other keys. No markdown, no code fences, no commentary.`
}

async function callClaude(userPrompt: string, model = 'claude-opus-4-7') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      system: 'You revise one section of a TPCH suburb research draft. Return only a JSON object matching the exact keys requested. No prose, no code fences.',
      messages: [{ role: 'user', content: userPrompt }],
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Claude API ${res.status}: ${err}`)
  }
  const data = await res.json()
  const textBlocks = (data.content || []).filter((b: any) => b.type === 'text')
  return textBlocks.map((b: any) => b.text).join('\n') || ''
}

function parseJson(raw: string): any {
  const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim()
  try { return JSON.parse(cleaned) } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('Claude response contained no JSON object')
  return JSON.parse(m[0])
}

// Tone/quality guards on the regenerated text.
function scanProse(obj: any): string | null {
  const bad: string[] = []
  const walk = (v: any) => {
    if (typeof v === 'string') bad.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(obj)
  const flat = bad.join('\n')
  if (flat.includes('—')) return 'Contains em dash (—). Hard brand rule: never.'
  if (/<cite[\s>]/i.test(flat)) return 'Contains XML citation tag.'
  const jargonRe = /\b(institutional-?grade|institutional-?quality|blue-?chip|world-?class|once-in-a-generation|unmissable)\b/i
  const m = flat.match(jargonRe)
  if (m) return `Contains banned jargon: "${m[0]}"`
  return null
}

// Apply the patched fields onto the draft row payload (in-memory, typed loosely).
function applyPatch(row: any, section_key: string, patched: any): { patch: Record<string, any>, newContent: Record<string, any> } {
  const patch: Record<string, any> = {}
  const newContent: Record<string, any> = {}

  if (section_key === 'exec_summary') {
    if (typeof patched.thesis_main === 'string') patch.thesis_main = patched.thesis_main
    if (typeof patched.thesis_short === 'string') patch.thesis_short = patched.thesis_short
    newContent.thesis_main = patch.thesis_main ?? row.thesis_main
    newContent.thesis_short = patch.thesis_short ?? row.thesis_short
    return { patch, newContent }
  }
  if (section_key === 'narrative_thesis') {
    if (typeof patched.narrative_thesis === 'string') patch.narrative_thesis = patched.narrative_thesis
    newContent.narrative_thesis = patch.narrative_thesis ?? row.narrative_thesis
    return { patch, newContent }
  }
  if (section_key === 'counter_view') {
    const existing = row.counter_view || {}
    const nextResponse = patched?.counter_view?.response ?? patched?.response
    if (typeof nextResponse === 'string' && nextResponse.trim().length >= 30) {
      patch.counter_view = { ...existing, response: nextResponse }
      newContent.counter_view = patch.counter_view
    } else {
      newContent.counter_view = existing
    }
    return { patch, newContent }
  }
  if (section_key.startsWith('pillar_')) {
    const k = section_key.slice('pillar_'.length)
    const pillars = { ...(row.pillars || {}) }
    const cur = { ...(pillars[k] || {}) }
    if (typeof patched.headline === 'string') cur.headline = patched.headline
    if (typeof patched.narrative === 'string') cur.narrative = patched.narrative
    pillars[k] = cur
    patch.pillars = pillars
    newContent.pillar_key = k
    newContent.headline = cur.headline ?? null
    newContent.narrative = cur.narrative ?? null
    newContent.status = cur.status ?? null
    return { patch, newContent }
  }
  if (section_key.startsWith('dim_')) {
    const k = section_key.slice('dim_'.length)
    const dims = { ...(row.dimensions || {}) }
    const cur = { ...(dims[k] || {}) }
    if (typeof patched.score_reasoning === 'string') cur.score_reasoning = patched.score_reasoning
    // Defend-or-revise: accept a new score if it is a valid integer 0-20.
    // The model is instructed to move it only when the evidence warrants.
    const proposedScore = patched.score
    if (typeof proposedScore === 'number' && Number.isInteger(proposedScore) && proposedScore >= 0 && proposedScore <= 20) {
      cur.score = proposedScore
    }
    dims[k] = cur
    patch.dimensions = dims

    // Recompute conviction_score from the 5 dimensions and rebucket rating.
    const totals = DIMENSION_KEYS.map(dk => {
      const s = dims[dk]?.score
      return typeof s === 'number' ? s : 0
    })
    const sum = totals.reduce((a, b) => a + b, 0)
    patch.conviction_score = sum
    patch.rating = sum >= 80 ? 'Strong Buy'
                 : sum >= 60 ? 'Good Buy'
                 : sum >= 40 ? 'Watch'
                 : 'Caution'

    newContent.dimension_key = k
    newContent.score = cur.score ?? null
    newContent.score_reasoning = cur.score_reasoning ?? null
    newContent.conviction_score = patch.conviction_score
    newContent.rating = patch.rating
    return { patch, newContent }
  }
  return { patch, newContent }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body = await req.json()
    const research_id: string = body.research_id
    const section_key: string = body.section_key
    const notes: string | null = body.notes ?? null
    const comment_ids: string[] | null = Array.isArray(body.comment_ids) ? body.comment_ids : null
    const triggered_by: string = body.triggered_by || 'admin@portal'

    if (!research_id || !section_key) {
      return new Response(JSON.stringify({ error: 'research_id and section_key are required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!NARRATIVE_ALLOWLIST.has(section_key)) {
      return new Response(JSON.stringify({
        error: `section_key "${section_key}" is not regeneratable. Data-driven sections require a full skill re-run. Allowed: ${Array.from(NARRATIVE_ALLOWLIST).join(', ')}`,
      }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Load draft
    const { data: row, error: rowErr } = await sb
      .from('suburb_research')
      .select('*')
      .eq('id', research_id)
      .single()
    if (rowErr || !row) {
      return new Response(JSON.stringify({ error: `Draft not found: ${research_id}` }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Load comments — either the specific ids or all open comments for this section
    let comments: any[] = []
    if (comment_ids && comment_ids.length) {
      const { data: cs } = await sb
        .from('research_section_comments')
        .select('*')
        .in('id', comment_ids)
        .eq('research_id', research_id)
      comments = cs || []
    } else {
      const { data: cs } = await sb
        .from('research_section_comments')
        .select('*')
        .eq('research_id', research_id)
        .eq('section_key', section_key)
        .eq('status', 'open')
        .order('created_at', { ascending: true })
      comments = cs || []
    }

    if (!comments.length && (!notes || !notes.trim())) {
      return new Response(JSON.stringify({ error: 'No open comments and no admin notes — nothing to act on.' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const oldContent = extractOld(section_key, row)

    // Call Claude
    const prompt = buildUserPrompt(row, section_key, oldContent, comments, notes)
    const raw = await callClaude(prompt, 'claude-opus-4-7')
    let parsed: any
    try { parsed = parseJson(raw) } catch (e) {
      return new Response(JSON.stringify({
        error: `Model returned unparseable JSON: ${(e as Error).message}`,
        raw_preview: raw.slice(0, 600),
      }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Guard
    const badProse = scanProse(parsed)
    if (badProse) {
      return new Response(JSON.stringify({
        error: `Regenerated text failed tone check: ${badProse}`,
        preview: parsed,
      }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Apply patch
    const { patch, newContent } = applyPatch(row, section_key, parsed)
    if (!Object.keys(patch).length) {
      return new Response(JSON.stringify({
        error: 'Model did not return any usable fields for this section.',
        preview: parsed,
      }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Update draft
    const { error: upErr } = await sb
      .from('suburb_research')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', research_id)
    if (upErr) throw new Error(`Update failed: ${upErr.message}`)

    // Snapshot new version
    const { data: versRows } = await sb
      .from('research_versions')
      .select('version_number')
      .eq('research_id', research_id)
      .order('version_number', { ascending: false })
      .limit(1)
    const nextVersion = (versRows && versRows[0]?.version_number ? versRows[0].version_number : 0) + 1

    // Reload merged row to snapshot
    const { data: merged } = await sb
      .from('suburb_research')
      .select('*')
      .eq('id', research_id)
      .single()

    const commentsAddressed = comments.map(c => c.id)
    const changeSummary = `Regenerated "${SECTION_LABEL[section_key] || section_key}" via Opus 4.7` +
      (commentsAddressed.length ? ` addressing ${commentsAddressed.length} comment${commentsAddressed.length === 1 ? '' : 's'}` : '') +
      (notes && notes.trim() ? ' with admin notes' : '')

    await sb.from('research_versions').insert({
      research_id,
      version_number: nextVersion,
      snapshot: merged,
      section_key,
      change_summary: changeSummary,
      created_by: triggered_by,
    })

    // Mark linked comments as addressed
    if (commentsAddressed.length) {
      await sb
        .from('research_section_comments')
        .update({ status: 'addressed', updated_at: new Date().toISOString() })
        .in('id', commentsAddressed)
    }

    return new Response(JSON.stringify({
      success: true,
      version_number: nextVersion,
      section_key,
      old: oldContent,
      new: newContent,
      comments_addressed: commentsAddressed,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
