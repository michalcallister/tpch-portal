// ============================================================
// TPCH Stock Portal — Monday.com → Supabase Sync
// Supabase Edge Function: sync-monday
// Deploy: supabase functions deploy sync-monday
//
// Secrets required (set in Supabase Dashboard → Edge Functions → Secrets):
//   MONDAY_API_TOKEN        = your Monday.com API token
//   MONDAY_PROJECTS_BOARD_ID = 2949467206
//   MONDAY_STOCK_BOARD_ID    = 6070412774
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.
//
// Triggers:
//   - HTTP POST/GET (manual "Sync Now" from admin portal)
//   - Cron: set in Supabase Dashboard → Edge Functions → sync-monday → Cron
//     Expression: */15 * * * *  (every 15 minutes)
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const MONDAY_API = 'https://api.monday.com/v2'
const MONDAY_TOKEN        = Deno.env.get('MONDAY_API_TOKEN')!
const PROJECTS_BOARD_ID   = Deno.env.get('MONDAY_PROJECTS_BOARD_ID') || '2949467206'
const STOCK_BOARD_ID      = Deno.env.get('MONDAY_STOCK_BOARD_ID')    || '6070412774'
const DEALS_BOARD_ID      = Deno.env.get('MONDAY_DEALS_BOARD_ID')    || '8393705891'
const CLAUDE_API_KEY      = Deno.env.get('CLAUDE_API_KEY')

// ── Column ID mappings (discovered via API, do not change unless board structure changes) ──

const DEALS_COLS = {
  channelPartner:      'link_to_accounts_mkmvsxv5', // board_relation → Channel Partner firm
  property:            'connect_boards_mkmv6n8r',   // board_relation → Property/Stock item
  clientName:          'text_mm19y1bt',             // text → Client Name
  creationDate:        'deal_creation_date',
  stage:               'deal_stage',                // status
  dealValue:           'deal_value',                // numbers
  cosExecuted:         'date_mkp1dqf',
  developer:           'board_relation_mks2h15x',
  entity:              'dropdown_mkr39hz1',
  expectedApproval:    'date_mkmv91np',
  expectedSettlement:  'deal_expected_close_date',
  fullyPaid:           'deal_close_date',
  paidToDate:          'numeric_mm2d43w',
  daysToClose:         'numeric_mkq2evhg',
}

const PROJECT_COLS = {
  salesStatus:        'status',
  projectStatus:      'status8',
  address:            'location',
  state:              'text',
  region:             'text4',
  suburb:             'text0',
  developmentType:    'status_1',
  propertyType:       'status5',
  levels:             'numbers2',
  totalVolume:        'text7',
  stockToSell:        'numbers8',
  yearConstructed:    'year_constructed',
  estStart:           'date1',
  estFinish:          'date11',
  developer:          'connect_boards4',
  commPaymentTerms:   'text_mm2npnrb',  // "Commission Terms" text column
  commNotes:          'long_text',
  smsfEligible:       'color_mm147z5a',
  brochure:           'link_mm14z0cp',
  heroImage:          'file_mm15b754',
  photos:             'files',
  documents:          'files7',
  video:              'link',
}

const STOCK_COLS = {
  availability:       'color',
  projectLink:        'connect_boards35',  // board_relation → project item ID
  address:            'mirror98',
  developer:          'mirror1',
  developmentType:    'mirror0',
  propertyType:       'color_mm2dxk03',
  titleForecast:      'text_mm2eqpt2',
  suburb:             'dropdown_mm2dqv2t',
  state:              'color_mm148d',
  street:             'text_mm2d8ea6',
  lotNumber:          'text04',
  level:              'text0',
  bedrooms:           'numbers13',
  bathrooms:          'numbers14',
  study:              'numbers191',
  carParks:           'numbers2',
  buildInternal:      'numbers7',
  buildExternal:      'numbers6',
  buildTotal:         'formula5',
  ratePerSqm:         'formula3',
  lotSize:            'numeric28',
  landPrice:          'numbers5',
  buildPrice:         'numbers',
  totalContract:      'formula32',
  stampDuty:          'formula_mm14n1vf',
  costsAllowance:     'numbers19',
  rentPerWeek:        'numbers20',
  occupancyWeeks:     'numbers50',
  annualRent:         'formula2',
  rates:              'numeric3',
  bodyCorporate:      'numeric88',
  insurance:          'numeric59',
  lettingFeesPct:     'numeric23',
  lettingFees:        'formula33',
  maintenance:        'numeric55',
  commPaymentTerms:   'mirror7',
  channelCommTerms:   'text7',
  commPercentage:     'numbers0',
  bonusComm:          'numbers09',
  totalCommPool:      'formula',
  channelCommission:  'formula36',
  channelCommPct:     'numeric_mm14v4wc',  // Channel Commission %
  channelCommFlat:    'numeric_mm14m2g5',  // Channel Commission $
  incentivePct:       'numeric_mm1cef3w',  // Incentive %
  tpchCommission:     'numbers69',
  unconditional:      'dup__of_1st_build_commission',
  settlement:         'numbers04',
  baseStage:          'dup__of_2nd_build_commission',
  frameStage:         'numbers031',
  enclosedStage:      'numbers3',
  practicalCompletion:'numbers9',
  totalCommission:    'formula52',
  floorPlan:          'files',
  hlInclusions:       'long_text_mm2x3w9p',  // House & Land inclusions list
  hlFacade:           'file_mm2xrah9',       // House & Land facade image
  walkthroughVideo:   'file_mm4ba51d',       // Walkthrough video (MP4 file upload)
}

// ── Helpers ──────────────────────────────────────────────────

function getCol(item: any, colId: string): any {
  return item.column_values?.find((c: any) => c.id === colId)
}

function getText(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col) return null
  // display_value for mirror columns, text for everything else
  const t = (col.display_value || col.text)?.trim()
  return t || null
}

function getNum(item: any, colId: string): number | null {
  const col = getCol(item, colId)
  if (!col) return null
  const raw = (col.text || col.display_value || '')
  const t = raw.replace(/[,$\s]/g, '').trim()
  const n = parseFloat(t)
  return isNaN(n) ? null : n
}

function getDate(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col || !col.value) return null
  try {
    const v = JSON.parse(col.value)
    return v.date || null
  } catch { return null }
}

function getLocation(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col) return null
  if (col.text?.trim()) return col.text.trim()
  if (col.value) {
    try {
      const v = JSON.parse(col.value)
      return v.address || null
    } catch {}
  }
  return null
}

// Returns { lat, lng } if the Monday location column has been geocoded.
// Monday stores coords inside the column's JSON value when the user picks
// an address from the dropdown (vs. typing free-text).
function getLocationCoords(item: any, colId: string): { lat: number, lng: number } | null {
  const col = getCol(item, colId)
  if (!col || !col.value) return null
  try {
    const v = JSON.parse(col.value)
    const lat = v.lat != null ? Number(v.lat) : null
    const lng = v.lng != null ? Number(v.lng) : null
    if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) return { lat, lng }
  } catch {}
  return null
}

// Geocode an address via OpenStreetMap Nominatim. Free, no API key, but
// limited to 1 req/sec — caller must rate-limit. Returns null on miss.
async function geocodeAddress(query: string): Promise<{ lat: number, lng: number } | null> {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=au&q=' + encodeURIComponent(query)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'tpch-portal-sync/1.0 (admin@tpch.com.au)' } })
    if (!res.ok) return null
    const arr = await res.json()
    if (!Array.isArray(arr) || !arr.length) return null
    const lat = parseFloat(arr[0].lat), lng = parseFloat(arr[0].lon)
    if (isNaN(lat) || isNaN(lng)) return null
    return { lat, lng }
  } catch {
    return null
  }
}

