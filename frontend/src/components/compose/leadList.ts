import { isValidEmail } from './RecipientsInput';

export interface LeadImport {
  /** Valid, lowercased, de-duplicated addresses in file order. */
  emails: string[];
  /** Non-empty rows without a valid address in the email column. */
  skipped: number;
  /** Repeats within the file. */
  duplicates: number;
  /** How the addresses were found (shown to the user). */
  source: 'header' | 'column' | 'scan';
}

const HEADER = /^\s*(e-?mail|e-?mail[ _-]?address|email[ _-]?id|mail|address)\s*$/i;
const ANY_EMAIL = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;

/** RFC 4180-style parsing: quoted fields, "" escapes, delimiters/newlines inside quotes. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const [best] = counts.sort((a, b) => b[1] - a[1]);
  return best[1] > 0 ? best[0] : ',';
}

/**
 * Extracts recipient addresses from a CSV/TSV/TXT lead list:
 *   1. a column whose header looks like "email" → that column;
 *   2. otherwise the column where most cells are email addresses;
 *   3. otherwise every address found anywhere in the text (plain lists, odd formats).
 */
export function parseLeadList(raw: string): LeadImport {
  const text = raw.replace(/^﻿/, '');
  const rows = parseCsv(text, detectDelimiter(text));
  const clean = (s: string | undefined) => (s ?? '').trim().replace(/^mailto:/i, '').toLowerCase();

  let column = -1;
  let body = rows;
  let source: LeadImport['source'] = 'scan';

  const headerCol = rows[0]?.findIndex((cell) => HEADER.test(cell)) ?? -1;
  if (headerCol >= 0) {
    column = headerCol;
    body = rows.slice(1);
    source = 'header';
  } else if (rows.length) {
    const sample = rows.slice(0, 200);
    const width = Math.max(...sample.map((r) => r.length));
    let bestScore = 0;
    for (let c = 0; c < width; c++) {
      const cells = sample.map((r) => clean(r[c])).filter(Boolean);
      const score = cells.length ? cells.filter(isValidEmail).length / cells.length : 0;
      if (score > bestScore) { bestScore = score; column = c; }
    }
    if (bestScore >= 0.5) {
      source = 'column';
      if (!isValidEmail(clean(rows[0][column]))) body = rows.slice(1); // a header we didn't recognise
    } else {
      column = -1;
    }
  }

  const seen = new Set<string>();
  const emails: string[] = [];
  let skipped = 0;
  let duplicates = 0;
  const add = (e: string) => {
    if (seen.has(e)) { duplicates++; return; }
    seen.add(e);
    emails.push(e);
  };

  if (column >= 0) {
    for (const r of body) {
      const e = clean(r[column]);
      if (isValidEmail(e)) add(e);
      else skipped++;
    }
  } else {
    for (const m of text.matchAll(ANY_EMAIL)) {
      const e = m[0].toLowerCase();
      if (isValidEmail(e)) add(e);
    }
  }
  return { emails, skipped, duplicates, source };
}
