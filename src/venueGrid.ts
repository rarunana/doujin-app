// マス目の会場データ: 読み取り・検査・描画(SVG)・配置番号からの位置・ブロック名の変更・CSV書き出し。
// 画面に依存しない(テストでも使えるように、DOM を使わない)。
//
// CSV の書き方(1マス=1スペース番号。Excel で編集できる):
//   空欄        通路
//   #           壁・柱(通れない)
//   ■           机の内側・サークルの席(通れない)
//   23 / 3組23  スペース。番号だけなら、近くのラベルのブロックになる
//   【3組】     ブロック名のラベル(通路のマスに置く)。触れている島と、同じ列で上下2マス以内の島に効く。
//               近いラベルが優先。島の左半分と右半分に別のラベルがあれば、島を縦に2分割してそれぞれの名前にする
//   !運営本部   施設(通れない)。同じ名前の隣り合うマスは1つの施設として描く
//   *入口       出入口などの目印(通れる)
//   1行目が「#会場,名前」なら会場名として読む。3つ目に「東」などホールを書くと、
//   ホールの違うサークルはこの会場データで探さない(コミケの「東ア」と「西あ」を取り違えないため)
//
// Excel は「+」「-」「=」「@」で始まるセルを式とみなすため、記号はそれ以外を使っている。

import { normalizeForSearch } from './catalog.js';
import { circleNumbers } from './islands.js';
import { parseCsv } from './csv.js';
import { parseSpace } from './parseSpace.js';
import type { CircleRec } from './types.js';

export type CellKind = 'aisle' | 'wall' | 'desk' | 'space' | 'label' | 'facility' | 'marker';

export interface GridCell {
  kind: CellKind;
  text: string; // ラベル・施設・目印の名前
  block: string; // スペースのブロック(ラベルから決まったもの含む)
  number: string; // スペース番号(2桁)
  explicit: boolean; // セルにブロック名が書いてあった
  note?: 'no-prefix' | 'hash-text'; // 書き方の注意(記号なしの文字 / 「#」の後ろに文字)
}

export interface VenueGrid {
  name: string;
  hall: string; // ホール(例: 東)。空なら全部のサークルを探す
  cols: number;
  rows: number;
  tokens: string[][]; // CSV のマスの中身そのまま(ブロック名の変更や書き出しで元の書き方を保つ)
  headerRows: number; // CSV で、マス目より上にある行の数(「#会場」の行があれば1)。Excel の行番号を出すのに使う
}

/** 検査結果。error: ピンの位置に影響する / warn: 書き方の注意 */
export interface GridIssue {
  level: 'error' | 'warn';
  text: string;
}

export interface ResolvedGrid {
  grid: VenueGrid;
  cells: GridCell[][];
  blocks: { name: string; count: number }[]; // 名前順(数字は数の順)
  issues: GridIssue[]; // エラーが先
  labelPlaces: Map<string, LabelPlace>; // "行,列" → 描く位置(島の上下にあるラベルは島の中央にそろえる)
}

export const CELL_PX = 24;

// ---------------------------------------------------------------- 読み取り

export function parseVenueCsv(text: string, fallbackName = '会場'): VenueGrid {
  let rows = parseCsv(text.replace(/^﻿/, ''), { keepEmpty: true });
  let name = fallbackName;
  let hall = '';
  let headerRows = 0;
  if (rows[0]?.[0]?.trim() === '#会場') {
    name = (rows[0][1] ?? '').trim() || fallbackName;
    hall = (rows[0][2] ?? '').trim();
    rows = rows.slice(1);
    headerRows = 1;
  }
  // 末尾の空行・空列を落とし、全行を同じ列数にそろえる
  while (rows.length && rows.at(-1)!.every((t) => !t.trim())) rows.pop();
  const cols = Math.max(0, ...rows.map((r) => lastFilled(r) + 1));
  const tokens = rows.map((r) => Array.from({ length: cols }, (_, i) => (r[i] ?? '').trim()));
  return { name, hall, cols, rows: tokens.length, tokens, headerRows };
}

