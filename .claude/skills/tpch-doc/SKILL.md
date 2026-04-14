---
name: tpch-doc
description: "TPCH branded document creator for The Property Clearing House. Creates professional .docx files matching the TPCH brand identity — navy, gold, Playfair Display serif. Document types: proposals, client reports, information packs, one-pagers, letters, suburb research reports, commission statements, partner welcome packs, investment summaries, and any general TPCH branded document. Triggers on: 'make a doc', 'create a document', 'put together a pack', 'write a proposal', 'client report', 'info pack', 'one pager', 'letter', 'TPCH document', 'Property Clearing House document', 'branded doc', 'investment proposal', 'research report', 'suburb report', 'partner pack', 'welcome letter'."
---

# TPCH Document Creator

Creates professionally branded `.docx` documents for The Property Clearing House using Node.js and the `docx` npm package. Every document matches the brand identity of the TPCH portal and landing page.

---

## Brand Identity

### Brand Voice
- **Tagline:** *Vision. Intelligence. Advantage.*
- **Descriptor:** Channel Partner Intelligence — Australia
- **Tone:** Confident, institutional, precise. No exclamation marks. No informal language.
- **Three Pillars:** Research Intelligence · Live Stock Portal · White-Label Reports
- **Company:** The Property Clearing House (abbrev. TPCH)

### Color Palette

| Role | Name | Hex |
|---|---|---|
| Background (deep) | Navy | `#080F1A` |
| Background (soft) | Navy Mid | `#0F1B2D` |
| Card surface | Navy Card | `#152238` |
| **Primary accent** | **Gold** | **`#C8A951`** |
| Gold hover | Gold Light | `#E8D48B` |
| Primary text | Cream | `#F5F3EE` |
| Secondary text | Grey Light | `#98A5B3` |
| Muted text | Grey Mid | `#5A6878` |
| UI border | Grey | `#2A3A50` |
| Decorative | Teal | `#14A3A8` |
| Positive / active | Green | `#4CAF7A` |
| Alert / decline | Red | `#C94C4C` |

**In print documents (light background):**
- Page background: white `#FFFFFF`
- Body text: near-black `#1A1A1A`
- Headings: Navy `#080F1A`
- Accent / overlines: Gold `#C8A951`
- Muted / disclaimers: `#5A6878`

### Typography

| Role | Font (screen) | Print equivalent | Size | Style |
|---|---|---|---|---|
| Display / cover title | Playfair Display | Palatino Linotype | 36pt | Regular |
| Cover subtitle | Playfair Display | Palatino Linotype | 20pt | Italic, Gold |
| Section H1 | Playfair Display | Palatino Linotype | 24pt | Regular, Navy |
| Section H2 | Playfair Display | Palatino Linotype | 16pt | Regular, Navy |
| Body | Outfit | Calibri | 12pt | Light/Regular |
| Overline labels | DM Mono | Courier New | 8pt | Uppercase, Gold, +letter-spacing |
| Data / stats | DM Mono | Courier New | 8pt | Uppercase |

**Note:** Palatino Linotype and Calibri are used in .docx because Playfair Display/Outfit are web fonts not available in Word. They match the personality closely.

### Logo Assets (in `assets/` folder)

| File | Use when |
|---|---|
| `logo-dark.svg` | Dark/navy backgrounds — cream wordmark |
| `logo-light.svg` | White/print backgrounds — navy wordmark |
| `emblem.svg` | Standalone icon only (no wordmark) |

**Logo mark description:** Gold rotated diamond with cream house shape (roof triangle + rectangular body + gold door rectangle) inside.

**Usage rules:**
- Always use `logo-light.svg` for printed documents
- Never place the logo on a busy background without a clear zone
- Minimum clear space: equal to the height of the emblem on all sides
- Do not recolor, stretch, or add effects to the logo

### Design Patterns

| Pattern | Rule |
|---|---|
| **Gold hairline** | 1pt gold borders on cards, tables, dividers — `#C8A951` |
| **Overline labels** | DM Mono 8pt, gold, ALL CAPS, letter-spacing 3px — before every section heading |
| **Gold italic emphasis** | Key words in headings set italic + gold — *"Vision. Intelligence. Advantage."* |
| **Section dividers** | Full-width 1pt gold horizontal rule |
| **Stat display** | Large serif number in gold + DM Mono uppercase label beneath |
| **Callout blocks** | Left gold border, indented, italic muted text |
| **Table headers** | Navy background, gold DM Mono uppercase text, gold bottom border |
| **Table rows** | Alternating white / very light cream (`#F9F8F6`) |
| **Cover page** | Full-width navy block at top with overline + title + italic subtitle |
| **Footer** | Gold hairline top + "The Property Clearing House · Channel Partner Intelligence — Australia · tpch.com.au" |
| **Header** | Gold hairline bottom + "TPCH | Document Title" |

---

## Document Types

### 1. Proposal
Investment opportunity for a specific property or market. Includes cover, executive summary, demand drivers, property table, stat strip, next steps, disclaimer.

### 2. Client Report / Suburb Research Report
Suburb-level analysis. Includes cover, market overview, demand drivers, supply pipeline, infrastructure, risk factors, TPCH recommendation, data sources.

