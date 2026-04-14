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
  commPaymentTerms:   'status4',
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
  propertyType:       'mirror5',
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

// ── AI description generator ─────────────────────────────────

async function generateProjectDescription(p: Record<string, any>): Promise<string | null> {
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

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return null
    const json = await res.json()
    let text: string = json.content?.[0]?.text || null
    if (text) text = text.replace(/^```html\s*/i, '').replace(/```\s*$/i, '').trim()
    return text || null
  } catch {
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
                text
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

    const res = await fetch(MONDAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': MONDAY_TOKEN,
        'API-Version': '2023-10',
      },
      body: JSON.stringify({ query }),
    })

    if (!res.ok) throw new Error(`Monday.com API error: ${res.status} ${res.statusText}`)

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
  const propertyType     = getText(item, STOCK_COLS.propertyType)      || project?.property_type     || null
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
    lot_number:             getText(item, STOCK_COLS.lotNumber),
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
    // floor_plan_url is set separately in step 2b via Supabase Storage upload
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

  // 2b. Download & store floor plan files in Supabase Storage
  // 2b. Download & store floor plan files from Monday.com assets → Supabase Storage
  // File column values are null in GraphQL; assets array is the correct source.
  const itemsWithAssets = stockItems.filter(item => item.assets?.length > 0)
  if (itemsWithAssets.length > 0) {
    const fileItemIds = itemsWithAssets.map(i => String(i.id))
    const { data: alreadyStored } = await supabase
      .from('stock').select('id').in('id', fileItemIds).not('floor_plan_url', 'is', null)
    const storedSet = new Set((alreadyStored || []).map((r: any) => r.id))

    for (const item of itemsWithAssets) {
      const stockId = String(item.id)
      if (storedSet.has(stockId)) continue
      try {
        const asset = item.assets[0]
        console.log(`Floor plan asset for ${item.name}:`, JSON.stringify({ name: asset.name, url: asset.url, public_url: asset.public_url }))

        // public_url is a CDN link — no auth header (auth header causes 400 on CDN)
        // url is Monday.com's authenticated endpoint — needs auth header
        let res: Response | null = null
        if (asset.public_url) {
          res = await fetch(asset.public_url)
          if (!res.ok) res = null
        }
        if (!res && asset.url) {
          res = await fetch(asset.url, { headers: { 'Authorization': MONDAY_TOKEN } })
        }
        if (!res || !res.ok) { errors.push(`Floor plan download failed: ${item.name} (${res?.status ?? 'no URL'})`); continue }

        const bytes = await res.arrayBuffer()
        const ext   = (asset.name?.split('.').pop() || 'jpg').toLowerCase()
        const mime  = ext === 'pdf' ? 'application/pdf' : `image/${ext}`
        const path  = `stock/${stockId}/floor-plan.${ext}`

        const { error: upErr } = await supabase.storage
          .from('floor-plans').upload(path, bytes, { upsert: true, contentType: mime })
        if (upErr) { errors.push(`Floor plan upload failed: ${item.name}: ${upErr.message}`); continue }

        const { data: urlData } = supabase.storage.from('floor-plans').getPublicUrl(path)
        await supabase.from('stock').update({ floor_plan_url: urlData.publicUrl }).eq('id', stockId)
        console.log(`Floor plan stored for ${item.name}: ${urlData.publicUrl}`)
      } catch (e: any) {
        errors.push(`Floor plan error for ${item.name}: ${e.message}`)
      }
    }
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
  console.log('Fetching deals from Monday.com...')
  const dealItems = await fetchAllItems(DEALS_BOARD_ID)
  console.log(`Fetched ${dealItems.length} deal items`)

  const dealRows = dealItems.map(mapDeal)
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
      const description = await generateProjectDescription(p)
      if (description) {
        const { error } = await supabase.from('projects').update({ description }).eq('id', p.id)
        if (error) errors.push(`Description for ${p.name}: ${error.message}`)
        else console.log(`Description saved for: ${p.name}`)
      }
    }
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
        success: true,
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