/** 保存しておいたマスの中身から会場データを作る(書き出す CSV には「#会場」の行が付く) */
export function gridFromTokens(name: string, tokens: string[][], hall = ''): VenueGrid {
  const cols = Math.max(0, ...tokens.map((r) => r.length));
  return {
    name,
    hall,
    cols,
    rows: tokens.length,
    tokens: tokens.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? '')),
    headerRows: 1,
  };
}

/** スペースのマスの数 */
export const spaceCount = (res: ResolvedGrid): number => res.blocks.reduce((a, b) => a + b.count, 0);

export const errorCount = (res: ResolvedGrid): number => res.issues.filter((i) => i.level === 'error').length;

function lastFilled(r: string[]): number {
  for (let i = r.length - 1; i >= 0; i--) if (r[i].trim()) return i;
  return -1;
}

const pad2 = (n: string): string => n.replace(/^(\d+)/, (d) => d.padStart(2, '0'));

/** Excel のセル番地(A1 形式)。行番号は CSV の行(「#会場」の行を含む) */
export function cellRef(grid: VenueGrid, r: number, c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return `${s}${r + 1 + grid.headerRows}`;
}

/** 「01,02,03,05」→「01〜03, 05」 */
export function compactNumbers(nums: string[]): string {
  const list = [...new Set(nums)].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && /^\d+$/.test(list[j]) && Number(list[j + 1]) === Number(list[j]) + 1) j++;
    out.push(j > i + 1 ? `${list[i]}〜${list[j]}` : j === i + 1 ? `${list[i]}, ${list[j]}` : list[i]);
    i = j;
  }
  return out.join(', ');
}

/** 1マスの記号を読む(ブロックはまだ決めない) */
function readToken(raw: string): GridCell {
  const t = raw.normalize('NFKC').trim();
  const base: GridCell = { kind: 'aisle', text: '', block: '', number: '', explicit: false };
  if (t === '' || t === '.') return base;
  if (t === '#') return { ...base, kind: 'wall' };
  if (t === '■' || t === '□') return { ...base, kind: 'desk' };
  const label = /^【(.+)】$/.exec(raw.trim());
  if (label) return { ...base, kind: 'label', text: label[1].trim() };
  if (t.startsWith('!')) return { ...base, kind: 'facility', text: t.slice(1).trim() };
  if (t.startsWith('*')) return { ...base, kind: 'marker', text: t.slice(1).trim() };
  // 「#入口」のように壁の記号の後ろに文字: 壁に開いた出入口とみなす(通れる目印)
  if (t.startsWith('#')) return { ...base, kind: 'marker', text: t.slice(1).trim(), note: 'hash-text' };
  if (/^\d{1,3}[ab]{0,2}$/i.test(t)) return { ...base, kind: 'space', number: pad2(t.toLowerCase()) };
  const sp = parseSpace(t);
  if (sp && !sp.number.includes(',')) {
    return { ...base, kind: 'space', block: `${sp.hall}${sp.block}`, number: sp.number, explicit: true };
  }
  return { ...base, kind: 'facility', text: t, note: 'no-prefix' }; // 読めない文字は施設の名前として扱う
}

interface Island {
  r0: number;
  r1: number;
  c0: number;
  c1: number;
  cells: [number, number][];
}

interface LabelHit {
  label: string;
  dist: number;
  ref: string;
  r: number;
  c: number;
}

/** ラベルを描く位置(マス単位。x は横位置、y は縦の中心) */
export interface LabelPlace {
  x: number;
  y: number;
  anchor: 'start' | 'middle' | 'end';
}

