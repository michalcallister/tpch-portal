// ============================================================
// TPCH — process-enquiry Edge Function
// Triggered by Supabase database webhook on INSERT/UPDATE to pending_enquiries
// INSERT: Runs AI due diligence, emails admin report + applicant confirmation
// UPDATE (approved): Sends welcome email with Supabase Auth invite link
// UPDATE (declined): Sends decline email to applicant
//
// Required environment variables (set in Supabase Dashboard > Edge Functions > Secrets):
//   CLAUDE_API_KEY   — your Anthropic API key
//   RESEND_API_KEY   — your Resend API key
//   ADMIN_EMAIL      — admin@tpch.com.au
//   PORTAL_URL       — https://portal.tpch.com.au
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL          = Deno.env.get('ADMIN_EMAIL')             ?? 'admin@tpch.com.au';
const CLAUDE_KEY           = Deno.env.get('CLAUDE_API_KEY')          ?? '';
const RESEND_KEY           = Deno.env.get('RESEND_API_KEY')          ?? '';
const PORTAL_URL           = Deno.env.get('PORTAL_URL')              ?? 'https://portal.tpch.com.au';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')            ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function extractDeclineRationale(aiReport: string): string | null {
  if (!aiReport) return null;
  const match = aiReport.match(/8\.\s+\*?\*?Overall Recommendation\*?\*?[:\s-]*(.+?)(?=\n\n|\n\d+\.|\n---|\n═|$)/is);
  if (!match) return null;
  const raw = match[1].trim();
  return raw.replace(/^(APPROVE|DECLINE|REVIEW FURTHER)[.:\s-]*/i, '').trim() || null;
}