### 3. Information Pack / Partner Welcome Pack
Overview of TPCH services for new or prospective partners. Includes cover, about section, the three pillars, how to access the portal, contact details.

### 4. One-Pager
Single-page summary — property or market. Dense layout: stat strip, brief body, key table, footer. No page break after cover.

### 5. Letter
Formal correspondence on TPCH letterhead. Includes header, date, recipient address block, body paragraphs, sign-off.

### 6. Commission Statement
Partner commission summary. Table of deals with property, price, commission rate, amount, status. Totals row.

### 7. General Branded Document
Any other document — uses the same brand shell (cover, header/footer, gold dividers) with free-form content.

---

## Workflow

### Step 1 — Understand the request

Extract from the user's message:
- **Document type** (proposal, report, letter, pack, one-pager, etc.)
- **Recipient name and company** (if provided)
- **Subject / property / suburb** (if applicable)
- **Key content** — any specific data, points, sections the user mentions
- **Output filename** (default: `tpch-[type]-[subject].docx`)

If any critical information is missing (recipient, subject), ask before building. Don't invent content for fields the user hasn't provided.

### Step 2 — Set up the build environment

```bash
cd .claude/skills/tpch-doc
npm install
```

Only needs to run once. Installs the `docx` package.

### Step 3 — Generate the config JSON

Write a config JSON file (e.g. `config.json`) in the skill folder based on the user's request. Use the schema below.

### Step 4 — Build the document

```bash
node .claude/skills/tpch-doc/build.js .claude/skills/tpch-doc/config.json
```

The `.docx` file will be written to the path specified in `outputFile`.

### Step 5 — Confirm

Tell the user the file path and what was included. Offer to adjust any content, add sections, or change the output filename.

---

## Config JSON Schema

```json
{
  "outputFile": "tpch-proposal-melbourne-cbd.docx",
  "docTitle": "Investment Proposal — Melbourne CBD",
  "title": "Melbourne CBD",
  "subtitle": "Investment Opportunity.",
  "docType": "Proposal",
  "date": "10 April 2026",
  "recipientName": "Jane Smith",
  "recipientCompany": "Smith Wealth Advisory",
  "preparedBy": "The Property Clearing House",
  "sections": [
    { "type": "overline", "text": "Section Label" },
    { "type": "heading", "text": "Section Title" },
    { "type": "subheading", "text": "Sub-section" },
    { "type": "body", "paragraphs": ["Paragraph one.", "Paragraph two."] },
    { "type": "callout", "text": "Highlighted quote or important note." },
    { "type": "bullets", "items": ["Point one", "Point two", "Point three"] },
    { "type": "stats", "stats": [
      { "number": "9.0%", "label": "Rental Growth" },
      { "number": "5.1%", "label": "Net Yield" }
    ]},
    { "type": "table", "headers": ["Column A", "Column B"], "rows": [
      ["Value 1", "Value 2"],
      ["Value 3", "Value 4"]
    ]},
    { "type": "divider" },
    { "type": "spacer", "lines": 1 },
    { "type": "pagebreak" },
    { "type": "disclaimer" }
  ]
}
```

### Section Types Reference

| Type | Purpose | Required fields |
|---|---|---|
| `overline` | Gold mono uppercase label before a heading | `text` |
| `heading` | H1 — Playfair Display, navy, gold underline | `text` |
| `subheading` | H2 — smaller serif heading | `text` |
| `body` | Body paragraphs | `paragraphs[]` or `text` |
| `callout` | Left-gold-border quote/highlight | `text` |
| `bullets` | Bullet list | `items[]` |
| `stats` | Gold number + mono label strip | `stats[]` with `number`, `label` |
| `table` | Data table, navy header, alternating rows | `headers[]`, `rows[][]` |
| `divider` | Full-width gold hairline | — |
| `spacer` | Blank space | `lines` (default 1) |
| `pagebreak` | New page | — |
| `disclaimer` | Standard TPCH legal disclaimer (auto text) | optional `text` override |

---

## Example Configs

See `templates/example-proposal.json` for a complete working example.

---

## File Structure

```
.claude/skills/tpch-doc/
├── SKILL.md                          ← This file
├── package.json                      ← docx dependency
├── build.js                          ← Document builder (all brand logic)
├── assets/
│   ├── emblem.svg                    ← Gold diamond + house mark only
│   ├── logo-dark.svg                 ← Full logo, dark background (cream text)
│   └── logo-light.svg                ← Full logo, light/print background (navy text)
└── templates/
    └── example-proposal.json         ← Working example config
```

---

## Important Notes

- **Never reference external URLs** for images or fonts — all assets are bundled in `assets/`
- **Print-safe fonts only** — Palatino Linotype and Calibri are used in .docx (not Playfair/Outfit)
- **Don't invent facts** — if property data, client names, or financials aren't provided, use clearly marked placeholder text like `[INSERT PRICE]`
- **Disclaimer is always included** on financial/property documents — either via the `disclaimer` section type or manually at the end
- **Confidentiality** — all documents include "Channel Partners Only" in the footer by default
- The `docx` package version is `^8.5.0` — always use the v8 API (not v7 which has a different API)