/** ラベルからブロックを決め、検査結果と一緒に返す */
export function resolveGrid(grid: VenueGrid): ResolvedGrid {
  const { rows, cols } = grid;
  const cells = grid.tokens.map((r) => r.map(readToken));
  const errors: string[] = [];
  const warns: string[] = [];
  const at = (r: number, c: number): GridCell | undefined => cells[r]?.[c];
  const ref = (r: number, c: number): string => cellRef(grid, r, c);
  const area = (isl: Island): string =>
    isl.r0 === isl.r1 && isl.c0 === isl.c1 ? ref(isl.r0, isl.c0) : `${ref(isl.r0, isl.c0)}〜${ref(isl.r1, isl.c1)}`;

  // 島 = スペースと机の内側が上下左右につながったまとまり
  const islandOf: number[][] = cells.map((r) => r.map(() => -1));
  const islands: Island[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = cells[r][c].kind;
      if ((k !== 'space' && k !== 'desk') || islandOf[r][c] >= 0) continue;
      const id = islands.length;
      const isl: Island = { r0: r, r1: r, c0: c, c1: c, cells: [] };
      const stack: [number, number][] = [[r, c]];
      islandOf[r][c] = id;
      while (stack.length) {
        const [y, x] = stack.pop()!;
        isl.cells.push([y, x]);
        isl.r0 = Math.min(isl.r0, y);
        isl.r1 = Math.max(isl.r1, y);
        isl.c0 = Math.min(isl.c0, x);
        isl.c1 = Math.max(isl.c1, x);
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy;
          const nx = x + dx;
          const n = at(ny, nx);
          if (n && (n.kind === 'space' || n.kind === 'desk') && islandOf[ny][nx] < 0) {
            islandOf[ny][nx] = id;
            stack.push([ny, nx]);
          }
        }
      }
      islands.push(isl);
    }
  }

  // ラベル → 島。触れている島、または同じ列にあって上下2マス以内の島。
  // 島の中心より左のラベルは左半分、右のラベルは右半分の候補にする
  const hits: { L: LabelHit[]; R: LabelHit[] }[] = islands.map(() => ({ L: [], R: [] }));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      if (cell.kind !== 'label') continue;
      let used = false;
      islands.forEach((isl, id) => {
        const touches = isl.cells.some(([y, x]) => Math.abs(y - r) <= 1 && Math.abs(x - c) <= 1);
        const vGap = r < isl.r0 ? isl.r0 - r : r > isl.r1 ? r - isl.r1 : 0;
        const below = c >= isl.c0 && c <= isl.c1 && vGap <= 2;
        if (!touches && !below) return;
        used = true;
        const dist = Math.max(vGap, c < isl.c0 ? isl.c0 - c : c > isl.c1 ? c - isl.c1 : 0);
        const side = c <= (isl.c0 + isl.c1) / 2 ? 'L' : 'R';
        hits[id][side].push({ label: cell.text, dist, ref: ref(r, c), r, c });
      });
      if (!used) errors.push(`ラベル「${cell.text}」(${ref(r, c)})の近くに島がありません。島に触れるか、同じ列の上下2マス以内に置いてください`);
    }
  }

  /** 片側の候補から、いちばん近いラベルを選ぶ(同じ近さで名前が違えば知らせる) */
  const pick = (list: LabelHit[], isl: Island, sideName: string): LabelHit | null => {
    if (!list.length) return null;
    const d = Math.min(...list.map((h) => h.dist));
    const near = list.filter((h) => h.dist === d);
    const names = [...new Set(near.map((h) => h.label))];
    if (names.length > 1) {
      errors.push(
        `島(${area(isl)})の${sideName}に、ラベル${near.map((h) => `「${h.label}」(${h.ref})`).join('と')}が同じ近さで効いています。どちらかを動かしてください`,
      );
    }
    return near[0];
  };

  const noBlock: string[] = [];
  const labelUse = new Map<string, { x: number; anchor: LabelPlace['anchor']; above: number; below: number }>();
  islands.forEach((isl, id) => {
    const hl = pick(hits[id].L, isl, '左半分');
    const hr = pick(hits[id].R, isl, '右半分');
    const left = (hl ?? hr)?.label ?? '';
    const right = (hr ?? hl)?.label ?? '';
    const mid = (isl.c0 + isl.c1) / 2;
    // ラベルの描く位置: 島の上下にあるものは島の中央(左右で分かれる島は境目から外向き)
    const split = left !== right;
    for (const [h, side] of [[hl, 'L'], [hr, 'R']] as const) {
      if (!h || (h.r >= isl.r0 && h.r <= isl.r1)) continue; // 島の横にあるラベルはそのまま
      const key = `${h.r},${h.c}`;
      const u = labelUse.get(key) ?? { x: 0, anchor: 'middle' as LabelPlace['anchor'], above: -1, below: Infinity };
      if (split) {
        const edge = isl.c0 + (isl.c1 - isl.c0 + 1) / 2;
        u.x = side === 'L' ? edge - 0.15 : edge + 0.15;
        u.anchor = side === 'L' ? 'end' : 'start';
      } else {
        u.x = (isl.c0 + isl.c1 + 1) / 2;
        u.anchor = 'middle';
      }
      if (isl.r1 < h.r) u.above = Math.max(u.above, isl.r1);
      if (isl.r0 > h.r) u.below = Math.min(u.below, isl.r0);
      labelUse.set(key, u);
    }
    const missing: string[] = [];
    for (const [y, x] of isl.cells) {
      const cell = cells[y][x];
      if (cell.kind !== 'space' || cell.block) continue;
      cell.block = x <= mid ? left : right; // 左右で名前が違えば、縦に2分割
      if (!cell.block) missing.push(cell.number);
    }
    if (missing.length) {
      noBlock.push(`ブロック名が決まらないスペースがあります(${area(isl)}: ${compactNumbers(missing)})。近くに【ブロック名】のラベルを置いてください`);
    }
  });
  errors.unshift(...noBlock);

  // 同じブロック・番号が2か所 / 番号の抜け
  const counts = new Map<string, number>();
  const seen = new Map<string, string>(); // ブロック|番号 → 最初のセル番地
  const dups = new Map<string, { nums: string[]; example: string }>();
  const numsOf = new Map<string, Set<number>>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      if (cell.kind !== 'space' || !cell.block) continue;
      counts.set(cell.block, (counts.get(cell.block) ?? 0) + 1);
      const n = Number(cell.number.replace(/[ab]+$/, ''));
      if (Number.isFinite(n)) {
        if (!numsOf.has(cell.block)) numsOf.set(cell.block, new Set());
        numsOf.get(cell.block)!.add(n);
      }
      const key = `${normalizeForSearch(cell.block)}|${cell.number}`;
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, ref(r, c));
        continue;
      }
      const d = dups.get(cell.block) ?? { nums: [], example: `${cell.block}${cell.number} が ${prev} と ${ref(r, c)}` };
      d.nums.push(cell.number);
      dups.set(cell.block, d);
    }
  }
  for (const [block, d] of dups) {
    errors.push(`「${block}」の番号が2か所にあります: ${compactNumbers(d.nums)}(${new Set(d.nums).size}個)。例: ${d.example}`);
  }
  for (const [block, set] of numsOf) {
    if (dups.has(block)) continue; // 重なりを直せば抜けも直ることが多い
    const max = Math.max(...set);
    const lack: string[] = [];
    for (let n = 1; n <= max; n++) if (!set.has(n)) lack.push(String(n).padStart(2, '0'));
    if (lack.length) warns.push(`「${block}」は 01〜${String(max).padStart(2, '0')} のうち ${compactNumbers(lack)} がありません`);
  }

  // 書き方の注意
  const noPrefix = new Set<string>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      if (cell.note === 'hash-text') {
        warns.push(`「${grid.tokens[r][c]}」(${ref(r, c)}): 「#」の後ろに文字があるので、通れる出入口として扱いました。目印なら「*${cell.text}」、施設なら「!${cell.text}」と書いてください`);
      }
      if (cell.note === 'no-prefix') noPrefix.add(cell.text);
    }
  }
  if (noPrefix.size) {
    warns.push(`記号の無い文字は施設(通れない)として扱いました: ${[...noPrefix].join('、')}。「!」を付けておくと確実です`);
  }

  const blocks = [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }));
  const issues: GridIssue[] = [
    ...errors.map((text) => ({ level: 'error' as const, text })),
    ...warns.map((text) => ({ level: 'warn' as const, text })),
  ];
  // 上の島と下の島の両方に効くラベルは、間の通路の縦の中央に描く
  const labelPlaces = new Map<string, LabelPlace>();
  for (const [key, u] of labelUse) {
    const r = Number(key.split(',')[0]);
    const y = u.above >= 0 && Number.isFinite(u.below) ? (u.above + 1 + u.below) / 2 : r + 0.5;
    labelPlaces.set(key, { x: u.x, y, anchor: u.anchor });
  }
  return { grid, cells, blocks, issues, labelPlaces };
}

