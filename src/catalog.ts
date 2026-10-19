// カタログ(イベントの全サークル一覧): 表の列の割り当て、行からの変換、検索、買い物リストとの突き合わせ。
// 画面に依存しない処理だけを置く。

import { parseSpace, parseDayHint, spaceKey, takeXHandle } from './parseSpace.js';
import type { DayHint } from './parseSpace.js';
import type { Cell, Table } from './tableParse.js';
import type { CatalogRec, CircleRec } from './types.js';
import { compareSpace, toXHandle } from './util.js';

export interface CatalogColumns {
  block: number; // 組・ブロック(番号と別の列のとき)。-1 = 使わない
  space: number; // 番号、または配置番号全体
  name: number;
  pen: number;
  tags: number;
  home: number;
  x: number;
  day: number;
}

export const NO_COLUMNS: CatalogColumns = { block: -1, space: -1, name: -1, pen: -1, tags: -1, home: -1, x: -1, day: -1 };

const HEAD = {
  block: /^(組|ブロック|島|block)$/i,
  space: /^(no\.?|番号|スペース|配置|配置番号|space|場所|位置)$/i,
  name: /サークル|circle/i,
  pen: /ペンネーム|ペンネ|作家|代表|pen/i,
  tags: /アイドル|キャラ|ジャンル|作品|カップリング|cp|備考/i,
  home: /^(home|ホーム|サイト|url|web|website|pixiv)$/i,
  x: /^(x|twitter|ツイッター|エックス)$/i,
  day: /^(日|日程|日目|開催日|曜日|day|date)$/i,
};

/** 見出し行を探して列の割り当てを推測する。見出しが無ければ中身から推測 */
export function guessColumns(table: Table): { columns: CatalogColumns; headerRow: number } {
  const cols = { ...NO_COLUMNS };
  for (let r = 0; r < Math.min(table.length, 8); r++) {
    const row = table[r].map((c) => c.text.trim());
    if (!row.some((t) => HEAD.name.test(t))) continue;
    (Object.keys(HEAD) as (keyof typeof HEAD)[]).forEach((k) => {
      cols[k] = row.findIndex((t) => HEAD[k].test(t));
    });
    return { columns: cols, headerRow: r };
  }
  // 見出しが無い: 配置番号として読める列を探し、その次の列をサークル名とみなす
  const sample = table.slice(0, 20);
  const width = Math.max(0, ...sample.map((r) => r.length));
  for (let c = 0; c < width && cols.space < 0; c++) {
    if (sample.filter((r) => parseSpace(r[c]?.text ?? '')).length >= Math.ceil(sample.length / 2)) cols.space = c;
  }
  if (cols.space >= 0) cols.name = cols.space + 1 < width ? cols.space + 1 : -1;
  return { columns: cols, headerRow: -1 };
}

export interface ConvertResult {
  entries: CatalogRec[];
  skipped: number; // 配置番号が読めず飛ばした行(見出し・区切り行を含む)
}

/**
 * 表の行をカタログに変換する。配置番号が読めない行(見出しや「◇1組」のような区切り行)は飛ばす。
 * dayFor: 行の日の指定 → 開催日ID(指定が無い・合わない行は既定の日)
 */
export function convertRows(
  table: Table,
  cols: CatalogColumns,
  ctx: { eventId: string; dayFor: (hint: DayHint) => string; newId: () => string },
): ConvertResult {
  const entries: CatalogRec[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const text = (row: Cell[], i: number): string => (i >= 0 ? row[i]?.text ?? '' : '');
  for (const row of table) {
    const spaceText = text(row, cols.space);
    // 番号の列だけで配置が読めればそれを使い、読めなければ組・ブロックの列と合わせて読む
    const space = (cols.block < 0 ? parseSpace(spaceText) : null) ?? parseSpace(`${text(row, cols.block)}${spaceText}`);
    const name = text(row, cols.name);
    if (!space || (!name && cols.name >= 0)) {
      skipped++;
      continue;
    }
    const dayId = ctx.dayFor(cols.day >= 0 ? parseDayHint(text(row, cols.day)) ?? weekdayCell(text(row, cols.day)) : null);
    const key = `${dayId}#${spaceKey(space)}#${name}`;
    if (seen.has(key)) continue; // 同じ行が重複していたら1件にまとめる
    seen.add(key);
    entries.push({
      id: ctx.newId(),
      eventId: ctx.eventId,
      dayId,
      ...space,
      name,
      penName: text(row, cols.pen),
      tags: text(row, cols.tags),
      homeUrl: homeOf(row, cols),
      xHandle: xOf(row, cols),
    });
  }
  return { entries, skipped };
}

function weekdayCell(t: string): DayHint {
  const s = t.trim();
  return /^[月火水木金土日]$/.test(s) ? { kind: 'weekday', w: s } : null;
}

const isX = (url: string): boolean => /(?:^|\/\/|\.)(?:x|twitter)\.com\//i.test(url);

function xOf(row: Cell[], cols: CatalogColumns): string {
  // X の列があればそのセル、無ければ行全体のリンクから探す
  const cells = cols.x >= 0 ? [row[cols.x]].filter(Boolean) : row;
  for (const cell of cells) {
    for (const href of cell.hrefs) {
      if (!isX(href)) continue;
      const h = toXHandle(href);
      if (h) return h;
    }
  }
  if (cols.x >= 0) {
    const t = row[cols.x]?.text ?? '';
    return takeXHandle(t).handle || toXHandle(t) || '';
  }
  return '';
}

function homeOf(row: Cell[], cols: CatalogColumns): string {
  if (cols.home < 0) return '';
  const cell = row[cols.home];
  return cell?.hrefs.find((h) => !isX(h)) ?? (/^https?:\/\//i.test(cell?.text ?? '') ? cell.text : '');
}

// ---- 検索 ----

/** 検索用に文字をそろえる: 全角半角・大文字小文字・カタカナ/ひらがな・空白やハイフンの違いを無視 */
export function normalizeForSearch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s\-‐ー−・_]/g, '');
}