function getLongText(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col) return null
  if (col.text?.trim()) return col.text.trim()
  if (col.value) {
    try {
      const v = JSON.parse(col.value)
      return v.text || null
    } catch {}
  }
  return null
}


function getBoardRelationIds(item: any, colId: string): string[] {
  const col = getCol(item, colId)
  if (!col) return []
  // Prefer linked_items (reliable in API 2023-10+)
  if (col.linked_items?.length) {
    return col.linked_items.map((i: any) => String(i.id))
  }
  // Fallback: parse value JSON
  if (!col.value) return []
  try {
    const v = JSON.parse(col.value)
    return (v.linkedPulseIds || []).map((p: any) => String(p.linkedPulseId))
  } catch { return [] }
}

function getLink(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col) return null
  if (col.value) {
    try {
      const v = JSON.parse(col.value)
      return v.url || null
    } catch {}
  }
  return col.text?.trim() || null
}

function getBoardRelationNames(item: any, colId: string): string | null {
  const col = getCol(item, colId)
  if (!col) return null
  if (col.linked_items?.length) {
    return col.linked_items.map((i: any) => i.name).filter(Boolean).join(', ') || null
  }
  return col.text?.trim() || null
}

// ── Cost tracking ────────────────────────────────────────────
// Only logs the AI description-generator portion of sync-monday.
// The rest of the sync (Monday.com API, geocoding, image upload) is free.
const MODEL_PRICING: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5-20251001':  { in: 1,  out: 5  },
  'claude-haiku-4-5':           { in: 1,  out: 5  },
  'claude-sonnet-4-6':          { in: 3,  out: 15 },
  'claude-opus-4-7':            { in: 15, out: 75 },
}

const SYNC_AGENT_SLUG = 'sync-monday'

async function logSyncAgentRun(sb: any, opts: {
  model: string
  usage?: { input_tokens?: number; output_tokens?: number } | null
  status?: 'completed' | 'failed'
  startedAt: number
  projectId?: string | null
  errorMessage?: string | null
}) {
  try {
    if (!opts.usage) return
    const inTok  = opts.usage.input_tokens  || 0
    const outTok = opts.usage.output_tokens || 0
    const price  = MODEL_PRICING[opts.model] || { in: 1, out: 5 }
    const cost   = Math.round(inTok * price.in + outTok * price.out)
    const { data: agent } = await sb.from('agents').select('id').eq('slug', SYNC_AGENT_SLUG).single()
    if (!agent) return
    await sb.from('agent_runs').insert({
      agent_id:        agent.id,
      project_id:      opts.projectId || null,
      status:          opts.status || 'completed',
      triggered_by:    'sync-monday-cron',
      started_at:      new Date(opts.startedAt).toISOString(),
      completed_at:    new Date().toISOString(),
      duration_ms:     Date.now() - opts.startedAt,
      model_used:      opts.model,
      input_tokens:    inTok,
      output_tokens:   outTok,
      cost_usd_micros: cost,
      error:           opts.errorMessage || null,
    })
  } catch (_) { /* never block sync on telemetry */ }
}

// ── AI description generator ─────────────────────────────────

async function generateProjectDescription(p: Record<string, any>, sb?: any): Promise<string | null> {
  if (!CLAUDE_API_KEY) return null
  const prompt = `You are a professional property investment analyst writing for an Australian property portal used by financial advisers and buyers agents.

Write a comprehensive investor-focused building description for the following project. Use factual, professional language. No emojis.

PROJECT DETAILS:
Name: ${p.name}
Developer: ${p.developer || 'Not specified'}
Address: ${p.address || 'Not specified'}
Suburb: ${p.suburb || ''}, ${p.state || ''}
Development Type: ${p.development_type || 'Residential'}
Property Type: ${p.property_type || ''}
Total Lots: ${p.total_volume || p.stock_to_sell || 'Not specified'}
Year Constructed / Est. Completion: ${p.year_constructed || p.est_construction_finish || 'Not specified'}

Write the description as clean HTML using only <h3>, <p>, <ul>, <li> tags. Include these sections:

<h3>Overview</h3> — 2-3 paragraphs: building snapshot and investment case.
<h3>Location & Surroundings</h3> — transport links, employment precincts, lifestyle amenities.
<h3>Building Specifications</h3> — scale, developer, completion, target tenant demographics.
<h3>Apartment Features & Amenities</h3> — unit quality, finishes, shared amenities.
<h3>Investment Highlights</h3> — USPs, rental demand, vacancy characteristics, growth drivers.
<h3>Market Conditions</h3> — suburb yields, vacancy trends, capital growth indicators, economic environment.

End with: <p><strong>Summary:</strong> [2-sentence investor blurb]</p>

Return only the HTML content, no preamble or explanation.`

  const startedAt = Date.now()
  const model = 'claude-haiku-4-5-20251001'
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) {
      if (sb) await logSyncAgentRun(sb, { model, startedAt, status: 'failed', projectId: p.id, errorMessage: `Claude API ${res.status}` })
      return null
    }
    const json = await res.json()
    if (sb) await logSyncAgentRun(sb, { model, startedAt, status: 'completed', projectId: p.id, usage: json.usage })
    let text: string = json.content?.[0]?.text || null
    if (text) text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim()
    return text || null
  } catch (e) {
    if (sb) await logSyncAgentRun(sb, { model, startedAt, status: 'failed', projectId: p.id, errorMessage: (e as Error).message })
    return null
  }
}

// ── Monday.com paginated fetch ────────────────────────────────

async function fetchAllItems(boardId: string): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null

  const colIds = boardId === PROJECTS_BOARD_ID
    ? Object.values(PROJECT_COLS)
    : boardId === DEALS_BOARD_ID
    ? Object.values(DEALS_COLS)
    : Object.values(STOCK_COLS)

  // Deduplicate column IDs
  const uniqueColIds = [...new Set(colIds)]

  do {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : ''
    const query = `{
      boards(ids: [${boardId}]) {
        items_page(limit: 500${cursorArg}) {
          cursor
          items {
            id
            name
            updated_at
            assets { id name url public_url }
            column_values(ids: ${JSON.stringify(uniqueColIds)}) {
              id text value
              ... on BoardRelationValue {
                linked_items { id name }
              }
              ... on MirrorValue {
                display_value
              }
              ... on FormulaValue {
                display_value
              }
              ... on LongTextValue {
                text
              }
              ... on DropdownValue {
                text
              }
              ... on FileValue {
                files {
                  ... on FileAssetValue {
                    asset_id
                    name
                    asset { id url public_url }
                  }
                }
              }
            }
          }
        }
      }
    }`

    let res: Response | null = null
    let lastStatus = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const wait = attempt * 5000 // 5s, 10s, 15s
        console.log(`Rate limited (429), waiting ${wait / 1000}s before retry ${attempt}...`)
        await new Promise(r => setTimeout(r, wait))
      }
      res = await fetch(MONDAY_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': MONDAY_TOKEN,
          'API-Version': '2023-10',
        },
        body: JSON.stringify({ query }),
      })
      lastStatus = res.status
      if (res.status !== 429) break
    }

    if (!res || !res.ok) throw new Error(`Monday.com API error: ${lastStatus} after retries`)

    const json = await res.json()
    if (json.errors) throw new Error(`Monday.com GraphQL error: ${JSON.stringify(json.errors)}`)

    const page = json.data?.boards?.[0]?.items_page
    if (!page) throw new Error('Unexpected Monday.com response structure')

    all.push(...page.items)
    cursor = page.cursor || null
  } while (cursor)

  return all
}