// ---------------------------------------------------------------- 位置

export interface GridIndex {
  find(c: Pick<CircleRec, 'hall' | 'block' | 'number'>): { x: number; y: number } | null;
  /** そのサークルのスペースのマス(行 * 列数 + 列)。動線の計算で使う */
  cells(c: Pick<CircleRec, 'hall' | 'block' | 'number'>): number[];
  size: { w: number; h: number };
}

/** サークルのホールが、会場データのホールと違うか(どちらかが空なら違わない。「東」と「東7」は同じとみなす) */
export function otherHall(grid: Pick<VenueGrid, 'hall'>, circle: Pick<CircleRec, 'hall'>): boolean {
  const g = normalizeForSearch(grid.hall);
  const c = normalizeForSearch(circle.hall);
  return !!g && !!c && !g.startsWith(c) && !c.startsWith(g);
}

/** 配置番号 → 会場図上の位置(割合 0〜1)。「03,04」は間、「01a」は01のマス */
export function buildGridIndex(res: ResolvedGrid): GridIndex {
  const map = new Map<string, { x: number; y: number; cell: number }>();
  const { rows, cols } = res.grid;
  res.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.kind !== 'space' || !cell.block) return;
      const num = cell.number.replace(/[ab]+$/, '');
      const key = `${normalizeForSearch(cell.block)}|${num}`;
      if (!map.has(key)) map.set(key, { x: (c + 0.5) / cols, y: (r + 0.5) / rows, cell: r * cols + c });
    }),
  );
  const lookup = (circle: Pick<CircleRec, 'hall' | 'block' | 'number'>): { x: number; y: number; cell: number }[] => {
    if (otherHall(res.grid, circle)) return [];
    const blockKeys = [normalizeForSearch(circle.block), normalizeForSearch(`${circle.hall}${circle.block}`)];
    const hits: { x: number; y: number; cell: number }[] = [];
    for (const n of circleNumbers(circle.number)) {
      const p = blockKeys.map((b) => map.get(`${b}|${n}`)).find(Boolean);
      if (p) hits.push(p);
    }
    return hits;
  };
  return {
    size: { w: cols * CELL_PX, h: rows * CELL_PX },
    cells: (circle) => lookup(circle).map((h) => h.cell),
    find(circle) {
      const hits = lookup(circle);
      if (hits.length === 0) return null;
      return { x: hits.reduce((a, p) => a + p.x, 0) / hits.length, y: hits.reduce((a, p) => a + p.y, 0) / hits.length };
    },
  };
}

