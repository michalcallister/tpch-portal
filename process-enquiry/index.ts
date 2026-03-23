// ============================================================
// TPCH — process-enquiry Edge Function
// Triggered by Supabase database webhook on INSERT to pending_enquiries
// Runs AI due diligence on the applicant and emails a report to admin
//
// Required environment variables (set in Supabase Dashboard > Edge Functions > Secrets):
//   CLAUDE_API_KEY   — your Anthropic API key
//   RESEND_API_KEY   — your Resend API key
//   ADMIN_EMAIL      — admin@tpch.com.au
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ADMIN_EMAIL   = Deno.env.get('ADMIN_EMAIL')        ?? 'admin@tpch.com.au';
const CLAUDE_KEY    = Deno.env.get('CLAUDE_API_KEY')     ?? '';
const RESEND_KEY    = Deno.env.get('RESEND_API_KEY')     ?? '';
const PORTAL_URL    = Deno.env.get('PORTAL_URL')         ?? 'https://portal.tpch.com.au';
// These are injected automatically by Supabase — no need to add them as secrets
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')                ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')   ?? '';

// Extract the Overall Recommendation rationale from the AI report
function extractDeclineRationale(aiReport: string): string | null {
  if (!aiReport) return null;
  // Look for section 8 content
  const match = aiReport.match(/8\.\s+\*?\*?Overall Recommendation\*?\*?[:\s-]*(.+?)(?=\n\n|\n\d+\.|\n---|\n═|$)/is);
  if (!match) return null;
  const raw = match[1].trim();
  // Strip recommendation keyword itself (APPROVE/DECLINE/REVIEW FURTHER) from the start
  return raw.replace(/^(APPROVE|DECLINE|REVIEW FURTHER)[.:\s-]*/i, '').trim() || null;
}

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    // Supabase database webhook sends { type, table, record, old_record }
    const record = body?.record;
    if (!record) return new Response('No record', { status: 400 });

    // ── Handle decline notification (UPDATE webhook) ──────────────────────
    if (body?.type === 'UPDATE' && record.status === 'declined') {
      const firstName = record.full_name?.split(' ')[0] || record.full_name || 'there';
      const rationale  = extractDeclineRationale(record.ai_report ?? '');

      // Build a personalised but professional decline paragraph if we have rationale
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

    <!-- Header -->
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>

    <!-- Gold rule -->
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>

    <!-- Body -->
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Thank you for your interest, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#8A8A80;letter-spacing:1px;text-transform:uppercase;">Application update — ${record.company_name}</p>

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        We appreciate the time you took to apply to join the TPCH Channel Partner Network and the interest you've shown in working with us.
      </p>

      ${rationaleBlock}

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        This decision is not necessarily permanent. If your circumstances change — for example, if you obtain relevant licensing, grow your client base, or establish a stronger track record — we would encourage you to reapply in the future.
      </p>

      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">
        If you have any questions regarding this decision, please feel free to reach out to us at
        <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.
      </p>

      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We wish you every success in your endeavours.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>

    <!-- Footer -->
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;letter-spacing:0.5px;">
        The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a>
      </p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">
        You're receiving this email because you submitted a partner application.
      </p>
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

      if (!declineRes.ok) {
        console.error('Resend decline email error:', await declineRes.text());
      }

      return new Response(JSON.stringify({ ok: true, action: 'decline_email_sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── Handle welcome email + auth invite (UPDATE → approved) ──────────
    if (body?.type === 'UPDATE' && record.status === 'approved') {
      const firstName = record.full_name?.split(' ')[0] || record.full_name || 'there';
      const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

      // Create Supabase Auth user and get invite link
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'invite',
        email: record.email,
        options: {
          redirectTo: PORTAL_URL,
          data: { full_name: record.full_name, company_name: record.company_name },
        },
      });

      if (linkError) console.error('generateLink error:', linkError);

      // Store the auth user_id on the channel_partners record
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

    <!-- Header -->
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>

    <!-- Gold rule -->
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>

    <!-- Body -->
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Welcome to the network, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">Application approved — ${record.company_name}</p>

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        We're pleased to welcome <strong style="color:#1A1A16;">${record.company_name}</strong> to the TPCH Channel Partner Network.
        Your application has been reviewed and approved — you now have access to the full Partner Portal.
      </p>

      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">
        To get started, click the button below to set your password and access the portal. This link is valid for <strong style="color:#1A1A16;">24 hours</strong>.
      </p>

      <!-- CTA Button -->
      <div style="text-align:center;margin:0 0 36px;">
        <a href="${inviteLink}" style="display:inline-block;background:#C9A84C;color:#0A0A08;text-decoration:none;font-size:14px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:16px 40px;">
          Set Password &amp; Access Portal →
        </a>
      </div>

      <!-- What's available -->
      <div style="background:#F8F7F3;border:1px solid #E4E0D4;padding:24px;margin-bottom:32px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A8A6A;margin-bottom:16px;">What you'll find in the portal</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          ${[
            ['◈ Stock Portal', 'Browse available investment properties, lot details, yields, and commission schedules'],
            ['◈ Research Reports', 'AI-powered suburb intelligence, demand drivers, and market analysis'],
            ['◈ My Deals', 'Track your pipeline from EOI through to settlement in real time'],
            ['◈ Market Resources', 'Investor guides, factsheets, and due diligence tools'],
          ].map(([title, desc]) => `
          <tr style="border-bottom:1px solid #E4E0D4;">
            <td style="padding:10px 0;vertical-align:top;">
              <div style="font-size:12px;font-weight:600;color:#1A1A16;margin-bottom:2px;">${title}</div>
              <div style="font-size:12px;color:#7A7A70;line-height:1.5;">${desc}</div>
            </td>
          </tr>`).join('')}
        </table>
      </div>

      <p style="margin:0 0 8px;font-size:14px;color:#3A3A35;line-height:1.7;">
        If you have any questions, reach out to us at
        <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.
      </p>
      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">We look forward to working with you.</p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>

    <!-- Footer -->
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;letter-spacing:0.5px;">
        The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a>
      </p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">
        You're receiving this email because your partner application was approved.
      </p>
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

      return new Response(JSON.stringify({ ok: true, action: 'welcome_email_sent' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // ── Guard: only continue with INSERT flow ────────────────────────────
    if (body?.type && body.type !== 'INSERT') {
      return new Response(JSON.stringify({ ok: true, action: 'ignored' }), { status: 200 });
    }

    // 1. Fetch website content for AI to analyse
    let websiteContent = 'Website not provided or could not be fetched.';
    if (record.website) {
      try {
        // Normalise URL — add https:// if no protocol supplied
        let siteUrl = record.website.trim();
        if (!/^https?:\/\//i.test(siteUrl)) siteUrl = 'https://' + siteUrl;

        const siteRes = await fetch(siteUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-AU,en;q=0.9',
          },
          signal: AbortSignal.timeout(10000)
        });

        // Read body regardless of status code — even a 403 page often contains useful content
        const html = await siteRes.text();
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

    // 2. Build Claude due diligence prompt
    const roleLabels: Record<string, string> = {
      mortgage_broker: 'Mortgage Broker',
      financial_planner: 'Financial Planner',
      buyers_agent: "Buyer's Agent",
      accountant: 'Accountant / Tax Agent',
      property_consultant: 'Property Consultant',
      financial_adviser: 'Financial Adviser',
      other: 'Other'
    };
    const clientLabels: Record<string, string> = {
      under_50: 'Under 50 clients',
      '50_200': '50–200 clients',
      '200_500': '200–500 clients',
      '500_plus': '500+ clients'
    };
    const yearsLabels: Record<string, string> = {
      under_1: 'Less than 1 year',
      '1_3': '1–3 years',
      '3_5': '3–5 years',
      '5_10': '5–10 years',
      '10_plus': '10+ years'
    };

    const prompt = `You are a due diligence analyst for The Property Clearing House (TPCH), an Australian property investment company that distributes investment properties through a network of licensed channel partners (mortgage brokers, financial planners, buyer's agents, accountants, and property consultants).

A new channel partner application has been submitted. Your job is to assess whether this applicant is a legitimate, established Australian financial services business and a credible candidate for the TPCH partner network.

───────────────────────────────────────────────
APPLICATION DETAILS
───────────────────────────────────────────────
Name:             ${record.full_name}
Email:            ${record.email}
Phone:            ${record.phone || 'Not provided'}
Company:          ${record.company_name}
ABN:              ${record.abn || 'Not provided'}
AFSL / ACL:       ${record.afsl_acl || 'Not provided'}
Website:          ${record.website || 'Not provided'}
LinkedIn:         ${record.linkedin_url || 'Not provided'}
Role:             ${roleLabels[record.role_type] ?? record.role_type ?? 'Not specified'}
State:            ${record.state || 'Not specified'}
Years in business:${yearsLabels[record.years_in_business] ?? record.years_in_business ?? 'Not specified'}
Client base:      ${clientLabels[record.num_clients] ?? record.num_clients ?? 'Not specified'}
How they heard:   ${record.referral_source || 'Not specified'}
Message:          ${record.message || 'None provided'}

───────────────────────────────────────────────
WEBSITE CONTENT (fetched automatically)
───────────────────────────────────────────────
${websiteContent}

───────────────────────────────────────────────
YOUR ASSESSMENT
───────────────────────────────────────────────

Please assess this applicant across the following areas. Be concise, specific, and direct. Flag anything that warrants further scrutiny.

1. **ABN Validity** — Is the ABN format valid (11 digits)? Note that live ABR verification is not available here, so flag for manual check if needed. Note any inconsistencies between the ABN and stated company name.

2. **AFSL / ACL** — If provided, does the licence number format appear valid? Does the stated role align with the type of licence (AFSL for financial advice/investment, ACL for credit/mortgage)? If not provided, is that consistent with their stated role?

3. **Website Assessment** — Based on the fetched website content, does the business appear professional and established? Does the business name, services, and location match what was submitted? Any red flags?

4. **Business Credibility** — Based on all available information, does this appear to be a legitimate, operating business? Assess consistency between company name, website, email domain, role, and years of experience.

5. **LinkedIn** — If provided, note the URL and flag for manual review. Assess whether the stated role and tenure is plausible.

6. **Client Base & Scale** — Does the stated client base (${clientLabels[record.num_clients] ?? 'not stated'}) seem consistent with their years in business (${yearsLabels[record.years_in_business] ?? 'not stated'}) and role?

7. **Red Flags** — List any specific concerns, inconsistencies, or things that require follow-up before approving.

8. **Overall Recommendation** — One of: APPROVE / REVIEW FURTHER / DECLINE. Include a 1–2 sentence rationale.

Format your response clearly with these 8 numbered sections. Be professional and direct.`;

    // 3. Call Claude API
    console.log('Calling Claude API...');
    if (!CLAUDE_KEY) console.error('CLAUDE_API_KEY secret is not set!');

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error('Claude API error:', claudeRes.status, errText);
      throw new Error('Claude API error: ' + errText);
    }
    const claudeData = await claudeRes.json();
    const aiReport   = claudeData.content?.[0]?.text ?? 'AI assessment unavailable.';
    console.log('Claude API response received, length:', aiReport.length);

    // Extract recommendation from report
    let aiRecommendation = 'review_further';
    const lower = aiReport.toLowerCase();
    if (lower.includes('overall recommendation') && lower.includes('approve') && !lower.includes('not approve')) {
      aiRecommendation = 'approve';
    } else if (lower.includes('overall recommendation') && lower.includes('decline')) {
      aiRecommendation = 'decline';
    }

    // 4. Save AI report back to the enquiry record
    console.log('Saving AI report to DB for enquiry:', record.id);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { error: updateError } = await supabase
      .from('pending_enquiries')
      .update({ ai_report: aiReport, ai_recommendation: aiRecommendation })
      .eq('id', record.id);
    if (updateError) console.error('DB update error:', updateError);
    else console.log('AI report saved successfully');

    // 5. Build recommendation badge for email
    const badgeColour = aiRecommendation === 'approve'
      ? '#4CAF7A' : aiRecommendation === 'decline' ? '#C94C4C' : '#C9A84C';
    const badgeLabel  = aiRecommendation === 'approve'
      ? 'APPROVE' : aiRecommendation === 'decline' ? 'DECLINE' : 'REVIEW FURTHER';

    // 6. Format AI report as HTML (convert markdown-ish to basic HTML)
    const reportHtml = aiReport
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');

    // 7. Send email via Resend
    const emailHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0A0A08;font-family:'Arial',sans-serif;color:#F8F6F0;">
  <div style="max-width:640px;margin:0 auto;background:#0A0A08;">

    <!-- Header -->
    <div style="background:#111110;padding:24px 32px;border-bottom:1px solid rgba(201,168,76,0.3);display:flex;align-items:center;gap:12px;">
      <div style="width:36px;height:36px;background:#C9A84C;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#0A0A08;flex-shrink:0;">TC</div>
      <div>
        <div style="font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
        <div style="font-size:10px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">New Partner Application</div>
      </div>
    </div>

    <!-- AI Recommendation Banner -->
    <div style="background:${badgeColour}20;border-left:4px solid ${badgeColour};padding:14px 32px;display:flex;align-items:center;justify-content:space-between;">
      <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A9A8A;">AI Recommendation</div>
      <div style="font-size:13px;font-weight:700;color:${badgeColour};letter-spacing:1px;">${badgeLabel}</div>
    </div>

    <!-- Applicant Summary -->
    <div style="padding:28px 32px 0;">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:#F8F6F0;">${record.full_name}</h1>
      <div style="font-size:13px;color:#C9A84C;margin-bottom:20px;">${record.company_name}${record.state ? ' · ' + record.state : ''}</div>

      <table style="width:100%;border-collapse:collapse;font-size:12px;">
        ${[
          ['Email',     record.email],
          ['Phone',     record.phone || '—'],
          ['ABN',       record.abn || '—'],
          ['AFSL/ACL',  record.afsl_acl || 'Not provided'],
          ['Website',   record.website ? `<a href="${record.website}" style="color:#C9A84C;">${record.website}</a>` : '—'],
          ['LinkedIn',  record.linkedin_url ? `<a href="${record.linkedin_url}" style="color:#C9A84C;">View Profile</a>` : 'Not provided'],
          ['Role',      roleLabels[record.role_type] ?? record.role_type ?? '—'],
          ['Experience',yearsLabels[record.years_in_business] ?? '—'],
          ['Clients',   clientLabels[record.num_clients] ?? '—'],
          ['Referred by',record.referral_source || '—'],
        ].map(([label, value]) => `
          <tr style="border-bottom:1px solid rgba(201,168,76,0.08);">
            <td style="padding:8px 0;color:#5A5A52;width:120px;">${label}</td>
            <td style="padding:8px 0;color:#F8F6F0;">${value}</td>
          </tr>`).join('')}
      </table>

      ${record.message ? `
      <div style="margin-top:16px;padding:14px;background:#161614;border:1px solid rgba(201,168,76,0.15);">
        <div style="font-size:10px;color:#5A5A52;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Their message</div>
        <div style="font-size:12px;color:#D4D4C8;line-height:1.6;">${record.message}</div>
      </div>` : ''}
    </div>

    <!-- AI Report -->
    <div style="padding:28px 32px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#C9A84C;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(201,168,76,0.2);">◈ AI Due Diligence Report</div>
      <div style="font-size:12px;color:#D4D4C8;line-height:1.8;"><p>${reportHtml}</p></div>
    </div>

    <!-- Footer -->
    <div style="padding:20px 32px;background:#111110;border-top:1px solid rgba(201,168,76,0.15);font-size:10px;color:#3A3A35;text-align:center;">
      TPCH Channel Partner Portal · Automated due diligence report<br>
      This assessment is AI-generated and should be reviewed before taking action.
    </div>

  </div>
</body>
</html>`;

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'TPCH Portal <noreply@tpch.com.au>',
        to:   [ADMIN_EMAIL],
        subject: `[Partner Enquiry] ${record.full_name} — ${record.company_name} · AI: ${badgeLabel}`,
        html: emailHtml
      })
    });

    if (!emailRes.ok) {
      const errText = await emailRes.text();
      console.error('Resend admin email error:', errText);
    }

    // 8. Send confirmation email to the applicant
    const firstName = record.full_name?.split(' ')[0] || record.full_name || 'there';
    const applicantHtml = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4F4F0;font-family:'Arial',sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#F4F4F0;">

    <!-- Header -->
    <div style="background:#0A0A08;padding:28px 36px;text-align:center;">
      <div style="display:inline-flex;align-items:center;gap:12px;">
        <div style="width:40px;height:40px;background:#C9A84C;display:inline-flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#0A0A08;">TC</div>
        <div style="text-align:left;">
          <div style="font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#F8F6F0;">The Property Clearing House</div>
          <div style="font-size:10px;color:#C9A84C;letter-spacing:1.5px;text-transform:uppercase;margin-top:2px;">Partner Network</div>
        </div>
      </div>
    </div>

    <!-- Gold rule -->
    <div style="height:3px;background:linear-gradient(90deg,#C9A84C,#E8D08A,#C9A84C);"></div>

    <!-- Body -->
    <div style="background:#ffffff;padding:44px 44px 36px;">
      <p style="margin:0 0 8px;font-size:22px;font-weight:700;color:#1A1A16;line-height:1.3;">Thank you, ${firstName}.</p>
      <p style="margin:0 0 28px;font-size:14px;color:#C9A84C;letter-spacing:1px;text-transform:uppercase;">Application received</p>

      <p style="margin:0 0 20px;font-size:15px;color:#3A3A35;line-height:1.7;">
        We've received your application to join the TPCH Channel Partner Network and our team is reviewing your details.
        You'll hear back from us within <strong style="color:#1A1A16;">1–2 business days</strong>.
      </p>

      <p style="margin:0 0 32px;font-size:15px;color:#3A3A35;line-height:1.7;">
        In the meantime, if you have any questions please don't hesitate to reach out to us directly at
        <a href="mailto:${ADMIN_EMAIL}" style="color:#C9A84C;text-decoration:none;">${ADMIN_EMAIL}</a>.
      </p>

      <!-- Summary card -->
      <div style="background:#F8F7F3;border:1px solid #E4E0D4;padding:20px 24px;margin-bottom:32px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9A8A6A;margin-bottom:16px;">Your application summary</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <tr style="border-bottom:1px solid #E4E0D4;">
            <td style="padding:9px 0;color:#9A8A6A;width:130px;">Name</td>
            <td style="padding:9px 0;color:#1A1A16;font-weight:500;">${record.full_name}</td>
          </tr>
          <tr style="border-bottom:1px solid #E4E0D4;">
            <td style="padding:9px 0;color:#9A8A6A;">Company</td>
            <td style="padding:9px 0;color:#1A1A16;font-weight:500;">${record.company_name}</td>
          </tr>
          <tr style="border-bottom:1px solid #E4E0D4;">
            <td style="padding:9px 0;color:#9A8A6A;">Role</td>
            <td style="padding:9px 0;color:#1A1A16;">${roleLabels[record.role_type] ?? record.role_type ?? '—'}</td>
          </tr>
          <tr>
            <td style="padding:9px 0;color:#9A8A6A;">State</td>
            <td style="padding:9px 0;color:#1A1A16;">${record.state || '—'}</td>
          </tr>
        </table>
      </div>

      <p style="margin:0;font-size:14px;color:#3A3A35;line-height:1.7;">
        We look forward to potentially welcoming you to the network.
      </p>
      <p style="margin:16px 0 0;font-size:14px;color:#1A1A16;font-weight:600;">The TPCH Team</p>
    </div>

    <!-- Footer -->
    <div style="background:#0A0A08;padding:24px 36px;text-align:center;">
      <p style="margin:0 0 6px;font-size:11px;color:#5A5A52;letter-spacing:0.5px;">
        The Property Clearing House · <a href="https://tpch.com.au" style="color:#C9A84C;text-decoration:none;">tpch.com.au</a>
      </p>
      <p style="margin:0;font-size:10px;color:#3A3A35;">
        You're receiving this email because you submitted a partner application. This is an automated confirmation.
      </p>
    </div>

  </div>
</body>
</html>`;

    const applicantRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TPCH Partner Network <noreply@tpch.com.au>',
        to:   [record.email],
        subject: `Application received — ${record.company_name}`,
        html: applicantHtml,
      })
    });

    if (!applicantRes.ok) {
      console.error('Resend applicant email error:', await applicantRes.text());
    }

    return new Response(JSON.stringify({ ok: true, recommendation: aiRecommendation }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('process-enquiry error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
});
