/**
 * TPCH Document Builder
 * Uses the `docx` npm package to generate branded .docx files.
 *
 * Usage: node build.js <config.json>
 * Config is written by Claude based on the document request.
 */

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, BorderStyle, Table, TableRow, TableCell,
  WidthType, ShadingType, PageBreak, Header, Footer,
  ImageRun, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  TableLayoutType, convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');

// ─── BRAND TOKENS ─────────────────────────────────────────────────────────────
const BRAND = {
  // Colors (as docx hex strings — no #)
  navy:       '080F1A',
  navyMid:    '0F1B2D',
  navyCard:   '152238',
  gold:       'C8A951',
  goldLight:  'E8D48B',
  cream:      'F5F3EE',
  greyLight:  '98A5B3',
  greyMid:    '5A6878',
  grey:       '2A3A50',
  teal:       '14A3A8',
  green:      '4CAF7A',
  red:        'C94C4C',
  white:      'FFFFFF',
  black:      '000000',

  // Fonts
  serif:  'Palatino Linotype',   // closest print-safe serif to Playfair Display
  sans:   'Calibri',             // clean sans for body (Outfit equivalent)
  mono:   'Courier New',         // DM Mono equivalent

  // Page margins (twips — 1 inch = 1440)
  marginTop:    1440,  // 1 inch
  marginBottom: 1440,
  marginLeft:   1440,
  marginRight:  1152,  // 0.8 inch

  // Gold border line (used in tables/dividers)
  goldBorder: { style: BorderStyle.SINGLE, size: 6, color: 'C8A951' },
  noBorder:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
};

// ─── PARAGRAPH STYLES ─────────────────────────────────────────────────────────

function coverTitle(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 120 },
    children: [new TextRun({
      text,
      font: BRAND.serif,
      size: 72,          // 36pt
      bold: false,
      color: BRAND.cream,
    })],
  });
}

function coverSubtitle(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { before: 0, after: 480 },
    children: [new TextRun({
      text,
      font: BRAND.serif,
      size: 48,          // 24pt
      italics: true,
      color: BRAND.gold,
    })],
  });
}

function overlineLabel(text) {
  return new Paragraph({
    spacing: { before: 480, after: 80 },
    children: [new TextRun({
      text: text.toUpperCase(),
      font: BRAND.mono,
      size: 16,          // 8pt
      color: BRAND.gold,
      characterSpacing: 120,
    })],
  });
}

function sectionHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 480, after: 160 },
    border: { bottom: BRAND.goldBorder },
    children: [new TextRun({
      text,
      font: BRAND.serif,
      size: 48,          // 24pt
      bold: false,
      color: BRAND.navy,
    })],
  });
}

function subHeading(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 320, after: 120 },
    children: [new TextRun({
      text,
      font: BRAND.serif,
      size: 32,          // 16pt
      bold: false,
      color: BRAND.navy,
    })],
  });
}

function bodyText(text, options = {}) {
  return new Paragraph({
    alignment: options.align || AlignmentType.LEFT,
    spacing: { before: 0, after: 160, line: 336 },   // 1.4 line-height
    children: [new TextRun({
      text,
      font: BRAND.sans,
      size: 24,          // 12pt
      color: options.color || '1A1A1A',
      bold: options.bold || false,
      italics: options.italic || false,
    })],
  });
}

function calloutText(text) {
  return new Paragraph({
    spacing: { before: 160, after: 160, line: 336 },
    indent: { left: 720 },
    border: { left: BRAND.goldBorder },
    children: [new TextRun({
      text,
      font: BRAND.sans,
      size: 24,
      color: BRAND.greyMid,
      italics: true,
    })],
  });
}

function bulletPoint(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 60, after: 60, line: 300 },
    children: [new TextRun({
      text,
      font: BRAND.sans,
      size: 24,
      color: '1A1A1A',
    })],
  });
}

function goldDivider() {
  return new Paragraph({
    spacing: { before: 320, after: 320 },
    border: { bottom: BRAND.goldBorder },
    children: [new TextRun({ text: '' })],
  });
}

function spacer(lines = 1) {
  return new Paragraph({
    spacing: { before: 0, after: lines * 240 },
    children: [new TextRun({ text: '' })],
  });
}

// ─── STAT BOX (gold number + label) ──────────────────────────────────────────