// ---------------------------------------------------------------- ブロック名の変更・書き出し

/** ブロック名を変える(ラベルも、セルに直接書いたブロック名も)。名前の対応表: 旧 → 新 */
export function renameBlocks(grid: VenueGrid, renames: Map<string, string>): VenueGrid {
  const tokens = grid.tokens.map((row) =>
    row.map((t) => {
      const cell = readToken(t);
      if (cell.kind === 'label' && renames.has(cell.text)) return `【${renames.get(cell.text)}】`;
      if (cell.kind === 'space' && cell.explicit && renames.has(cell.block)) return `${renames.get(cell.block)}${cell.number}`;
      return t;
    }),
  );
  return { ...grid, tokens };
}

/** CSV(UTF-8 BOM付き。Excel でそのまま開ける) */
export function gridToCsv(grid: VenueGrid): string {
  const q = (s: string): string => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [`#会場,${q(grid.name)}${grid.hall ? `,${q(grid.hall)}` : ''}`, ...grid.tokens.map((r) => r.map(q).join(','))];
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- 描画

const COLORS = {
  floor: '#fbfaf7',
  wall: '#4a4a4f',
  desk: '#ead2b4',
  space: '#f1a04a',
  spaceLine: '#9a5d1d',
  spaceText: '#ffffff',
  facility: '#f5cdd9',
  facilityLine: '#d97a96',
  facilityText: '#7a2341',
  marker: '#7cb4ff',
  label: '#3d3d44',
};

/** 組ごとの色(塗り・線と文字)。隣り合う番号の組が似た色にならない順に並べてある */
const PALETTE: { fill: string; line: string }[] = [
  { fill: '#f8b46a', line: '#a85a12' }, // だいだい
  { fill: '#8ec5f5', line: '#25649e' }, // 空
  { fill: '#9ed99a', line: '#347a30' }, // 緑
  { fill: '#f5a3c7', line: '#a23a6d' }, // 桃
  { fill: '#f3d36b', line: '#86690a' }, // 黄
  { fill: '#c3a8f0', line: '#5d3aa3' }, // 紫
  { fill: '#84d8cc', line: '#1c7a6e' }, // 青緑
  { fill: '#f39a92', line: '#a3332a' }, // 赤
  { fill: '#c6e07a', line: '#5d7a14' }, // 黄緑
  { fill: '#a5b2f2', line: '#3445a3' }, // 藍
  { fill: '#dcb48c', line: '#6e4c2a' }, // 茶
  { fill: '#a9cbd8', line: '#33606f' }, // 灰青
];

/**
 * ブロック名の共通部分(色分けの単位)。番号・[ ]・( ) の中身を除いたもの。
 * 「3組」「11組」→「組」、「ARENA[ア]」→「ARENA」、「東ア」「東1ア」→「東」
 */
export function blockFamily(name: string): string {
  const base = name.normalize('NFKC').replace(/\[[^\]]*\]|\([^)]*\)|\d+/g, '').trim();
  const hall = /^(東|西|南|北)./.exec(base);
  if (hall) return hall[1];
  return base ? base.toUpperCase() : name;
}

