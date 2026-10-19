import type { CircleRec, ItemRec } from './types.js';

export function uid(): string {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const yenFmt = new Intl.NumberFormat('ja-JP');
export const yen = (n: number): string => `¥${yenFmt.format(n)}`;

export function esc(s: string | number | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 「東」「ア」「01a」→「東ア-01a」 */
export function spaceLabel(c: Pick<CircleRec, 'hall' | 'block' | 'number'>): string {
  const head = `${c.hall}${c.block}`;
  if (!head && !c.number) return '配置未設定';
  return c.number ? `${head}-${c.number}` : head;
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

/** ビッグサイトの並び(東 → 西 → 南)。それ以外の表記は後ろに名前順 */
function hallRank(hall: string): number {
  const i = ['東', '西', '南'].indexOf(hall.trim().charAt(0));
  return i === -1 ? 3 : i;
}

/** ホール → ブロック → 番号 の順(番号は 9 < 10 の数値順) */
export function compareSpace(a: CircleRec, b: CircleRec): number {
  return (
    hallRank(a.hall) - hallRank(b.hall) ||
    collator.compare(a.hall, b.hall) ||
    collator.compare(a.block, b.block) ||
    collator.compare(a.number, b.number) ||
    collator.compare(a.name, b.name)
  );
}

export const itemTotal = (i: ItemRec): number => i.price * i.qty;

export interface Totals {
  planned: number; // 購入予定(未購入 + 購入済み)
  bought: number; // 購入済み
  count: number; // 予定点数
  boughtCount: number;
}

export function totals(items: ItemRec[]): Totals {
  const t: Totals = { planned: 0, bought: 0, count: 0, boughtCount: 0 };
  for (const i of items) {
    if (i.status === 'todo' || i.status === 'bought') {
      t.planned += itemTotal(i);
      t.count += i.qty;
    }
    if (i.status === 'bought') {
      t.bought += itemTotal(i);
      t.boughtCount += i.qty;
    }
  }
  return t;
}

// ---- X(Twitter) ----
// アカウント名ではないパス(x.com/home など)
const X_RESERVED = new Set(['home', 'i', 'intent', 'search', 'hashtag', 'share', 'explore', 'settings', 'messages', 'notifications', 'login']);
const X_URL_RE = /(?:^|\/\/|\.)(?:x|twitter)\.com\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/i;
const X_HANDLE_RE = /^@?([A-Za-z0-9_]{1,15})$/;

/**
 * 「@abc」「abc」「https://x.com/abc」「twitter.com/abc/status/1」→「abc」
 * 空なら ''、読み取れなければ null
 */
export function toXHandle(input: string): string | null {
  const s = input.normalize('NFKC').trim();
  if (!s) return '';
  const url = X_URL_RE.exec(s);
  if (url) return X_RESERVED.has(url[1].toLowerCase()) ? null : url[1];
  const h = X_HANDLE_RE.exec(s);
  return h ? h[1] : null;
}

export const xUrl = (handle: string): string => `https://x.com/${encodeURIComponent(handle)}`;

/** 全角数字やカンマ混じりの入力を整数にする */
export function toInt(v: string, fallback = 0): number {
  const n = parseInt(
    v.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)).replace(/[,，\s]/g, ''),
    10,
  );
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