function statRow(stats) {
  // stats = [{ number: '8+', label: 'Data Sources' }, ...]
  const cells = stats.map(s => new TableCell({
    width: { size: Math.floor(9000 / stats.length), type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: 'F5F3EE' },
    borders: {
      top: BRAND.goldBorder,
      bottom: BRAND.noBorder,
      left: BRAND.noBorder,
      right: { style: BorderStyle.SINGLE, size: 4, color: 'E8D48B' },
    },
    margins: { top: 160, bottom: 160, left: 160, right: 160 },
    children: [
      new Paragraph({
        children: [new TextRun({
          text: s.number,
          font: BRAND.serif,
          size: 56,
          color: BRAND.gold,
          bold: false,
        })],
      }),
      new Paragraph({
        children: [new TextRun({
          text: s.label.toUpperCase(),
          font: BRAND.mono,
          size: 14,
          color: BRAND.greyMid,
          characterSpacing: 80,
        })],
      }),
    ],
  }));

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    rows: [new TableRow({ children: cells })],
  });
}

// ─── DATA TABLE ───────────────────────────────────────────────────────────────

function dataTable(headers, rows) {
  const headerCells = headers.map(h => new TableCell({
    shading: { type: ShadingType.CLEAR, fill: BRAND.navy },
    borders: {
      bottom: BRAND.goldBorder,
      top: BRAND.noBorder, left: BRAND.noBorder, right: BRAND.noBorder,
    },
    margins: { top: 100, bottom: 100, left: 120, right: 120 },
    children: [new Paragraph({
      children: [new TextRun({
        text: h.toUpperCase(),
        font: BRAND.mono,
        size: 16,
        color: BRAND.gold,
        characterSpacing: 80,
      })],
    })],
  }));

  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map(cell => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: ri % 2 === 0 ? 'F9F8F6' : BRAND.white },
      borders: {
        bottom: { style: BorderStyle.SINGLE, size: 2, color: 'E8D8C0' },
        top: BRAND.noBorder, left: BRAND.noBorder, right: BRAND.noBorder,
      },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        children: [new TextRun({
          text: String(cell),
          font: BRAND.sans,
          size: 22,
          color: '1A1A1A',
        })],
      })],
    })),
  }));

  return new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [new TableRow({ children: headerCells }), ...dataRows],
  });
}

// ─── HEADER / FOOTER ─────────────────────────────────────────────────────────

function makeHeader(docTitle) {
  return new Header({
    children: [
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: 'C8A951' } },
        spacing: { after: 0 },
        children: [
          new TextRun({ text: 'TPCH  ', font: BRAND.serif, size: 20, bold: true, color: BRAND.navy }),
          new TextRun({ text: '|  ', font: BRAND.sans, size: 20, color: 'C8A951' }),
          new TextRun({ text: docTitle, font: BRAND.sans, size: 20, color: BRAND.greyMid }),
        ],
      }),
    ],
  });
}

function makeFooter() {
  return new Footer({
    children: [
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'C8A951' } },
        alignment: AlignmentType.RIGHT,
        spacing: { before: 60 },
        children: [
          new TextRun({
            text: 'The Property Clearing House  ·  Channel Partner Intelligence — Australia  ·  tpch.com.au',
            font: BRAND.sans,
            size: 16,
            color: BRAND.greyMid,
          }),
        ],
      }),
    ],
  });
}

// ─── COVER PAGE ───────────────────────────────────────────────────────────────