/** ブロック名 → 色。共通部分(「組」「ARENA」など)ごとに同じ色。出てきた順に割り当てる */
export function blockColors(res: ResolvedGrid): Map<string, { fill: string; line: string }> {
  const fams: string[] = [];
  for (const b of res.blocks) if (!fams.includes(blockFamily(b.name))) fams.push(blockFamily(b.name));
  return new Map(res.blocks.map((b) => [b.name, PALETTE[fams.indexOf(blockFamily(b.name)) % PALETTE.length]]));
}

/**
 * 会場図の画像(SVG)。地図画面ではこれを画像として表示し、その上にピンを重ねる。
 * color: 組ごとに色を分ける(しないときは全部だいだい色)
 */
export function renderGridSvg(res: ResolvedGrid, opts: { color?: boolean } = {}): string {
  const { rows, cols } = res.grid;
  const S = CELL_PX;
  const parts: string[] = [];
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const done: boolean[][] = res.cells.map((r) => r.map(() => false));
  const colors = opts.color ? blockColors(res) : null;
  const drawnLabels = new Set<string>(); // 同じ島に同じ名前のラベルが複数あっても、中央に1つだけ描く

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = res.cells[r][c];
      const x = c * S;
      const y = r * S;
      if (cell.kind === 'wall') parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${COLORS.wall}"/>`);
      else if (cell.kind === 'desk') parts.push(`<rect x="${x}" y="${y}" width="${S}" height="${S}" fill="${COLORS.desk}"/>`);
      else if (cell.kind === 'space') {
        const col = colors?.get(cell.block);
        parts.push(
          `<rect x="${x + 0.5}" y="${y + 0.5}" width="${S - 1}" height="${S - 1}" fill="${col?.fill ?? COLORS.space}" stroke="${col?.line ?? COLORS.spaceLine}" stroke-width="1"/>`,
          `<text x="${x + S / 2}" y="${y + S / 2 + 4}" font-size="11" text-anchor="middle" fill="${col ? '#26262b' : COLORS.spaceText}" font-weight="700">${esc(cell.number)}</text>`,
        );
      } else if (cell.kind === 'facility' && !done[r][c]) {
        // 同じ名前の隣り合うマスをまとめて1つの施設として描く
        const group = floodSame(res.cells, r, c, done);
        const xs = group.map(([, gx]) => gx);
        const ys = group.map(([gy]) => gy);
        const x0 = Math.min(...xs) * S;
        const y0 = Math.min(...ys) * S;
        const w = (Math.max(...xs) + 1) * S - x0;
        const h = (Math.max(...ys) + 1) * S - y0;
        parts.push(
          `<rect x="${x0 + 1}" y="${y0 + 1}" width="${w - 2}" height="${h - 2}" rx="4" fill="${COLORS.facility}" stroke="${COLORS.facilityLine}" stroke-width="2"/>`,
          facilityText(cell.text, x0, y0, w, h, esc),
        );
      } else if (cell.kind === 'marker') {
        parts.push(
          `<rect x="${x + 2}" y="${y + 2}" width="${S - 4}" height="${S - 4}" rx="4" fill="${COLORS.marker}"/>`,
          `<text x="${x + S / 2}" y="${y - 3}" font-size="12" text-anchor="middle" fill="#1d4f91" font-weight="700">${esc(cell.text)}</text>`,
        );
      } else if (cell.kind === 'label') {
        const col = colors?.get(cell.text);
        const place = res.labelPlaces.get(`${r},${c}`);
        if (place) {
          const k = `${cell.text}|${place.x}|${place.y}`;
          if (drawnLabels.has(k)) continue;
          drawnLabels.add(k);
          parts.push(
            `<text x="${place.x * S}" y="${place.y * S + 5}" font-size="14" text-anchor="${place.anchor}" fill="${col?.line ?? COLORS.label}" font-weight="700">${esc(cell.text)}</text>`,
          );
          continue;
        }
        // 左右に並んだラベル(島の左半分・右半分)は、境目から外向きに書いて重ならないようにする
        const rightIsLabel = res.cells[r][c + 1]?.kind === 'label';
        const leftIsLabel = res.cells[r][c - 1]?.kind === 'label';
        const [tx, anchor] = rightIsLabel
          ? [x + S - 2, 'end']
          : leftIsLabel
            ? [x + 2, 'start']
            : c > cols - 4
              ? [x + S / 2, 'end']
              : [x + S / 2, 'start'];
        parts.push(
          `<text x="${tx}" y="${y + S / 2 + 5}" font-size="14" text-anchor="${anchor}" fill="${col?.line ?? COLORS.label}" font-weight="700">${esc(cell.text)}</text>`,
        );
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * S}" height="${rows * S}" viewBox="0 0 ${cols * S} ${rows * S}" font-family="'Hiragino Sans','Noto Sans JP','Yu Gothic UI',sans-serif"><rect width="100%" height="100%" fill="${COLORS.floor}"/>${parts.join('')}</svg>`;
}

