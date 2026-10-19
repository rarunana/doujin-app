// 配置番号(スペース)の読み取り。画面やデータベースに依存しない純粋な処理。
//
// 対応する書き方の例:
//   コミケ   東ア-01a / 東ア01ab / 西あ-12b / 南a-03 / 東7ア-22a
//   TRC など 5組16 / 5組03,04 / A-01 / ア-12
//   日の指定 1日目 / 土曜 / 土曜日 / (土)  ※行のどこにあってもよい
//   X        @handle / https://x.com/handle   ※行のどこにあってもよい

import { toXHandle } from './util.js';

export interface SpaceParts {
  hall: string; // 東・西・南(+数字)。無ければ空
  block: string;
  number: string; // 2桁にそろえる。複数スペースは「03,04」
}

export type DayHint =
  | { kind: 'index'; n: number } // 1日目
  | { kind: 'weekday'; w: string } // 土
  | { kind: 'date'; m: number; d: number } // 12/30
  | null;

export interface ParsedLine extends SpaceParts {
  line: number; // 1始まりの行番号
  source: string;
  name: string;
  day: DayHint;
  memo: string;
  xHandle: string; // 空ならなし
  penName: string; // 空ならなし
}

// 行の中の X(Twitter) のURLか @アカウント名
const X_TOKEN_RE = /(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/\S+|(?<![^\s,、:|/(\[「『【])@[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/i;

/** 行から X のアカウントを取り出し、残りの文字列と一緒に返す */
export function takeXHandle(text: string): { handle: string; rest: string } {
  const m = X_TOKEN_RE.exec(text);
  if (!m) return { handle: '', rest: text };
  const handle = toXHandle(m[0]);
  if (!handle) return { handle: '', rest: text };
  return { handle, rest: text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length) };
}

export interface LineError {
  line: number;
  source: string;
  error: string;
}

/** 全角英数・記号を半角に、半角カナを全角にそろえる */
export function normalize(s: string): string {
  return s.normalize('NFKC').replace(/　/g, ' ');
}

const DAY_RE = /(\d+)\s*日目|[(]([月火水木金土日])[)]|([月火水木金土日])曜日?/;

const HALL = '[東西南]\\d?';
const BLOCK = '\\d+組|[A-Za-z]{1,2}|[ァ-ヺ]|[ぁ-ゖ]';
const NUM_ONE = '\\d{1,3}(?:[ab]{1,2})?';
const NUM = `${NUM_ONE}(?:\\s*[,、・/]\\s*${NUM_ONE})*`;
// 名前の途中(「サークルA12」など)に反応しないよう、行頭・空白・区切り記号の直後だけを対象にする
const SPACE_RE = new RegExp(
  // ブロックと番号の間のハイフンは、長音「ー」やダッシュ類で書かれていても受け付ける
  `(?<![^\\s,、:|/(\\[「『【])(${HALL})?\\s*(${BLOCK})\\s*[-‐‑‒–—―ー−]?\\s*(${NUM})(?![\\d])`,
);

/** 「東ア-1a」→ { hall:'東', block:'ア', number:'01a' }。読み取れなければ null */
export function parseSpace(text: string): SpaceParts | null {
  const m = SPACE_RE.exec(normalize(text).trim());
  return m ? toParts(m) : null;
}

function toParts(m: RegExpExecArray): SpaceParts {
  const block = m[2]; // 英字の大小はそのまま(コミケでは別のブロック)
  const number = m[3]
    .split(/\s*[,、・/]\s*/)
    .map((n) => n.replace(/^(\d+)/, (d) => d.padStart(2, '0')))
    .join(',');
  return { hall: m[1] ?? '', block, number };
}

export function parseDayHint(text: string): DayHint {
  const m = DAY_RE.exec(normalize(text));
  if (!m) return null;
  if (m[1]) return { kind: 'index', n: Number(m[1]) };
  return { kind: 'weekday', w: m[2] ?? m[3] };
}

/** 貼り付けられたテキストを1行ずつ読む。空行は無視 */
export function parseLines(text: string): { rows: ParsedLine[]; errors: LineError[] } {
  const rows: ParsedLine[] = [];
  const errors: LineError[] = [];
  text.split(/\r?\n/).forEach((raw, idx) => {
    const source = raw.trim();
    if (!source) return;
    const x = takeXHandle(normalize(source));
    let rest = x.rest;
    const dm = DAY_RE.exec(rest);
    const day = parseDayHint(rest);
    if (dm) rest = rest.slice(0, dm.index) + ' ' + rest.slice(dm.index + dm[0].length);
    const sm = SPACE_RE.exec(rest);
    if (!sm) {
      errors.push({ line: idx + 1, source, error: '配置番号が見つかりません' });
      return;
    }
    const name = cleanName(rest.slice(0, sm.index) + ' ' + rest.slice(sm.index + sm[0].length));
    rows.push({ line: idx + 1, source, day, name, memo: '', xHandle: x.handle, penName: '', ...toParts(sm) });
  });
  return { rows, errors };
}

/** 前後の区切り記号やカッコを落とす */
export function cleanName(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s:|/,、・\-「『【\[(]+|[\s:|/,、・\-」』】\])]+$/g, '')
    .trim();
}

/** 同じ場所かどうかの比較用キー */
export const spaceKey = (s: SpaceParts): string =>
  normalize(`${s.hall}|${s.block}|${s.number}`).replace(/\s+/g, '').replace(/[、・/]/g, ',');

const WEEK = '日月火水木金土';
/** "2026-12-30" → "水" */
export function weekdayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(d.getTime()) ? '' : WEEK[d.getDay()];
}
