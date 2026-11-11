#!/usr/bin/env node
// Generates src/encoding/gsm7-national.ts: the national language locking and single shift tables of
// 3GPP TS 23.038 (Release 9+, annex A.2 and A.3).
//
//   curl -o gsm0338.wiki 'https://en.wikipedia.org/w/index.php?title=GSM_03.38&action=raw'
//   node scripts/gen-gsm7-national.mjs gsm0338.wiki
//
// Source: the tables of the "GSM 03.38" Wikipedia article, which reproduces 3GPP TS 23.038. The script
// cross-checks the source against tables we already trust (default alphabet, Turkish/Spanish/Portuguese
// single shift) and refuses to write anything if they differ.

import { readFileSync, writeFileSync } from 'node:fs';

const LANGS = {
  // section title prefix → [code, id]
  'Turkish language': ['tr', 1],
  'Spanish language': ['es', 2],
  'Portuguese language': ['pt', 3],
  'Bengali and Assamese': ['bn', 4],
  'Gujarati language': ['gu', 5],
  'Hindi language': ['hi', 6],
  'Kannada language': ['kn', 7],
  'Malayalam language': ['ml', 8],
  'Oriya language': ['or', 9],
  'Punjabi language': ['pa', 10],
  'Tamil language': ['ta', 11],
  'Telugu language': ['te', 12],
  'Urdu language': ['ur', 13],
};

const CONTROLS = { SP: ' ', LF: '\n', CR: '\r', FF: '\f', ESC: '\u001b', CR2: '\r', SS2: '\u001b' };

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': '' };

/** Named and numeric HTML entities. */
function decodeEntities(text) {
  let out = text
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  return out;
}

/** A combining mark is shown on a dotted circle (U+25CC): keep the mark only. */
function stripDottedCircle(text) {
  const stripped = text.replace(/\u25cc/g, '');
  return stripped === '' ? text : stripped;
}