/** 施設の名前。横に収まらず縦長の枠なら縦書き(1文字ずつ並べる)。文字は枠に収まる大きさにする */
function facilityText(text: string, x0: number, y0: number, w: number, h: number, esc: (s: string) => string): string {
  const chars = [...text];
  const fill = COLORS.facilityText;
  const horiz = Math.min(15, (w - 8) / Math.max(1, chars.length));
  const vert = Math.min(15, (h - 14) / Math.max(1, chars.length), w - 8);
  if (horiz >= 10 || horiz >= vert) {
    const fs = Math.max(7, horiz);
    return `<text x="${x0 + w / 2}" y="${y0 + h / 2 + fs * 0.36}" font-size="${fs}" text-anchor="middle" fill="${fill}" font-weight="700">${esc(text)}</text>`;
  }
  const fs = Math.max(7, vert);
  const top = y0 + h / 2 - (chars.length * fs) / 2;
  return chars
    .map((ch, i) => `<text x="${x0 + w / 2}" y="${top + fs * (i + 0.86)}" font-size="${fs}" text-anchor="middle" fill="${fill}" font-weight="700">${esc(ch)}</text>`)
    .join('');
}

function floodSame(cells: GridCell[][], r: number, c: number, done: boolean[][]): [number, number][] {
  const text = cells[r][c].text;
  const out: [number, number][] = [];
  const stack: [number, number][] = [[r, c]];
  done[r][c] = true;
  while (stack.length) {
    const [y, x] = stack.pop()!;
    out.push([y, x]);
    for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = cells[y + dy]?.[x + dx];
      if (n && n.kind === 'facility' && n.text === text && !done[y + dy][x + dx]) {
        done[y + dy][x + dx] = true;
        stack.push([y + dy, x + dx]);
      }
    }
  }
  return out;
}