const keyCache = new WeakMap<CatalogRec, { name: string; all: string }>();
function keysOf(e: CatalogRec): { name: string; all: string } {
  let k = keyCache.get(e);
  if (!k) {
    const name = normalizeForSearch(e.name);
    k = {
      name,
      all: [name, e.penName, e.tags, `${e.hall}${e.block}${e.number}`, e.xHandle].map(normalizeForSearch).join('\n'),
    };
    keyCache.set(e, k);
  }
  return k;
}

/**
 * 名前・ペンネーム・作品/キャラ・配置・Xアカウントから探す。空白区切りの語はすべて含むもの(AND)。
 * 並び: サークル名の先頭一致 → サークル名に含む → その他に含む、同じ順位は配置順。
 */
export function searchCatalog(entries: CatalogRec[], query: string, limit = 50): { hits: CatalogRec[]; total: number } {
  const words = query.split(/\s+/).map(normalizeForSearch).filter(Boolean);
  if (words.length === 0) {
    const all = [...entries].sort(bySpace);
    return { hits: all.slice(0, limit), total: all.length };
  }
  const scored: { e: CatalogRec; rank: number }[] = [];
  for (const e of entries) {
    const k = keysOf(e);
    if (!words.every((w) => k.all.includes(w))) continue;
    const rank = k.name.startsWith(words[0]) ? 0 : k.name.includes(words[0]) ? 1 : 2;
    scored.push({ e, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || bySpace(a.e, b.e));
  return { hits: scored.slice(0, limit).map((s) => s.e), total: scored.length };
}

const bySpace = (a: CatalogRec, b: CatalogRec): number => compareSpace(a as unknown as CircleRec, b as unknown as CircleRec);

// ---- 買い物リストとの突き合わせ ----

export interface CatalogDiff {
  circle: CircleRec;
  kind: 'moved' | 'missing'; // 配置が違う / 一覧に見つからない
  entry?: CatalogRec; // moved のとき、一覧側のサークル
}

/**
 * 買い物リストのサークルを一覧と照らし合わせる(一覧が更新されたときの確認用)。
 * サークル名が一致して配置が違えば「配置が違う」、名前でも配置でも見つからなければ「見つからない」。
 * 一覧が無い日のサークルは対象外。
 */
export function diffWithCatalog(circles: CircleRec[], catalog: CatalogRec[]): CatalogDiff[] {
  const byDay = new Map<string, CatalogRec[]>();
  for (const e of catalog) byDay.set(e.dayId, [...(byDay.get(e.dayId) ?? []), e]);
  const out: CatalogDiff[] = [];
  for (const c of circles) {
    const list = byDay.get(c.dayId);
    if (!list) continue;
    const key = spaceKey(c);
    const named = c.name.trim() !== '' || (c.penName ?? '').trim() !== '';
    if (list.some((e) => spaceKey(e) === key && (!named || sameCircle(c, e)))) continue; // 一致
    const sameName = named ? list.find((e) => sameCircle(c, e)) : undefined;
    if (sameName) out.push({ circle: c, kind: 'moved', entry: sameName });
    else if (!list.some((e) => spaceKey(e) === key)) out.push({ circle: c, kind: 'missing' });
  }
  return out;
}

/**
 * 同じサークルを指しているか。サークル名どうし・ペンネームどうしのほか、
 * 買い物リスト側にペンネームをサークル名として入れていた場合も一致とみなす
 */
function sameCircle(c: CircleRec, e: CatalogRec): boolean {
  const mine = [c.name, c.penName ?? ''].map(normalizeForSearch).filter(Boolean);
  const theirs = [e.name, e.penName].map(normalizeForSearch).filter(Boolean);
  return mine.some((m) => theirs.includes(m));
}

/** 買い物リストにすでにあるか(同じ日で、配置かサークル名・ペンネームが一致) */
export function isInList(e: CatalogRec, circles: CircleRec[]): boolean {
  const key = spaceKey(e);
  return circles.some((c) => c.dayId === e.dayId && (spaceKey(c) === key || sameCircle(c, e)));
}

/** カタログの1件から、買い物リストのサークルを作る */
export function circleFromCatalog(e: CatalogRec, id: string, priority: CircleRec['priority'], order: number): CircleRec {
  return {
    id,
    dayId: e.dayId,
    name: e.name,
    hall: e.hall,
    block: e.block,
    number: e.number,
    priority,
    order,
    memo: '',
    ...(e.penName ? { penName: e.penName } : {}),
    ...(e.xHandle ? { xHandle: e.xHandle } : {}),
  };
}