/** Value of one wikitext table cell, or undefined when the position is not defined. */
function cellValue(raw) {
  let cell = raw.trim();
  // Attributes before the content: `title="…"| content` or `style="…"| content`.
  const attr = /^((?:\s*[a-z-]+="[^"]*")+)\s*\|(?!\|)/i.exec(cell);
  if (attr) cell = cell.slice(attr[0].length).trim();
  cell = cell.replace(/\{\{pipe\}\}/g, '|');
  const small = /^<small>([A-Z0-9]+)<\/small>/.exec(cell);
  if (small) {
    if (!(small[1] in CONTROLS)) throw new Error(`unknown control ${small[1]}`);
    return CONTROLS[small[1]];
  }
  const link = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(cell);
  if (link) {
    const target = link[1];
    const display = link[2];
    let value;
    if (display === undefined) value = target;
    else if (display.includes('\u25cc'))
      value = target; // combining mark shown on a dotted circle
    else value = display;
    return stripDottedCircle(decodeEntities(value));
  }
  let text = decodeEntities(cell);
  text = stripDottedCircle(text.replace(/<[^>]+>/g, '').trim());
  return text === '' ? undefined : text;
}

/** Parses one 8-column × 16-row table into a 128-entry array (undefined = not defined). */
function parseTable(lines) {
  const table = new Array(128).fill(undefined);
  let row = -1;
  for (const line of lines) {
    const header = /^!scope="row"\s*\|\s*0x([0-9A-F]{2})/i.exec(line);
    if (header) {
      row = Number.parseInt(header[1], 16);
      continue;
    }
    if (
      row < 0 ||
      !line.startsWith('|') ||
      line.startsWith('|-') ||
      line.startsWith('|}') ||
      line.startsWith('|+')
    ) {
      continue;
    }
    const cells = line.slice(1).split('||');
    if (cells.length !== 8) throw new Error(`row 0x${row.toString(16)}: ${cells.length} cells`);
    cells.forEach((c, col) => {
      table[col * 16 + row] = cellValue(c);
    });
    row = -1;
  }
  return table;
}

function sections(wiki) {
  const out = {};
  const parts = wiki.split(/^=== /m).slice(1);
  for (const part of parts) {
    const title = part.slice(0, part.indexOf('==='));
    const lang = Object.entries(LANGS).find(([prefix]) => title.startsWith(prefix));
    if (!lang) continue;
    const tables = part.split(/^\{\|class="wikitable"/m).slice(1);
    const parsed = {};
    for (const t of tables) {
      const caption = /^\|\+(.*)$/m.exec(t)?.[1] ?? '';
      const body = t.slice(0, t.indexOf('\n|}')).split('\n');
      if (/^\s*Locking Shift/i.test(caption)) parsed.locking = parseTable(body);
      else if (/^\s*Single Shift/i.test(caption)) parsed.single = parseTable(body);
      else if (/Basic Character Set/i.test(caption)) parsed.basic = parseTable(body);
    }
    out[lang[1][0]] = { id: lang[1][1], ...parsed };
  }
  return out;
}

const wiki = readFileSync(process.argv[2] ?? 'gsm0338.wiki', 'utf8');
const langs = sections(wiki);

// ---------------------------------------------------------------- corrections
// Errors of the Wikipedia transcription, each one visible inside the source itself. Each correction
// checks the wrong value first: if the source gets fixed, the script stops and says so.
const CORRECTIONS = [
  // Kannada locking 0x24: ḍa, as in every other Brahmic table (Telugu డ, Hindi ड…); the source repeats pa (0x3D).
  { lang: 'kn', kind: 'locking', pos: 0x24, wrong: '\u0caa', right: '\u0ca1' },
  // Kannada single 0x3C: the cell is titled "opening square bracket" but holds "]".
  { lang: 'kn', kind: 'single', pos: 0x3c, wrong: ']', right: '[' },
  // Malayalam single 0x40: the cell is titled "vertical bar" but holds "-" (every other Indic table: "|").
  { lang: 'ml', kind: 'single', pos: 0x40, wrong: '-', right: '|' },
];
for (const c of CORRECTIONS) {
  const table = langs[c.lang]?.[c.kind];
  if (table?.[c.pos] !== c.wrong) {
    console.error(
      `correction ${c.lang} ${c.kind} 0x${c.pos.toString(16)} no longer applies: the source changed`,
    );
    process.exit(1);
  }
  table[c.pos] = c.right;
}

// ---------------------------------------------------------------- precomposed letters
// The source is NFC-normalized, which decomposes the nukta letters (U+0958–095F, U+09DC…): 23.038 uses
// the precomposed code points. Put them back.
for (const [code, l] of Object.entries(langs)) {
  for (const table of [l.locking, l.single]) {
    if (!table) continue;
    table.forEach((ch, i) => {
      if (ch === undefined || [...ch].length < 2) return;
      let pre;
      for (let cp = 0x900; cp < 0xe00 && !pre; cp++) {
        const c = String.fromCodePoint(cp);
        if (c !== ch && c.normalize('NFD') === ch.normalize('NFD')) pre = c;
      }
      if (!pre) {
        console.error(`${code} 0x${i.toString(16)}: ${JSON.stringify(ch)} is not a single character`);
        process.exit(1);
      }
      table[i] = pre;
    });
  }
}

// ---------------------------------------------------------------- cross-checks
const BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const errors = [];
const warnings = [];
const basic = langs.es?.basic;
if (!basic) errors.push('default alphabet not found (Spanish section)');
else
  basic.forEach(
    (ch, i) =>
      ch !== BASIC[i] &&
      errors.push(`basic 0x${i.toString(16)}: ${JSON.stringify(ch)} ≠ ${JSON.stringify(BASIC[i])}`),
  );
const KNOWN_SINGLE = {
  tr: { 71: 'Ğ', 73: 'İ', 83: 'Ş', 99: 'ç', 103: 'ğ', 105: 'ı', 115: 'ş' },
  es: { 9: 'ç', 65: 'Á', 73: 'Í', 79: 'Ó', 85: 'Ú', 97: 'á', 105: 'í', 111: 'ó', 117: 'ú' },
  pt: {
    5: 'ê',
    9: 'ç',
    11: 'Ô',
    12: 'ô',
    14: 'Á',
    15: 'á',
    18: 'Φ',
    19: 'Γ',
    21: 'Ω',
    22: 'Π',
    23: 'Ψ',
    24: 'Σ',
    25: 'Θ',
    31: 'Ê',
    65: 'À',
    73: 'Í',
    79: 'Ó',
    85: 'Ú',
    91: 'Ã',
    92: 'Õ',
    97: 'Â',
    105: 'í',
    111: 'ó',
    117: 'ú',
    123: 'ã',
    124: 'õ',
    127: 'â',
  },
};
const DEFAULT_EXT = {
  10: '\f',
  20: '^',
  40: '{',
  41: '}',
  47: '\\',
  60: '[',
  61: '~',
  62: ']',
  64: '|',
  101: '€',
};
for (const [code, known] of Object.entries(KNOWN_SINGLE)) {
  const single = langs[code]?.single;
  if (!single) {
    errors.push(`${code}: single shift table not found`);
    continue;
  }
  for (const [pos, ch] of Object.entries({ ...DEFAULT_EXT, ...known })) {
    if (single[pos] !== ch)
      errors.push(
        `${code} single 0x${Number(pos).toString(16)}: ${JSON.stringify(single[pos])} ≠ ${JSON.stringify(ch)}`,
      );
  }
}
for (const [code, l] of Object.entries(langs)) {
  if (!l.single) errors.push(`${code}: no single shift table`);
  if (l.locking) {
    if (l.locking[0x1b] !== '\u001b') errors.push(`${code} locking: 0x1B is not ESC`);
  }
  for (const [kind, table] of [
    ['locking', l.locking],
    ['single', l.single],
  ]) {
    if (!table) continue;
    const seen = new Map();
    table.forEach((ch, i) => {
      if (ch === undefined || ch === '\u001b' || ch === '\r') return;
      // 3GPP TS 23.038 itself lists ¡ (0x13, 0x15) and * (0x0B, 0x18) twice in the Indic and Urdu
      // single shift tables: the encoder uses the first position.
      if (kind === 'single' && ((ch === '¡' && i === 0x15) || (ch === '*' && i === 0x18))) return;
      if (seen.has(ch))
        errors.push(
          `${code} ${kind}: ${JSON.stringify(ch)} at 0x${seen.get(ch).toString(16)} and 0x${i.toString(16)}`,
        );
      seen.set(ch, i);
    });
  }
}
// Brahmic Unicode blocks are parallel (from ISCII): the same letter has the same offset in every block.
// A locking position where one language disagrees with the others is suspect.
const BLOCKS = {
  hi: 0x900,
  bn: 0x980,
  pa: 0xa00,
  gu: 0xa80,
  or: 0xb00,
  ta: 0xb80,
  te: 0xc00,
  kn: 0xc80,
  ml: 0xd00,
};
for (let pos = 0; pos < 128; pos++) {
  const offsets = new Map();
  for (const [code, base] of Object.entries(BLOCKS)) {
    const ch = langs[code]?.locking?.[pos];
    const cp = ch?.codePointAt(0);
    if (cp === undefined || ch.length !== 1 || cp < base || cp >= base + 0x80) continue;
    offsets.set(code, cp - base);
  }
  const counts = new Map();
  for (const o of offsets.values()) counts.set(o, (counts.get(o) ?? 0) + 1);
  const [majority, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  if (n === undefined || n < 5) continue;
  for (const [code, o] of offsets) {
    if (o !== majority) {
      warnings.push(
        `${code} locking 0x${pos.toString(16)}: U+${(BLOCKS[code] + o).toString(16)} while ${n} languages use offset 0x${majority.toString(16)}`,
      );
    }
  }
}
if (warnings.length) console.warn(`review (not blocking):\n  ${warnings.join('\n  ')}`);

if (Object.keys(langs).length !== 13)
  errors.push(`expected 13 languages, found ${Object.keys(langs).length}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

// ---------------------------------------------------------------- output
const esc = (s) =>
  [...s]
    .map((c) => {
      const cp = c.codePointAt(0);
      if (cp < 0x20 || cp === 0x27 || cp === 0x5c || cp > 0x7e)
        return `\\u${cp.toString(16).padStart(4, '0')}`;
      return c;
    })
    .join('');
const sparse = (table) =>
  `{ ${table
    .map((ch, i) => (ch === undefined || ch === '\u001b' ? undefined : `${i}: '${esc(ch)}'`))
    .filter(Boolean)
    .join(', ')} }`;

const ordered = Object.entries(langs).sort((a, b) => a[1].id - b[1].id);
const ts = `// Generated by scripts/gen-gsm7-national.mjs from the tables of 3GPP TS 23.038 (annex A). Do not edit.

/** National language identifiers (3GPP TS 23.038 §6.2.1.2.4), value of UDH IE 0x24 / 0x25. */
export const NATIONAL_LANGUAGE_IDS = {
${ordered.map(([c, l]) => `  ${c}: ${l.id},`).join('\n')}
} as const;

export type NationalLanguage = keyof typeof NATIONAL_LANGUAGE_IDS;

/** Single shift tables (after ESC), sparse: septet → character. */
export const SINGLE_SHIFT: Record<NationalLanguage, Readonly<Record<number, string>>> = {
${ordered.map(([c, l]) => `  ${c}: ${sparse(l.single)},`).join('\n')}
};

/** Locking shift tables (replace the default alphabet), sparse. Spanish has none. */
export const LOCKING_SHIFT: Partial<Record<NationalLanguage, Readonly<Record<number, string>>>> = {
${ordered
  .filter(([, l]) => l.locking)
  .map(([c, l]) => `  ${c}: ${sparse(l.locking)},`)
  .join('\n')}
};
`;
writeFileSync(new URL('../src/encoding/gsm7-national.ts', import.meta.url), ts);
console.log(
  `ok: ${Object.keys(langs).length} languages, ${Object.values(langs).filter((l) => l.locking).length} locking tables`,
);