// ── Handles approved/declined UPDATE events asynchronously ───────────────
async function handleUpdate(record: Record<string, string>): Promise<void> {
  try {
    // ── Decline email ──────────────────────────────────────────────────
    if (record.status === 'declined') {
      console.log('Sending decline email to:', record.email);
      const firstName     = record.full_name?.split(' ')[0] || record.full_name || 'there';
      const rationale     = extractDeclineRationale(record.ai_report ?? '');
      const rationaleBlock = rationale ? `
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        After reviewing your application, our assessment found that ${rationale.charAt(0).toLowerCase()}${rationale.slice(1).replace(/\.$/, '')}. While we appreciate your interest in joining our network, we are unable to move forward with your application at this time.
      </p>` : `
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        After careful consideration of your application, we regret to inform you that we are unable to proceed with your application at this time. Our network has specific requirements regarding licensing, business profile, and market alignment that we must adhere to.
      </p>`;

      const declineHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Thank you for your interest, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#8A8A80;letter-spacing:1px;text-transform:uppercase;">Application update — ${record.company_name}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">We appreciate the time you took to apply to join the TPCH Channel Partner Network and the interest you've shown in working with us.</p>
      ${rationaleBlock}
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">This decision is not necessarily permanent. If your circumstances change — for example, if you obtain relevant licensing, grow your client base, or establish a stronger track record — we would encourage you to reapply in the future.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">If you have any questions regarding this decision, please feel free to reach out to us at <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.</p>
      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We wish you every success in your endeavours.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">You're receiving this email because you submitted a partner application.</p>
    </div>
  </div>
</body>
</html>`;

      const declineRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'TPCH Partner Network <noreply@tpch.com.au>',
          to:   [record.email],
          subject: `Your TPCH partner application — ${record.company_name}`,
          html: declineHtml,
        })
      });
      if (!declineRes.ok) console.error('Resend decline email error:', await declineRes.text());
      else console.log('Decline email sent to:', record.email);
    }

    // ── Approval: invite link + welcome email ──────────────────────────
    if (record.status === 'approved') {
      console.log('Sending welcome email to:', record.email);
      const firstName = record.full_name?.split(' ')[0] || record.full_name || 'there';
      const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'invite',
        email: record.email,
        options: {
          redirectTo: PORTAL_URL,
          data: { full_name: record.full_name, company_name: record.company_name },
        },
      });
      if (linkError) console.error('generateLink error:', linkError);
      else console.log('Invite link generated for:', record.email);

      if (linkData?.user?.id) {
        await supabase
          .from('channel_partners')
          .update({ user_id: linkData.user.id })
          .eq('email', record.email);
      }

      const inviteLink = linkData?.properties?.action_link ?? PORTAL_URL;

      const welcomeHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Welcome to the network, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">Application approved — ${record.company_name}</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">We're pleased to welcome <strong style="color:#1A1A16;">${record.company_name}</strong> to the TPCH Channel Partner Network. Your application has been reviewed and approved — you now have access to the full Partner Portal.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">To get started, click the button below to set your password and access the portal. This link is valid for <strong style="color:#1A1A16;">24 hours</strong>.</p>
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C9A84C;color:#0A0A08;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>
      <div style="background:#F8F7F3;border:1px solid #E4E0D4;padding:24px;margin-bottom:32px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A8A6A;margin-bottom:16px;">What you'll find in the portal</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${[
            ['◈ Stock Portal',      'Browse available investment properties, lot details, yields, and commission schedules'],
            ['◈ Research Reports',  'AI-powered suburb intelligence, demand drivers, and market analysis'],
            ['◈ My Deals',          'Track your pipeline from EOI through to settlement in real time'],
            ['◈ Market Resources',  'Investor guides, factsheets, and due diligence tools'],
          ].map(([title, desc]) => `
          <tr style="border-bottom:1px solid #E4E0D4;">
            <td style="padding:10px 0;vertical-align:top;">
              <div style="font-size:12px;font-weight:600;color:#1A1A16;margin-bottom:2px;">${title}</div>
              <div style="font-size:12px;color:#7A7A70;line-height:1.5;">${desc}</div>
            </td>
          </tr>`).join('')}
        </table>
      </div>
      <p style="margin:0 0 8px;font-size:14px;color:#3A3A35;line-height:1.7;">If you have any questions, reach out to us at <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.</p>
      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We look forward to working with you.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">You're receiving this email because your partner application was approved.</p>
    </div>
  </div>
</body>
</html>`;

      const welcomeRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'TPCH Partner Network <noreply@tpch.com.au>',
          to:   [record.email],
          subject: `Welcome to the TPCH Partner Network — ${record.company_name}`,
          html: welcomeHtml,
        })
      });
      if (!welcomeRes.ok) console.error('Resend welcome email error:', await welcomeRes.text());
      else console.log('Welcome email sent to:', record.email);
    }
  } catch (err) {
    console.error('handleUpdate error:', err);
  }
}