// ── Map Monday.com items to Supabase rows ─────────────────────

function mapDeal(item: any): Record<string, any> {
  return {
    id:                       String(item.id),
    name:                     item.name,
    channel_partner_name:     getBoardRelationNames(item, DEALS_COLS.channelPartner),
    property_id:              getBoardRelationIds(item, DEALS_COLS.property)[0] || null,
    property_name:            getBoardRelationNames(item, DEALS_COLS.property),
    client_name:              getText(item, DEALS_COLS.clientName),
    stage:                    getText(item, DEALS_COLS.stage),
    deal_value:               getNum(item, DEALS_COLS.dealValue),
    cos_executed_date:        getDate(item, DEALS_COLS.cosExecuted),
    expected_approval_date:   getDate(item, DEALS_COLS.expectedApproval),
    expected_settlement_date: getDate(item, DEALS_COLS.expectedSettlement),
    fully_paid_date:          getDate(item, DEALS_COLS.fullyPaid),
    paid_to_date:             getNum(item, DEALS_COLS.paidToDate),
    deal_creation_date:       getDate(item, DEALS_COLS.creationDate),
    developer:                getBoardRelationNames(item, DEALS_COLS.developer),
    entity:                   getText(item, DEALS_COLS.entity),
    days_to_close:            getNum(item, DEALS_COLS.daysToClose),
    last_synced_at:           new Date().toISOString(),
  }
}

function mapProject(item: any): Record<string, any> {
  const videoText = getText(item, PROJECT_COLS.video)
  // Pull lat/lng from Monday's location column if present. Geocoding fallback
  // happens later (after upsert) so we don't slow down the per-row mapper.
  const coords = getLocationCoords(item, PROJECT_COLS.address)

  return {
    id:                       String(item.id),
    name:                     item.name,
    sales_status:             getText(item, PROJECT_COLS.salesStatus),
    project_status:           getText(item, PROJECT_COLS.projectStatus),
    address:                  getLocation(item, PROJECT_COLS.address),
    state:                    getText(item, PROJECT_COLS.state),
    region:                   getText(item, PROJECT_COLS.region),
    suburb:                   getText(item, PROJECT_COLS.suburb),
    development_type:         getText(item, PROJECT_COLS.developmentType),
    property_type:            getText(item, PROJECT_COLS.propertyType),
    levels:                   getNum(item, PROJECT_COLS.levels),
    total_volume:             getNum(item, PROJECT_COLS.totalVolume),
    stock_to_sell:            getNum(item, PROJECT_COLS.stockToSell),
    year_constructed:         getText(item, PROJECT_COLS.yearConstructed),
    est_construction_start:   getDate(item, PROJECT_COLS.estStart),
    est_construction_finish:  getDate(item, PROJECT_COLS.estFinish),
    developer:                getBoardRelationNames(item, PROJECT_COLS.developer),
    commission_payment_terms: getText(item, PROJECT_COLS.commPaymentTerms),
    commission_notes:         getLongText(item, PROJECT_COLS.commNotes),
    smsf_eligible:            getText(item, PROJECT_COLS.smsfEligible)?.toLowerCase() === 'yes',
    // Only emit lat/lng when Monday gave us coords — leaving them out of the
    // upsert object preserves any value that already exists (e.g. set by
    // Nominatim fallback below or admin edit) and avoids clobbering it.
    ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
    // photo_urls managed separately in step 1b via Supabase Storage
    document_urls:            [getLink(item, PROJECT_COLS.brochure)].filter(Boolean) as string[] || null,
    video_urls:               videoText ? [videoText] : null,
    last_synced_at:           new Date().toISOString(),
  }
}

function mapStock(item: any, projectNameMap: Record<string, string>, projectDataMap: Record<string, any>): Record<string, any> {
  const projectIds   = getBoardRelationIds(item, STOCK_COLS.projectLink)
  const projectId    = projectIds[0] || null
  const project      = projectId ? projectDataMap[projectId] : null
  const channelTerms = getText(item, STOCK_COLS.channelCommTerms) || ''
  const smsfEligible = channelTerms.toLowerCase().includes('smsf') || project?.smsf_eligible === true

  // Source number columns (reliable)
  const landPrice      = getNum(item, STOCK_COLS.landPrice)
  const buildPrice     = getNum(item, STOCK_COLS.buildPrice)
  const buildInternal  = getNum(item, STOCK_COLS.buildInternal)
  const buildExternal  = getNum(item, STOCK_COLS.buildExternal)
  const rentPerWeek    = getNum(item, STOCK_COLS.rentPerWeek)
  const occupancyWeeks = getNum(item, STOCK_COLS.occupancyWeeks)
  const commPercentage = getNum(item, STOCK_COLS.commPercentage)

  // Formula columns — computed fallbacks when API returns empty
  const buildTotal     = getNum(item, STOCK_COLS.buildTotal)
                      ?? (buildInternal != null && buildExternal != null ? buildInternal + buildExternal : buildInternal ?? buildExternal ?? null)
  const totalContract  = getNum(item, STOCK_COLS.totalContract)
                      ?? (landPrice != null && buildPrice != null ? landPrice + buildPrice : landPrice ?? buildPrice ?? null)
  const ratePerSqm     = getNum(item, STOCK_COLS.ratePerSqm)
                      ?? (totalContract != null && buildTotal != null && buildTotal > 0 ? Math.round(totalContract / buildTotal) : null)
  const annualRent     = getNum(item, STOCK_COLS.annualRent)
                      ?? (rentPerWeek != null && occupancyWeeks != null ? Math.round(rentPerWeek * occupancyWeeks) : null)
  const channelComm    = getNum(item, STOCK_COLS.channelCommission)
                      ?? (totalContract != null && commPercentage != null ? Math.round(totalContract * commPercentage / 100) : null)
  const lettingFeesPct = getNum(item, STOCK_COLS.lettingFeesPct)
  const lettingFees    = getNum(item, STOCK_COLS.lettingFees)
                      ?? (annualRent != null && lettingFeesPct != null ? Math.round(annualRent * lettingFeesPct / 100 + 800) : null)

  const stampDuty      = getNum(item, STOCK_COLS.stampDuty)  // fallback computed at portal level

  // Mirror columns — fall back to project data when API returns empty
  const developmentType  = getText(item, STOCK_COLS.developmentType)  || project?.development_type  || null
  const propertyType     = getText(item, STOCK_COLS.propertyType)      || developmentType            || null
  const address          = getText(item, STOCK_COLS.address)           || project?.address           || null
  const commPaymentTerms = getText(item, STOCK_COLS.commPaymentTerms)  || project?.commission_payment_terms || null

  return {
    id:                     String(item.id),
    name:                   item.name,
    project_id:             projectId,
    project_name:           projectId ? (projectNameMap[projectId] || null) : null,
    availability:           getText(item, STOCK_COLS.availability),
    address,
    developer:              getText(item, STOCK_COLS.developer),
    development_type:       developmentType,
    property_type:          propertyType,
    suburb:                 getText(item, STOCK_COLS.suburb),
    state:                  getText(item, STOCK_COLS.state),
    street:                 getText(item, STOCK_COLS.street),
    lot_number:             getText(item, STOCK_COLS.lotNumber),
    title_forecast:         getText(item, STOCK_COLS.titleForecast),
    level:                  getNum(item, STOCK_COLS.level),
    bedrooms:               getNum(item, STOCK_COLS.bedrooms),
    bathrooms:              getNum(item, STOCK_COLS.bathrooms),
    study:                  getNum(item, STOCK_COLS.study),
    car_parks:              getNum(item, STOCK_COLS.carParks),
    build_internal_sqm:     buildInternal,
    build_external_sqm:     buildExternal,
    build_total_sqm:        buildTotal,
    rate_per_sqm:           ratePerSqm,
    lot_size_sqm:           getNum(item, STOCK_COLS.lotSize),
    land_price:             landPrice,
    build_price:            buildPrice,
    total_contract:         totalContract,
    stamp_duty_estimate:    stampDuty,
    rent_per_week:          rentPerWeek,
    annual_rent:            annualRent,
    occupancy_weeks:        occupancyWeeks,
    rates_annual:           getNum(item, STOCK_COLS.rates),
    body_corporate_annual:  getNum(item, STOCK_COLS.bodyCorporate),
    insurance_annual:       getNum(item, STOCK_COLS.insurance),
    letting_fees_annual:    lettingFees,
    maintenance_annual:     getNum(item, STOCK_COLS.maintenance),
    comm_payment_terms:     commPaymentTerms,
    channel_comm_terms:     channelTerms || null,
    comm_percentage:        commPercentage,
    bonus_comm:             getNum(item, STOCK_COLS.bonusComm),
    total_comm_pool:        getNum(item, STOCK_COLS.totalCommPool),
    channel_commission:     channelComm,
    channel_comm_pct:       getNum(item, STOCK_COLS.channelCommPct),
    channel_comm_flat:      getNum(item, STOCK_COLS.channelCommFlat),
    incentive_pct:          getNum(item, STOCK_COLS.incentivePct),
    tpch_commission:        getNum(item, STOCK_COLS.tpchCommission),
    unconditional_comm:     getNum(item, STOCK_COLS.unconditional),
    settlement_comm:        getNum(item, STOCK_COLS.settlement),
    base_stage_comm:        getNum(item, STOCK_COLS.baseStage),
    frame_stage_comm:       getNum(item, STOCK_COLS.frameStage),
    enclosed_stage_comm:    getNum(item, STOCK_COLS.enclosedStage),
    pc_stage_comm:          getNum(item, STOCK_COLS.practicalCompletion),
    smsf_eligible:          smsfEligible,
    hl_inclusions:          getLongText(item, STOCK_COLS.hlInclusions),
    // floor_plan_url and hl_facade_url are set separately in step 2b via Supabase Storage upload
    last_synced_at:         new Date().toISOString(),
  }
}

