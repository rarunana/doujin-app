// CSVの読み取りと、コミケWebカタログのお気に入り(チェックリスト形式)の判別。

import { cleanName, parseDayHint, parseSpace, takeXHandle } from './parseSpace.js';
import { toXHandle } from './util.js';
import type { DayHint, LineError, ParsedLine } from './parseSpace.js';

/** UTF-8 として読めなければ Shift_JIS として読む(古いカタログ形式向け) */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

/** ダブルクォート(中のカンマ・改行・"" を含む)に対応したCSV解析 */
export function parseCsv(text: string, opts: { keepEmpty?: boolean } = {}): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (opts.keepEmpty) return rows;
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---- コミケのチェックリスト形式 ----
// Header,ComicMarketCD-ROMCatalog,ComicMarket107,UTF-8,...
// Circle,シリアル,色,ページ,カット位置,曜日,地区,ブロック,スペース番号,ジャンル,サークル名,読み,執筆者名,
//        発行誌名,URL,メール,補足説明,メモ,X,Y,レイアウト,スペース番号補助(0=a,1=b),...
const C = { week: 5, hall: 6, block: 7, number: 8, name: 10, author: 12, url: 14, memo: 17, sub: 21 } as const;

/** URL列から順に、X(Twitter)のURLが入っている欄を探す */
function findXInRow(r: string[], from: number): string {
  for (let i = from; i < r.length; i++) {
    if (!/(?:x|twitter)\.com\//i.test(r[i] ?? '')) continue;
    const { handle } = takeXHandle(r[i]);
    if (handle) return handle;
  }
  return '';
}

export function isComiketChecklist(rows: string[][]): boolean {
  return rows.some((r) => r[0] === 'Header' && /ComicMarket/i.test(r[1] ?? '')) ||
    rows.filter((r) => r[0] === 'Circle').length > 0 && rows.filter((r) => r[0] === 'Circle').every(looksLikeCircle);
}

function looksLikeCircle(r: string[]): boolean {
  return r.length > C.name && /^\d{1,3}$/.test((r[C.number] ?? '').trim());
}

export function fromComiketChecklist(rows: string[][]): { rows: ParsedLine[]; errors: LineError[] } {
  const out: ParsedLine[] = [];
  const errors: LineError[] = [];
  rows.forEach((r, idx) => {
    if (r[0] !== 'Circle') return;
    const source = r.slice(0, C.name + 1).join(',');
    if (!looksLikeCircle(r)) {
      errors.push({ line: idx + 1, source, error: '列の並びが想定と違います' });
      return;
    }
    const sub = (r[C.sub] ?? '').trim();
    const suffix = sub === '0' ? 'a' : sub === '1' ? 'b' : '';
    const memo = (r[C.memo] ?? '').trim();
    out.push({
      line: idx + 1,
      source,
      day: weekToHint(r[C.week] ?? ''),
      hall: (r[C.hall] ?? '').trim(),
      block: (r[C.block] ?? '').trim(),
      number: `${r[C.number].trim().padStart(2, '0')}${suffix}`,
      name: (r[C.name] ?? '').trim(),
      memo,
      xHandle: findXInRow(r, C.url),
      penName: (r[C.author] ?? '').trim(),
    });
  });
  return { rows: out, errors };
}

function weekToHint(v: string): DayHint {
  const t = v.trim();
  if (/^\d+$/.test(t)) return { kind: 'index', n: Number(t) };
  if (/^[月火水木金土日]$/.test(t)) return { kind: 'weekday', w: t };
  const md = /(?:\d{4}[-/年])?(\d{1,2})[-/月](\d{1,2})/.exec(t);
  if (md) return { kind: 'date', m: Number(md[1]), d: Number(md[2]) };
  return parseDayHint(t);
}

// ---- 列を指定して読む(形式が分からないCSV向け) ----
export interface ColumnMap {
  name: number; // -1 = 使わない
  space: number;
  day: number;
  memo: number;
  x: number; // X(Twitter)
  pen: number; // ペンネーム
  header: boolean; // 1行目が見出しか
}

/** 見出しの文字から、列の割り当てを推測する */
export function guessColumns(rows: string[][]): ColumnMap {
  const head = rows[0] ?? [];
  const find = (re: RegExp): number => head.findIndex((h) => re.test(h));
  const map: ColumnMap = {
    name: find(/サークル|circle|名前|name/i),
    space: find(/配置|スペース|space|場所|位置/i),
    day: find(/^\s*日\s*$|日目|曜|日付|開催日|day|date/i),
    memo: find(/メモ|memo|備考|note/i),
    x: find(/twitter|ツイッター|^\s*x\s*$|エックス/i),
    pen: find(/ペンネーム|作家|執筆者|pen/i),
    header: false,
  };
  map.header = [map.name, map.space, map.day, map.memo, map.x, map.pen].some((i) => i >= 0);
  if (!map.header) {
    // 見出しが無ければ、配置番号として読める列を探す
    const sample = rows.slice(0, 10);
    const width = Math.max(0, ...sample.map((r) => r.length));
    for (let c = 0; c < width && map.space < 0; c++) {
      if (sample.filter((r) => parseSpace(r[c] ?? '')).length >= Math.ceil(sample.length / 2)) map.space = c;
    }
    map.name = map.space === 0 ? 1 : 0;
  }
  return map;
}

export function fromColumns(rows: string[][], map: ColumnMap): { rows: ParsedLine[]; errors: LineError[] } {
  const out: ParsedLine[] = [];
  const errors: LineError[] = [];
  const body = map.header ? rows.slice(1) : rows;
  const offset = map.header ? 2 : 1;
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '');
  body.forEach((r, idx) => {
    const source = r.join(',');
    const space = map.space >= 0 ? parseSpace(cell(r, map.space)) : null;
    if (!space) {
      errors.push({ line: idx + offset, source, error: '配置番号が読み取れません' });
      return;
    }
    // X の列が無ければ、サークル名の欄に書かれた @アカウント名 を拾う
    const fromName = takeXHandle(cell(r, map.name));
    const xHandle = map.x >= 0 ? (takeXHandle(cell(r, map.x)).handle || toXHandle(cell(r, map.x)) || '') : fromName.handle;
    out.push({
      line: idx + offset,
      source,
      day: map.day >= 0 ? weekToHint(cell(r, map.day)) : null,
      name: cleanName(map.x >= 0 ? cell(r, map.name) : fromName.rest),
      memo: cell(r, map.memo),
      xHandle,
      penName: cell(r, map.pen),
      ...space,
    });
  });
  return { rows: out, errors };
}