// ── Main request handler ──────────────────────────────────────────────────
Deno.serve(async (req) => {
  try {
    const body   = await req.json();
    const record = body?.record;
    if (!record) return new Response('No record', { status: 400 });

    // ── UPDATE: return 200 immediately, process email in background ──────
    if (body?.type === 'UPDATE' && (record.status === 'approved' || record.status === 'declined')) {
      const work = handleUpdate(record as Record<string, string>);
      // @ts-ignore — EdgeRuntime.waitUntil is available in Supabase Edge Functions
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work);
      else work.catch((e: unknown) => console.error('Background work error:', e));
      return new Response(JSON.stringify({ ok: true, action: 'processing' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── Ignore other UPDATE/DELETE events ────────────────────────────────
    if (body?.type && body.type !== 'INSERT') {
      return new Response(JSON.stringify({ ok: true, action: 'ignored' }), { status: 200 });
    }

    // ── INSERT: AI due diligence flow ────────────────────────────────────
    const r = record as Record<string, string>;

    // 1. Fetch website content
    let websiteContent = 'Website not provided or could not be fetched.';
    if (r.website) {
      try {
        let siteUrl = r.website.trim();
        if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;
        const siteRes = await fetch(siteUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-AU,en;q=0.9',
          },
          signal: AbortSignal.timeout(10000)
        });
        const html    = await siteRes.text();
        const stripped = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 4000);
        websiteContent = stripped.length > 100
          ? `[HTTP ${siteRes.status}] ${stripped}`
          : `Website returned HTTP ${siteRes.status} but minimal text could be extracted — the site is likely JavaScript-rendered (React/Next.js/Vue SPA). This is normal for modern websites and is NOT a red flag. Use the domain name, email domain, company name, and other application details to assess business legitimacy instead.`;
        console.log(`Website fetch: ${siteUrl} → HTTP ${siteRes.status}, ${stripped.length} chars`);
      } catch (fetchErr) {
        websiteContent = `Website could not be fetched: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`;
        console.error('Website fetch error:', fetchErr);
      }
    }

    // 2. Build Claude prompt
    const roleLabels: Record<string, string> = {
      mortgage_broker: 'Mortgage Broker', financial_planner: 'Financial Planner',
      buyers_agent: "Buyer's Agent", accountant: 'Accountant / Tax Agent',
      property_consultant: 'Property Consultant', financial_adviser: 'Financial Adviser', other: 'Other'
    };
    const clientLabels: Record<string, string> = {
      under_50: 'Under 50 clients', '50_200': '50–200 clients',
      '200_500': '200–500 clients', '500_plus': '500+ clients'
    };
    const yearsLabels: Record<string, string> = {
      under_1: 'Less than 1 year', '1_3': '1–3 years',
      '3_5': '3–5 years', '5_10': '5–10 years', '10_plus': '10+ years'
    };

    const prompt = `You are a due diligence analyst for The Property Clearing House (TPCH), an Australian property investment company that distributes investment properties through a network of licensed channel partners (mortgage brokers, financial planners, buyer's agents, accountants, and property consultants).

A new channel partner application has been submitted. Your job is to assess whether this applicant is a legitimate, established Australian financial services business and a credible candidate for the TPCH partner network.

───────────────────────────────────────────────
APPLICATION DETAILS
───────────────────────────────────────────────
Name:             ${r.full_name}
Email:            ${r.email}
Phone:            ${r.phone || 'Not provided'}
Company:          ${r.company_name}
ABN:              ${r.abn || 'Not provided'}
AFSL / ACL:       ${r.afsl_acl || 'Not provided'}
Website:          ${r.website || 'Not provided'}
LinkedIn:         ${r.linkedin_url || 'Not provided'}
Role:             ${roleLabels[r.role_type] ?? r.role_type ?? 'Not specified'}
State:            ${r.state || 'Not specified'}
Years in business:${yearsLabels[r.years_in_business] ?? r.years_in_business ?? 'Not specified'}
Client base:      ${clientLabels[r.num_clients] ?? r.num_clients ?? 'Not specified'}
How they heard:   ${r.referral_source || 'Not specified'}
Message:          ${r.message || 'None provided'}

───────────────────────────────────────────────
WEBSITE CONTENT (fetched automatically)
───────────────────────────────────────────────
${websiteContent}

───────────────────────────────────────────────
YOUR ASSESSMENT
───────────────────────────────────────────────

Please assess this applicant across the following areas. Be concise, specific, and direct. Flag anything that warrants further scrutiny.

1. **ABN Validity** — Is the ABN format valid (11 digits)? Note that live ABR verification is not available here, so flag for manual check if needed.

2. **AFSL / ACL** — If provided, does the licence number format appear valid? Does the stated role align with the type of licence?

3. **Website Assessment** — Based on the fetched website content, does the business appear professional and established?

4. **Business Credibility** — Does this appear to be a legitimate, operating business?

5. **LinkedIn** — If provided, flag for manual review.

6. **Client Base & Scale** — Does the stated client base (${clientLabels[r.num_clients] ?? 'not stated'}) seem consistent with their years in business (${yearsLabels[r.years_in_business] ?? 'not stated'}) and role?

7. **Red Flags** — List any specific concerns or inconsistencies.

8. **Overall Recommendation** — One of: APPROVE / REVIEW FURTHER / DECLINE. Include a 1–2 sentence rationale.

Format your response clearly with these 8 numbered sections. Be professional and direct.`;

    // 3. Call Claude API
    console.log('Calling Claude API...');
    if (!CLAUDE_KEY) console.error('CLAUDE_API_KEY secret is not set!');
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      throw new Error('Claude API error: ' + errText);
    }
    const claudeData = await claudeRes.json();
    const aiReport   = claudeData.content?.[0]?.text ?? 'AI assessment unavailable.';
    console.log('Claude response received, length:', aiReport.length);

    // 4. Extract recommendation
    let aiRecommendation = 'review_further';
    const lower = aiReport.toLowerCase();
    if (lower.includes('overall recommendation') && lower.includes('approve') && !lower.includes('not approve')) {
      aiRecommendation = 'approve';
    } else if (lower.includes('overall recommendation') && lower.includes('decline')) {
      aiRecommendation = 'decline';
    }

    // 5. Save AI report to DB
    console.log('Saving AI report to DB for enquiry:', r.id);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { error: updateError } = await supabase
      .from('pending_enquiries')
      .update({ ai_report: aiReport, ai_recommendation: aiRecommendation })
      .eq('id', r.id);
    if (updateError) console.error('DB update error:', updateError);
    else console.log('AI report saved successfully');

    // 6. Build and send admin email
    const badgeColour = aiRecommendation === 'approve' ? '#4CAF7A' : aiRecommendation === 'decline' ? '#C94C4C' : '#C9A84C';
    const badgeLabel  = aiRecommendation === 'approve' ? 'APPROVE' : aiRecommendation === 'decline' ? 'DECLINE' : 'REVIEW FURTHER';
    const reportHtml  = aiReport.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>');

    const adminEmailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0A0A08;font-family:'Arial',sans-serif;color:#F8F6F0;">
  <div style="max-width:640px;margin:0 auto;background:#0A0A08;">
    <div style="background:#111110;padding:24px 32px;border-bottom:1px solid rgba(201,168,76,0.3);display:flex;align-items:center;gap:12px;">
      <div style="width:36px;height:36px;background:#C9A84C;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#0A0A08;flex-shrink:0;">TC</div>
      <div>
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
        <div style="font-size:10px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">New Partner Application</div>
      </div>
    </div>
    <div style="background:${badgeColour}20;border-left:4px solid ${badgeColour};padding:14px 32px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A9A8A;">AI Recommendation</div>
      <div style="font-size:13px;font-weight:700;color:${badgeColour};letter-spacing:1px;">${badgeLabel}</div>
    </div>
    <div style="padding:28px 32px 0;">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#F8F6F0;">${r.full_name}</h1>
      <div style="font-size:13px;color:#C9A84C;margin-bottom:20px;">${r.company_name}${r.state ? ' · ' + r.state : ''}</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        ${[
          ['Email',      r.email],
          ['Phone',      r.phone || '—'],
          ['ABN',        r.abn || '—'],
          ['AFSL/ACL',   r.afsl_acl || 'Not provided'],
          ['Website',    r.website ? `<a href="${r.website}" style="color:#C9A84C;">${r.website}</a>` : '—'],
          ['LinkedIn',   r.linkedin_url ? `<a href="${r.linkedin_url}" style="color:#C9A84C;">View Profile</a>` : 'Not provided'],
          ['Role',       roleLabels[r.role_type] ?? r.role_type ?? '—'],
          ['Experience', yearsLabels[r.years_in_business] ?? '—'],
          ['Clients',    clientLabels[r.num_clients] ?? '—'],
          ['Referred by',r.referral_source || '—'],
        ].map(([label, value]) => `
          <tr style="border-bottom:1px solid rgba(201,168,76,0.08);">
            <td style="padding:8px 0;color:#5A5A52;width:120px;">${label}</td>
            <td style="padding:8px 0;color:#F8F6F0;">${value}</td>
          </tr>`).join('')}
      </table>
      ${r.message ? `<div style="margin-top:16px;padding:14px;background:#161614;border:1px solid rgba(201,168,76,0.15);"><div style="font-size:10px;color:#5A5A52;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Their message</div><div style="font-size:12px;color:#D4D4C8;line-height:1.6;">${r.message}</div></div>` : ''}
    </div>
    <div style="padding:28px 32px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C9A84C;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(201,168,76,0.2);">◈ AI Due Diligence Report</div>
      <div style="font-size:12px;color:#D4D4C8;line-height:1.8;"><p>${reportHtml}</p></div>
    </div>
    <div style="padding:20px 32px;background:#111110;border-top:1px solid rgba(201,168,76,0.15);font-size:10px;color:#3A3A35;text-align:center;">
      TPCH Channel Partner Portal · Automated due diligence report<br>This assessment is AI-generated and should be reviewed before taking action.
    </div>
  </div>
</body>
</html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TPCH Portal <noreply@tpch.com.au>',
        to:   [ADMIN_EMAIL],
        subject: `[Partner Enquiry] ${r.full_name} — ${r.company_name} · AI: ${badgeLabel}`,
        html: adminEmailHtml
      })
    });
    if (!emailRes.ok) console.error('Resend admin email error:', await emailRes.text());

    // 7. Send confirmation to applicant
    const firstName = r.full_name?.split(' ')[0] || r.full_name || 'there';
    const applicantHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Thank you, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">Application received</p>
      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">We've received your application to join the TPCH Channel Partner Network and our team is reviewing your details. You'll hear back from us within <strong style="color:#1A1A16;">1–2 business days</strong>.</p>
      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">In the meantime, if you have any questions please don't hesitate to reach out at <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.</p>
      <div style="background:#F8F7F3;border:1px solid #E4E0D4;padding:20px 24px;margin-bottom:32px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A8A6A;margin-bottom:16px;">Your application summary</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="border-bottom:1px solid #E4E0D4;"><td style="padding:9px 0;color:#9A8A6A;width:130px;">Name</td><td style="padding:9px 0;color:#1A1A16;font-weight:500;">${r.full_name}</td></tr>
          <tr style="border-bottom:1px solid #E4E0D4;"><td style="padding:9px 0;color:#9A8A6A;">Company</td><td style="padding:9px 0;color:#1A1A16;font-weight:500;">${r.company_name}</td></tr>
          <tr style="border-bottom:1px solid #E4E0D4;"><td style="padding:9px 0;color:#9A8A6A;">Role</td><td style="padding:9px 0;color:#1A1A16;">${roleLabels[r.role_type] ?? r.role_type ?? '—'}</td></tr>
          <tr><td style="padding:9px 0;color:#9A8A6A;">State</td><td style="padding:9px 0;color:#1A1A16;">${r.state || '—'}</td></tr>
        </table>
      </div>
      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We look forward to potentially welcoming you to the network.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;">The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a></p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">You're receiving this email because you submitted a partner application. This is an automated confirmation.</p>
    </div>
  </div>
</body>
</html>`;

    const applicantRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TPCH Partner Network <noreply@tpch.com.au>',
        to:   [r.email],
        subject: `Application received — ${r.company_name}`,
        html: applicantHtml,
      })
    });
    if (!applicantRes.ok) console.error('Resend applicant email error:', await applicantRes.text());

    return new Response(JSON.stringify({ ok: true, recommendation: aiRecommendation }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('process-enquiry error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