// ── Main sync ─────────────────────────────────────────────────

async function runSync(): Promise<{ projects: number; stock: number; deals: number; errors: string[] }> {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )

  const errors: string[] = []

  // 1. Fetch & upsert Projects
  console.log('Fetching projects from Monday.com...')
  const projectItems = await fetchAllItems(PROJECTS_BOARD_ID)
  console.log(`Fetched ${projectItems.length} project items`)

  const projectRows = projectItems.map(mapProject)
  const projectNameMap: Record<string, string> = {}
  projectItems.forEach(item => { projectNameMap[String(item.id)] = item.name })
  const projectDataMap: Record<string, any> = {}
  projectRows.forEach(p => { projectDataMap[String(p.id)] = p })

  // Pre-fetch existing project IDs so we can emit new_project events to
  // stock_events (powers the dashboard's Stock Radar feed).
  const incomingProjectIds = projectRows.map(p => String(p.id))
  const { data: existingProjectRows } = await supabase
    .from('projects').select('id').in('id', incomingProjectIds)
  const existingProjectIds = new Set((existingProjectRows || []).map((p: any) => p.id))

  // Upsert in batches of 100
  let projectCount = 0
  for (let i = 0; i < projectRows.length; i += 100) {
    const batch = projectRows.slice(i, i + 100)
    const { error } = await supabase
      .from('projects')
      .upsert(batch, { onConflict: 'id' })
    if (error) {
      errors.push(`Projects batch ${i / 100 + 1}: ${error.message}`)
      console.error('Project upsert error:', error)
    } else {
      projectCount += batch.length
    }
  }

  // 1c. Emit new_project events for projects we hadn't seen before this sync.
  const newProjectEvents = projectRows
    .filter(p => !existingProjectIds.has(p.id))
    .map(p => ({
      event_type: 'new_project',
      project_id: p.id,
      severity: 'high',
      payload: { name: p.name, suburb: p.suburb, state: p.state },
    }))
  if (newProjectEvents.length) {
    const { error } = await supabase.from('stock_events').insert(newProjectEvents)
    if (error) errors.push(`Stock events (new_project): ${error.message}`)
    else console.log(`Recorded ${newProjectEvents.length} new_project event(s)`)
  }

  // 1a. Geocode any project that has an address but still no coords.
  // Uses Nominatim (1 req/sec) and only patches latitude/longitude so any
  // other admin-edited fields are untouched. Failures are logged, not fatal.
  try {
    const { data: needsGeocode } = await supabase
      .from('projects')
      .select('id, name, suburb, state, address, latitude, longitude')
      .is('latitude', null)
    const candidates = (needsGeocode || []).filter(p => p.address || p.suburb || p.state)
    if (candidates.length > 0) {
      console.log(`Geocoding ${candidates.length} project(s) without coords via Nominatim`)
      let geocodedCount = 0
      for (const p of candidates) {
        const query = (p.address && p.address.trim())
          || ([p.suburb, p.state].filter(Boolean).join(', ') + ', Australia')
        const coords = await geocodeAddress(query)
        if (coords) {
          const { error: patchErr } = await supabase
            .from('projects')
            .update({ latitude: coords.lat, longitude: coords.lng })
            .eq('id', p.id)
          if (patchErr) {
            console.error(`Geocode PATCH ${p.name} failed:`, patchErr.message)
          } else {
            geocodedCount++
          }
        } else {
          console.log(`Geocode miss for ${p.name} (${query})`)
        }
        // Nominatim usage policy: max 1 req/sec
        await new Promise(r => setTimeout(r, 1100))
      }
      console.log(`Geocoded ${geocodedCount}/${candidates.length} project(s)`)
    }
  } catch (e) {
    console.error('Geocode pass failed:', e)
    errors.push(`Geocode: ${(e as Error).message}`)
  }

  // 1b. Download & store project assets → Supabase Storage
  // FileValue fragment gives us assetId per column so we can separate hero vs gallery.
  // public_url is CDN (no auth); url needs Authorization header.
  const IMAGE_EXTS = new Set(['jpg','jpeg','png','webp','gif'])

  // Batch-check which projects already have hero_image_url stored
  const allProjectIds = projectItems.map(i => String(i.id))
  const { data: heroStored } = await supabase
    .from('projects').select('id').in('id', allProjectIds).not('hero_image_url', 'is', null)
  const heroStoredSet = new Set((heroStored || []).map((r: any) => r.id))

  async function downloadAsset(asset: any, itemName: string, label: string): Promise<ArrayBuffer | null> {
    let res: Response | null = null
    // Try CDN URL without auth first (item.assets public_url), then auth URL
    if (asset.public_url) { res = await fetch(asset.public_url); if (!res.ok) res = null }
    if (!res && asset.url) { res = await fetch(asset.url, { headers: { 'Authorization': MONDAY_TOKEN } }); if (!res.ok) res = null }
    if (!res) { errors.push(`${label} download failed: ${itemName} (no URL)`); return null }
    return res.arrayBuffer()
  }

  for (const item of projectItems) {
    const projectId = String(item.id)
    // FileAssetValue now provides asset_id, name, url directly — no assetMap needed

    // ── Hero image ──────────────────────────────────────────────────
    if (!heroStoredSet.has(projectId)) {
      const heroCol   = getCol(item, PROJECT_COLS.heroImage)
      const heroFiles = (heroCol?.files || []).filter((f: any) => f.asset_id && f.asset)
      if (heroFiles.length > 0) {
        const f = heroFiles[0]
        try {
          const bytes = await downloadAsset({ name: f.name, url: f.asset.url, public_url: f.asset.public_url }, item.name, 'Hero image')
          if (bytes) {
            const ext  = (f.name?.split('.').pop() || 'jpg').toLowerCase()
            const path = `projects/${projectId}/hero.${ext}`
            const { error: upErr } = await supabase.storage.from('project-images').upload(path, bytes, { upsert: true, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` })
            if (upErr) { errors.push(`Hero image upload failed: ${item.name}: ${upErr.message}`) }
            else {
              const { data: urlData } = supabase.storage.from('project-images').getPublicUrl(path)
              await supabase.from('projects').update({ hero_image_url: urlData.publicUrl }).eq('id', projectId)
              console.log(`Hero image stored for ${item.name}`)
            }
          }
        } catch (e: any) { errors.push(`Hero image error: ${item.name}: ${e.message}`) }
      }
    }

    // ── Gallery photos ──────────────────────────────────────────────
    const photosCol    = getCol(item, PROJECT_COLS.photos)
    const galleryFiles = (photosCol?.files || []).filter((f: any) =>
      f.asset_id && f.asset && IMAGE_EXTS.has((f.name?.split('.').pop() || '').toLowerCase())
    )
    if (galleryFiles.length === 0) continue

    const { data: existing } = await supabase.from('projects').select('photo_urls').eq('id', projectId).single()
    if ((existing?.photo_urls?.length || 0) === galleryFiles.length) continue // already up to date

    const storedUrls: string[] = []
    for (let i = 0; i < galleryFiles.length; i++) {
      const f = galleryFiles[i]
      try {
        const bytes = await downloadAsset({ name: f.name, url: f.asset.url, public_url: f.asset.public_url }, item.name, `Gallery #${i}`)
        if (!bytes) continue
        const ext  = (f.name?.split('.').pop() || 'jpg').toLowerCase()
        const path = `projects/${projectId}/image-${i}.${ext}`
        const { error: upErr } = await supabase.storage.from('project-images').upload(path, bytes, { upsert: true, contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` })
        if (upErr) { errors.push(`Gallery image upload failed: ${item.name} #${i}: ${upErr.message}`); continue }
        const { data: urlData } = supabase.storage.from('project-images').getPublicUrl(path)
        storedUrls.push(urlData.publicUrl)
      } catch (e: any) { errors.push(`Gallery image error: ${item.name} #${i}: ${e.message}`) }
    }
    if (storedUrls.length) {
      await supabase.from('projects').update({ photo_urls: storedUrls }).eq('id', projectId)
      console.log(`Stored ${storedUrls.length} gallery images for ${item.name}`)
    }
  }

  // 2. Fetch & upsert Stock
  console.log('Fetching stock from Monday.com...')
  const stockItems = await fetchAllItems(STOCK_BOARD_ID)
  console.log(`Fetched ${stockItems.length} stock items`)

  const stockRows = stockItems.map(item => mapStock(item, projectNameMap, projectDataMap))

  // Walkthrough-video keep policy — used by the cleanup pass (2d, below) and the
  // upload pass (2e, which runs LAST so the heavy video streaming can't starve
  // the rest of the sync of its 150s budget). A video is kept only while the
  // property is shown in the portal (Available / Reserved).
  const KEEP_VIDEO_STATUSES = new Set(['Available', 'Reserved'])
  const availById = new Map(stockRows.map((r: any) => [String(r.id), r.availability]))

  // Pre-fetch existing stock so we can detect price/status/new-lot deltas
  // and emit stock_events. Threshold: ignore price changes <1% (rounding noise).
  const incomingStockIds = stockRows.map(s => String(s.id))
  const { data: existingStockRows } = await supabase
    .from('stock')
    .select('id, total_contract, availability, project_id, name')
    .in('id', incomingStockIds)
  const existingStockMap = new Map(
    (existingStockRows || []).map((s: any) => [s.id, s])
  )

  let stockCount = 0
  for (let i = 0; i < stockRows.length; i += 100) {
    const batch = stockRows.slice(i, i + 100)
    const { error } = await supabase
      .from('stock')
      .upsert(batch, { onConflict: 'id' })
    if (error) {
      errors.push(`Stock batch ${i / 100 + 1}: ${error.message}`)
      console.error('Stock upsert error:', error)
    } else {
      stockCount += batch.length
    }
  }

  // 2a. Derive stock_events from the diff between existing and incoming.
  //     - new_lot: stock id not seen before AND its project already existed
  //                (new stock under a brand-new project is implied by the
  //                project event above — don't double-fire).
  //     - price_drop / price_rise: total_contract delta ≥ 1%.
  //     - sold:    availability flipped TO Sold.
  //     - status_change: any other availability flip (Available ↔ Reserved etc.).
  const PRICE_DELTA_PCT_MIN = 1.0
  const stockEvents: Record<string, any>[] = []
  for (const row of stockRows) {
    const prev = existingStockMap.get(row.id) as any
    if (!prev) {
      if (row.project_id && existingProjectIds.has(row.project_id)) {
        stockEvents.push({
          event_type: 'new_lot',
          stock_id:   row.id,
          project_id: row.project_id,
          severity:   'high',
          payload: {
            name:         row.name,
            project_name: row.project_name,
            price:        row.total_contract,
          },
        })
      }
      continue
    }

    const prevPrice = prev.total_contract != null ? Number(prev.total_contract) : null
    const newPrice  = row.total_contract  != null ? Number(row.total_contract)  : null
    if (prevPrice != null && newPrice != null && prevPrice > 0 && prevPrice !== newPrice) {
      const delta = newPrice - prevPrice
      const pct   = (delta / prevPrice) * 100
      if (Math.abs(pct) >= PRICE_DELTA_PCT_MIN) {
        stockEvents.push({
          event_type: pct < 0 ? 'price_drop' : 'price_rise',
          stock_id:   row.id,
          project_id: row.project_id,
          severity:   'high',
          payload: {
            name:      row.name,
            old_price: prevPrice,
            new_price: newPrice,
            delta,
            pct:       Math.round(pct * 10) / 10,
          },
        })
      }
    }

    if (prev.availability !== row.availability && row.availability) {
      const wentToSold = row.availability === 'Sold'
      stockEvents.push({
        event_type: wentToSold ? 'sold' : 'status_change',
        stock_id:   row.id,
        project_id: row.project_id,
        severity:   wentToSold || prev.availability === 'Sold' ? 'high' : 'med',
        payload: {
          name:       row.name,
          old_status: prev.availability,
          new_status: row.availability,
        },
      })
    }
  }

  if (stockEvents.length) {
    for (let i = 0; i < stockEvents.length; i += 100) {
      const batch = stockEvents.slice(i, i + 100)
      const { error } = await supabase.from('stock_events').insert(batch)
      if (error) errors.push(`Stock events (stock): ${error.message}`)
    }
    console.log(`Recorded ${stockEvents.length} stock event(s)`)
  }

  // 2a2. Geocode H&L stock addresses for the lot-level map view.
  // Apartments / townhouses share a project-level pin and don't need
  // per-lot coords. Same Nominatim throttle as the project pass (1 req/sec).
  try {
    const { data: needsStockGeocode } = await supabase
      .from('stock')
      .select('id, name, street, suburb, state, development_type')
      .is('latitude', null)
    const hlCandidates = (needsStockGeocode || []).filter((s: any) => {
      const t = String(s.development_type || '').toLowerCase()
      if (t.includes('townhouse') || t.includes('apartment')) return false
      if (!(t.includes('house') || t.includes('land') || t === 'h&l')) return false
      return s.street && s.street.trim()
    })
    if (hlCandidates.length > 0) {
      console.log(`Geocoding ${hlCandidates.length} H&L stock item(s) via Nominatim`)
      let geocodedCount = 0
      for (const s of hlCandidates) {
        const query = [s.street, s.suburb, s.state, 'Australia'].filter(Boolean).join(', ')
        const coords = await geocodeAddress(query)
        if (coords) {
          const { error: patchErr } = await supabase
            .from('stock')
            .update({ latitude: coords.lat, longitude: coords.lng })
            .eq('id', s.id)
          if (patchErr) console.error(`Stock geocode PATCH ${s.name} failed:`, patchErr.message)
          else geocodedCount++
        } else {
          console.log(`Stock geocode miss for ${s.name} (${query})`)
        }
        await new Promise(r => setTimeout(r, 1100))
      }
      console.log(`Geocoded ${geocodedCount}/${hlCandidates.length} H&L stock item(s)`)
    }
  } catch (e) {
    console.error('Stock geocode pass failed:', e)
    errors.push(`Stock geocode: ${(e as Error).message}`)
  }

  // 2b. Download & store stock file-column assets → Supabase Storage.
  // Each file column on the Property board (Floor Plan, HL Facade) is
  // synced into its own bucket. Per-column lookup means we don't rely on
  // item.assets[0] — that's brittle when an item has multiple file columns.
  //
  // Change-detection uses Monday's asset_id: we store the last-uploaded
  // asset_id on the stock row and only re-upload when it differs. The
  // storage path is versioned with the asset_id so the public URL changes
  // on swap and no CDN / browser cache ever serves the old file.
  // Per-cycle cap so each sync stays under the edge-function timeout.
  // Items not processed this cycle are picked up by the next cron run
  // (already-uploaded ones are skipped via asset_id match).
  const MAX_FILE_UPLOADS_PER_SPEC = 30
  const STOCK_FILE_SPECS = [
    { colId: STOCK_COLS.floorPlan, bucket: 'floor-plans', fileName: 'floor-plan', dbColumn: 'floor_plan_url', dbAssetCol: 'floor_plan_asset_id' },
    { colId: STOCK_COLS.hlFacade,  bucket: 'hl-facades',  fileName: 'hl-facade',  dbColumn: 'hl_facade_url',  dbAssetCol: 'hl_facade_asset_id'  },
  ] as const
  for (const spec of STOCK_FILE_SPECS) {
    const candidates = stockItems.filter(item => {
      const col = item.column_values?.find((c: any) => c.id === spec.colId)
      return col?.files?.length > 0
    })
    if (!candidates.length) continue

    // Prioritise the most-recently-edited items so a user who just swapped a
    // floor plan in Monday sees it propagate on the very next sync cycle.
    candidates.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))

    const ids = candidates.map(i => String(i.id))
    const { data: assetRows } = await supabase
      .from('stock')
      .select(`id, ${spec.dbColumn}, ${spec.dbAssetCol}`)
      .in('id', ids)
    const assetMap = new Map(
      (assetRows || []).map((r: any) => [r.id, { url: r[spec.dbColumn], assetId: r[spec.dbAssetCol] }])
    )

    let uploadedThisSpec = 0
    for (const item of candidates) {
      const stockId = String(item.id)
      try {
        const col   = item.column_values.find((c: any) => c.id === spec.colId)
        const file  = col.files[0]
        const asset = file.asset || {}
        const mondayAssetId = file.asset_id ? String(file.asset_id) : (asset.id ? String(asset.id) : null)
        if (!mondayAssetId) { errors.push(`${spec.fileName} skipped (no asset_id): ${item.name}`); continue }

        const stored = assetMap.get(stockId)
        if (stored?.assetId === mondayAssetId && stored?.url) continue
        if (uploadedThisSpec >= MAX_FILE_UPLOADS_PER_SPEC) break

        const fileName = file.name || asset.name || `${spec.fileName}-asset`

        // public_url is a CDN link — no auth header (auth header causes 400).
        // url is Monday.com's authenticated endpoint — needs auth header.
        let res: Response | null = null
        if (asset.public_url) {
          res = await fetch(asset.public_url)
          if (!res.ok) res = null
        }
        if (!res && asset.url) {
          res = await fetch(asset.url, { headers: { 'Authorization': MONDAY_TOKEN } })
        }
        if (!res || !res.ok) { errors.push(`${spec.fileName} download failed: ${item.name} (${res?.status ?? 'no URL'})`); continue }

        const bytes = await res.arrayBuffer()
        const ext   = (fileName.split('.').pop() || 'jpg').toLowerCase()
        const mime  = ext === 'pdf' ? 'application/pdf' : `image/${ext}`
        // Version the path with the Monday asset_id so swapping the file
        // produces a brand-new URL and bypasses any caching.
        const path  = `stock/${stockId}/${spec.fileName}-${mondayAssetId}.${ext}`

        const { error: upErr } = await supabase.storage
          .from(spec.bucket).upload(path, bytes, { upsert: true, contentType: mime })
        if (upErr) { errors.push(`${spec.fileName} upload failed: ${item.name}: ${upErr.message}`); continue }

        const { data: urlData } = supabase.storage.from(spec.bucket).getPublicUrl(path)
        await supabase.from('stock').update({
          [spec.dbColumn]:   urlData.publicUrl,
          [spec.dbAssetCol]: mondayAssetId,
        }).eq('id', stockId)
        uploadedThisSpec++
        console.log(`${spec.fileName} stored for ${item.name}: ${urlData.publicUrl}`)
      } catch (e: any) {
        errors.push(`${spec.fileName} error for ${item.name}: ${e.message}`)
      }
    }
    if (uploadedThisSpec > 0) console.log(`${spec.fileName}: uploaded ${uploadedThisSpec} this cycle`)
  }

  // 2c. Walkthrough videos → property-videos bucket (STREAMED).
  // Videos are too large to buffer (a big MP4 arrayBuffer OOMs the worker —
  // WORKER_RESOURCE_LIMIT), so we pipe Monday's download straight into Storage's
  // REST endpoint as a stream. Auth mirrors supabase-js exactly: the service key
  // goes in BOTH the apikey and Authorization headers (a bare Authorization is
  // rejected as "Invalid Compact JWS" under the new key format). duplex:'half'
  // is required by Deno for a ReadableStream body. Same asset_id change-detection
  // + asset-versioned path as the image specs.
  const MAX_VIDEO_UPLOADS_PER_CYCLE = 3
  const MAX_VIDEO_BYTES = 500 * 1024 * 1024 // 500 MB — matches the bucket limit
  const VIDEO_MIME: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
    webm: 'video/webm', '3gp': 'video/3gpp',
  }
  // Defined here but EXECUTED LAST (via EdgeRuntime.waitUntil at the end of
  // runSync) so the heavy video streaming runs in the background — after the
  // sync response has returned and projects/stock/deals have committed. This
  // keeps a 300 MB+ upload from blowing the 150s request budget.
  const runWalkthroughUploads = async () => {
    const SUPABASE_URL_ENV = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY      = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const VIDEO_BUCKET     = 'property-videos'

    const candidates = stockItems.filter(item => {
      const col = item.column_values?.find((c: any) => c.id === STOCK_COLS.walkthroughVideo)
      if (!(col?.files?.length > 0)) return false
      // Don't upload for properties that aren't shown — step 2d would only delete it.
      return KEEP_VIDEO_STATUSES.has(availById.get(String(item.id)))
    })
    if (candidates.length) {
      // Most-recently-edited first so a freshly-uploaded video propagates on the
      // very next cycle even when more candidates exist than the per-cycle cap.
      candidates.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))

      const ids = candidates.map(i => String(i.id))
      const { data: assetRows } = await supabase
        .from('stock')
        .select('id, walkthrough_video_url, walkthrough_video_asset_id')
        .in('id', ids)
      const assetMap = new Map(
        (assetRows || []).map((r: any) => [r.id, { url: r.walkthrough_video_url, assetId: r.walkthrough_video_asset_id }])
      )

      let uploaded = 0
      for (const item of candidates) {
        const stockId = String(item.id)
        try {
          const col   = item.column_values.find((c: any) => c.id === STOCK_COLS.walkthroughVideo)
          const file  = col.files[0]
          const asset = file.asset || {}
          const mondayAssetId = file.asset_id ? String(file.asset_id) : (asset.id ? String(asset.id) : null)
          if (!mondayAssetId) { errors.push(`walkthrough skipped (no asset_id): ${item.name}`); continue }

          const stored = assetMap.get(stockId)
          if (stored?.assetId === mondayAssetId && stored?.url) continue
          if (uploaded >= MAX_VIDEO_UPLOADS_PER_CYCLE) break

          const fileName = file.name || asset.name || 'walkthrough'
          const ext  = (fileName.split('.').pop() || 'mp4').toLowerCase()
          const mime = VIDEO_MIME[ext] || 'video/mp4'

          // Download (stream) from Monday — public_url (CDN, no auth) first, auth URL fallback.
          let res: Response | null = null
          if (asset.public_url) { res = await fetch(asset.public_url); if (!res.ok) res = null }
          if (!res && asset.url)  { res = await fetch(asset.url, { headers: { 'Authorization': MONDAY_TOKEN } }) }
          if (!res || !res.ok || !res.body) { errors.push(`walkthrough download failed: ${item.name} (${res?.status ?? 'no URL'})`); continue }

          const lenHeader = Number(res.headers.get('content-length') || 0)
          if (lenHeader && lenHeader > MAX_VIDEO_BYTES) {
            errors.push(`walkthrough too large (${Math.round(lenHeader / 1048576)}MB > 500MB), skipped: ${item.name}`)
            continue
          }

          // Version path with asset_id so a swapped video yields a fresh URL.
          const path = `stock/${stockId}/walkthrough-${mondayAssetId}.${ext}`
          const putRes = await fetch(`${SUPABASE_URL_ENV}/storage/v1/object/${VIDEO_BUCKET}/${path}`, {
            method: 'POST',
            headers: {
              'apikey':        SERVICE_KEY,
              'Authorization': `Bearer ${SERVICE_KEY}`,
              'Content-Type':  mime,
              'x-upsert':      'true',
              ...(lenHeader ? { 'Content-Length': String(lenHeader) } : {}),
            },
            body: res.body,
            duplex: 'half',
          } as RequestInit)
          if (!putRes.ok) {
            errors.push(`walkthrough upload failed: ${item.name}: ${putRes.status} ${await putRes.text().catch(() => '')}`)
            continue
          }

          const { data: urlData } = supabase.storage.from(VIDEO_BUCKET).getPublicUrl(path)
          await supabase.from('stock').update({
            walkthrough_video_url:      urlData.publicUrl,
            walkthrough_video_asset_id: mondayAssetId,
          }).eq('id', stockId)
          // Swap cleanup: delete the previous (now-superseded) video file so a
          // re-uploaded walkthrough doesn't leave the old one orphaned in storage.
          if (stored?.url) {
            const om = String(stored.url).match(/\/property-videos\/(.+)$/)
            const oldPath = om ? decodeURIComponent(om[1].split('?')[0]) : null
            if (oldPath && oldPath !== path) await supabase.storage.from(VIDEO_BUCKET).remove([oldPath])
          }
          uploaded++
          console.log(`walkthrough stored for ${item.name}: ${urlData.publicUrl}`)
        } catch (e: any) {
          errors.push(`walkthrough error for ${item.name}: ${e.message}`)
        }
      }
      if (uploaded > 0) console.log(`walkthrough: uploaded ${uploaded} this cycle`)
    }
  };

  // 2d. Video cleanup — remove stored walkthroughs that should no longer exist:
  // property no longer shown (availability left Available/Reserved), the video was
  // removed from the Monday column, or the stock item is gone. Videos are large,
  // so this is the main lever for keeping storage usage (and cost) down.
  try {
    const VIDEO_BUCKET = 'property-videos'
    const hasVideoFile = new Map(
      stockItems.map((it: any) => {
        const col = it.column_values?.find((c: any) => c.id === STOCK_COLS.walkthroughVideo)
        return [String(it.id), !!(col?.files?.length)]
      })
    )
    const { data: storedVids } = await supabase
      .from('stock')
      .select('id, walkthrough_video_url')
      .not('walkthrough_video_url', 'is', null)

    let removed = 0
    for (const row of (storedVids || [])) {
      const id = String(row.id)
      const inMonday = availById.has(id)
      const keep = inMonday && KEEP_VIDEO_STATUSES.has(availById.get(id)) && hasVideoFile.get(id) === true
      if (keep) continue
      const m = String(row.walkthrough_video_url).match(/\/property-videos\/(.+)$/)
      const path = m ? decodeURIComponent(m[1].split('?')[0]) : null
      if (path) {
        const { error: rmErr } = await supabase.storage.from(VIDEO_BUCKET).remove([path])
        if (rmErr) { errors.push(`video cleanup remove failed (${id}): ${rmErr.message}`); continue }
      }
      // Clear the DB pointer (skip when the row is about to be deleted as stale).
      if (inMonday) {
        await supabase.from('stock')
          .update({ walkthrough_video_url: null, walkthrough_video_asset_id: null })
          .eq('id', id)
      }
      removed++
    }
    if (removed > 0) console.log(`Video cleanup: removed ${removed} walkthrough video(s)`)
  } catch (e: any) {
    errors.push(`Video cleanup: ${(e as Error).message}`)
  }

  // 3. Delete stale records no longer in Monday.com
  const syncedStockIds  = stockItems.map(i => String(i.id))
  const syncedProjectIds = projectItems.map(i => String(i.id))

  if (syncedStockIds.length > 0) {
    const { error } = await supabase
      .from('stock')
      .delete()
      .not('id', 'in', `(${syncedStockIds.join(',')})`)
    if (error) errors.push(`Stock delete stale: ${error.message}`)
    else console.log('Deleted stale stock rows')
  }

  if (syncedProjectIds.length > 0) {
    const { error } = await supabase
      .from('projects')
      .delete()
      .not('id', 'in', `(${syncedProjectIds.join(',')})`)
    if (error) errors.push(`Projects delete stale: ${error.message}`)
    else console.log('Deleted stale project rows')
  }

  // 4. Fetch & upsert Deals in Progress
  // Wait 3 seconds before deals fetch to avoid Monday.com rate limits after stock
  console.log('Waiting before fetching deals to avoid rate limiting...')
  await new Promise(r => setTimeout(r, 3000))
  console.log('Fetching deals from Monday.com...')
  const dealItems = await fetchAllItems(DEALS_BOARD_ID)
  console.log(`Fetched ${dealItems.length} deal items`)

  const dealRows = dealItems.map(mapDeal)

  // Pre-fetch existing deal stages so we can keep stage_changed_at honest.
  // - new deal:           stage_changed_at = now()
  // - existing, stage X→Y: stage_changed_at = now()
  // - existing, no stage change: preserve previous stage_changed_at
  // Powers the Deal Cockpit "stalled deals" action queue.
  const incomingDealIds = dealRows.map(d => String(d.id))
  const { data: existingDealRows } = await supabase
    .from('partner_deals')
    .select('id, stage, stage_changed_at')
    .in('id', incomingDealIds)
  const existingDealMap = new Map(
    (existingDealRows || []).map((d: any) => [d.id, d])
  )
  const stageChangeNow = new Date().toISOString()
  for (const row of dealRows) {
    const prev = existingDealMap.get(row.id) as any
    if (!prev) {
      row.stage_changed_at = stageChangeNow
    } else if ((prev.stage || null) !== (row.stage || null)) {
      row.stage_changed_at = stageChangeNow
    } else {
      row.stage_changed_at = prev.stage_changed_at
    }
  }

  let dealCount = 0
  for (let i = 0; i < dealRows.length; i += 100) {
    const batch = dealRows.slice(i, i + 100)
    const { error } = await supabase
      .from('partner_deals')
      .upsert(batch, { onConflict: 'id' })
    if (error) {
      errors.push(`Deals batch ${i / 100 + 1}: ${error.message}`)
      console.error('Deal upsert error:', error)
    } else {
      dealCount += batch.length
    }
  }

  // Delete stale deals no longer in Monday.com
  const syncedDealIds = dealItems.map(i => String(i.id))
  if (syncedDealIds.length > 0) {
    const { error } = await supabase
      .from('partner_deals')
      .delete()
      .not('id', 'in', `(${syncedDealIds.join(',')})`)
    if (error) errors.push(`Deals delete stale: ${error.message}`)
    else console.log('Deleted stale deal rows')
  }

  // 5. Create partner notifications for newly-synced Available stock
  //    Stock items without notified_at are brand-new to the DB.
  const { data: unnotifiedStock } = await supabase
    .from('stock')
    .select('id, name, project_id, project_name, total_contract, bedrooms, development_type')
    .is('notified_at', null)
    .eq('availability', 'Available')

  if (unnotifiedStock && unnotifiedStock.length > 0) {
    // Get all active channel partners who have new_listings notifications enabled (default true)
    const { data: activePartners } = await supabase
      .from('channel_partners')
      .select('id, notification_prefs')
      .eq('status', 'active')

    const eligiblePartners = (activePartners || []).filter((p: any) => {
      const prefs = p.notification_prefs || {}
      return prefs.new_listings !== false
    })

    if (eligiblePartners.length > 0) {
      const notifications: Record<string, any>[] = []
      for (const stock of unnotifiedStock) {
        const price = stock.total_contract
          ? '$' + Math.round(stock.total_contract).toLocaleString('en-AU')
          : null
        const msgParts = [stock.name]
        if (stock.project_name) msgParts.push(stock.project_name)
        if (price) msgParts.push(price)

        for (const partner of eligiblePartners) {
          notifications.push({
            partner_id: partner.id,
            type:       'new_listing',
            title:      'New listing available',
            message:    msgParts.join(' · '),
            link_type:  'stock',
            link_id:    stock.id,
          })
        }
      }

      for (let i = 0; i < notifications.length; i += 100) {
        const batch = notifications.slice(i, i + 100)
        const { error } = await supabase.from('partner_notifications').insert(batch)
        if (error) errors.push(`Notifications batch: ${error.message}`)
      }

      // Mark stock items as notified so they won't fire again
      const notifiedIds = unnotifiedStock.map((s: any) => s.id)
      const { error: notifErr } = await supabase
        .from('stock')
        .update({ notified_at: new Date().toISOString() })
        .in('id', notifiedIds)
      if (notifErr) errors.push(`Mark notified_at: ${notifErr.message}`)
      else console.log(`Created notifications for ${unnotifiedStock.length} new stock items → ${eligiblePartners.length} partners`)
    }
  }

  // 5. Generate AI descriptions for projects missing one (max 3 per sync)
  if (CLAUDE_API_KEY) {
    const { data: needsDesc } = await supabase
      .from('projects')
      .select('id, name, developer, address, suburb, state, development_type, property_type, total_volume, stock_to_sell, year_constructed, est_construction_finish')
      .is('description', null)
      .eq('sales_status', 'Available')
      .limit(3)
    for (const p of (needsDesc || [])) {
      console.log(`Generating description for: ${p.name}`)
      const description = await generateProjectDescription(p, supabase)
      if (description) {
        const { error } = await supabase.from('projects').update({ description }).eq('id', p.id)
        if (error) errors.push(`Description for ${p.name}: ${error.message}`)
        else console.log(`Description saved for: ${p.name}`)
      }
    }
  }

  // 2e. Kick off walkthrough-video uploads in the BACKGROUND so this response
  // returns promptly — streaming 300 MB+ files inline would blow the 150s
  // request limit. EdgeRuntime.waitUntil keeps the worker alive to finish them;
  // falls back to awaiting inline if the runtime lacks it.
  try {
    const videoTask = runWalkthroughUploads()
    // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime
    if (typeof EdgeRuntime !== 'undefined' && (EdgeRuntime as any).waitUntil) {
      // @ts-ignore
      ;(EdgeRuntime as any).waitUntil(videoTask)
    } else {
      await videoTask
    }
  } catch (e: any) {
    errors.push(`Walkthrough uploads: ${(e as Error).message}`)
  }

  return { projects: projectCount, stock: stockCount, deals: dealCount, errors }
}

// ── Entry point ───────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS headers for portal "Sync Now" button
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    if (!MONDAY_TOKEN) {
      return new Response(
        JSON.stringify({ error: 'MONDAY_API_TOKEN secret not set' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    console.log('Starting Monday.com sync...')
    const result = await runSync()
    console.log('Sync complete:', result)

    return new Response(
      JSON.stringify({
        success: result.errors.length === 0,
        synced_at: new Date().toISOString(),
        projects: result.projects,
        stock: result.stock,
        deals: result.deals,
        errors: result.errors,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('Sync failed:', err)
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