function coverPage(config) {
  const { title, subtitle, docType, date, recipientName, recipientCompany, preparedBy } = config;

  return [
    // Navy block at top — simulated with a table cell
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows: [new TableRow({
        children: [new TableCell({
          shading: { type: ShadingType.CLEAR, fill: BRAND.navy },
          borders: { top: BRAND.noBorder, bottom: BRAND.noBorder, left: BRAND.noBorder, right: BRAND.noBorder },
          margins: { top: 480, bottom: 480, left: 480, right: 480 },
          children: [
            new Paragraph({
              children: [new TextRun({
                text: (docType || 'DOCUMENT').toUpperCase(),
                font: BRAND.mono,
                size: 16,
                color: BRAND.gold,
                characterSpacing: 160,
              })],
              spacing: { after: 200 },
            }),
            new Paragraph({
              children: [new TextRun({
                text: title,
                font: BRAND.serif,
                size: 72,
                color: BRAND.cream,
              })],
              spacing: { after: 120 },
            }),
            subtitle ? new Paragraph({
              children: [new TextRun({
                text: subtitle,
                font: BRAND.serif,
                size: 40,
                italics: true,
                color: BRAND.gold,
              })],
              spacing: { after: 0 },
            }) : new Paragraph({ children: [new TextRun({ text: '' })] }),
          ],
        })],
      })],
    }),

    spacer(1),

    // Recipient / meta block
    new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows: [new TableRow({
        children: [
          new TableCell({
            width: { size: 4500, type: WidthType.DXA },
            borders: { top: BRAND.goldBorder, bottom: BRAND.noBorder, left: BRAND.noBorder, right: BRAND.noBorder },
            margins: { top: 200, bottom: 0, left: 0, right: 0 },
            children: [
              new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: 'PREPARED FOR', font: BRAND.mono, size: 14, color: BRAND.greyMid, characterSpacing: 100 })],
              }),
              new Paragraph({
                spacing: { after: 40 },
                children: [new TextRun({ text: recipientName || '', font: BRAND.serif, size: 28, color: BRAND.navy })],
              }),
              new Paragraph({
                children: [new TextRun({ text: recipientCompany || '', font: BRAND.sans, size: 22, color: BRAND.greyMid })],
              }),
            ],
          }),
          new TableCell({
            width: { size: 4500, type: WidthType.DXA },
            borders: { top: BRAND.goldBorder, bottom: BRAND.noBorder, left: BRAND.noBorder, right: BRAND.noBorder },
            margins: { top: 200, bottom: 0, left: 480, right: 0 },
            children: [
              new Paragraph({
                spacing: { after: 60 },
                children: [new TextRun({ text: 'DATE', font: BRAND.mono, size: 14, color: BRAND.greyMid, characterSpacing: 100 })],
              }),
              new Paragraph({
                spacing: { after: 40 },
                children: [new TextRun({ text: date || new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }), font: BRAND.sans, size: 22, color: BRAND.navy })],
              }),
              new Paragraph({
                children: [new TextRun({ text: preparedBy || 'The Property Clearing House', font: BRAND.sans, size: 22, color: BRAND.greyMid })],
              }),
            ],
          }),
        ],
      })],
    }),

    spacer(2),

    new Paragraph({
      children: [new PageBreak()],
    }),
  ];
}

// ─── MAIN BUILD FUNCTION ──────────────────────────────────────────────────────

async function buildDocument(config) {
  const {
    outputFile = 'output.docx',
    docTitle = config.title || 'TPCH Document',
    sections: contentSections = [],
  } = config;

  const bodyChildren = [];

  // Cover page
  bodyChildren.push(...coverPage(config));

  // Content sections
  for (const section of contentSections) {
    switch (section.type) {

      case 'overline':
        bodyChildren.push(overlineLabel(section.text));
        break;

      case 'heading':
        bodyChildren.push(sectionHeading(section.text));
        break;

      case 'subheading':
        bodyChildren.push(subHeading(section.text));
        break;

      case 'body':
        for (const para of (section.paragraphs || [section.text])) {
          bodyChildren.push(bodyText(para, section.options));
        }
        break;

      case 'callout':
        bodyChildren.push(calloutText(section.text));
        break;

      case 'bullets':
        for (const item of section.items) {
          bodyChildren.push(bulletPoint(item));
        }
        break;

      case 'divider':
        bodyChildren.push(goldDivider());
        break;

      case 'spacer':
        bodyChildren.push(spacer(section.lines || 1));
        break;

      case 'stats':
        bodyChildren.push(statRow(section.stats));
        bodyChildren.push(spacer(1));
        break;

      case 'table':
        bodyChildren.push(dataTable(section.headers, section.rows));
        bodyChildren.push(spacer(1));
        break;

      case 'pagebreak':
        bodyChildren.push(new Paragraph({ children: [new PageBreak()] }));
        break;

      case 'disclaimer':
        bodyChildren.push(goldDivider());
        bodyChildren.push(bodyText(
          section.text || 'This document is prepared by The Property Clearing House for channel partner use only and does not constitute financial advice. Always conduct your own due diligence. © TPCH ' + new Date().getFullYear(),
          { color: BRAND.greyMid, italic: true }
        ));
        break;

      default:
        if (section.text) bodyChildren.push(bodyText(section.text));
    }
  }

  const doc = new Document({
    creator: 'The Property Clearing House',
    title: docTitle,
    description: 'TPCH Branded Document',
    styles: {
      default: {
        document: {
          run: { font: BRAND.sans, size: 24, color: '1A1A1A' },
          paragraph: { spacing: { line: 320 } },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          margin: {
            top:    BRAND.marginTop,
            bottom: BRAND.marginBottom,
            left:   BRAND.marginLeft,
            right:  BRAND.marginRight,
          },
        },
      },
      headers: { default: makeHeader(docTitle) },
      footers: { default: makeFooter() },
      children: bodyChildren,
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputFile, buffer);
  console.log(`✓ Document written: ${outputFile}`);
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node build.js <config.json>');
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
buildDocument(config).catch(err => { console.error(err); process.exit(1); });
