// 買い物リストと会場から動線を計算する(画面に依存しない部分)。
//   planOrder:   回る順番を決める(買い終わったサークルは除く)
//   remaining:   決めた順番のまま、まだ買っていないサークルの道のりを求める(マップの線)

import type { CircleRec } from '../types.js';
import type { RouteMap } from './build.js';
import { solveRoute } from './engine.js';
import type { RouteRequest, RouteResult, RouteTarget } from './types.js';

/** スタート地点: 自動 / 会場データの目印 / サークル(「ここから」) */
export type RouteStart = { kind: 'auto' } | { kind: 'marker'; key: string } | { kind: 'circle'; id: string };

export const startKey = (s: RouteStart): string => (s.kind === 'auto' ? 'auto' : s.kind === 'marker' ? s.key : `circle:${s.id}`);
export function parseStartKey(key: string | undefined): RouteStart {
  if (key?.startsWith('marker:')) return { kind: 'marker', key };
  if (key?.startsWith('circle:')) return { kind: 'circle', id: key.slice(7) };
  return { kind: 'auto' };
}

export interface PlanInput {
  map: RouteMap;
  circles: CircleRec[];
  /** サークルのスペースのマス(会場データで分かるとき) */
  cellsOf: (c: CircleRec) => number[];
  /** ピンの位置(0〜1)。無ければ null */
  posOf: (c: CircleRec) => { x: number; y: number } | null;
  isDone: (c: CircleRec) => boolean;
}

/** サークルの立つ場所。会場データのスペースが分かればその前の通路、無ければピンの位置のいちばん近くの通路 */
function accessOf(input: PlanInput, c: CircleRec): number[] {
  const cells = input.cellsOf(c);
  if (cells.length) return input.map.accessFromCells(cells);
  const pos = input.posOf(c);
  return pos ? input.map.accessFromPos(pos) : [];
}

function startCells(input: PlanInput, start: RouteStart): number[] | null {
  if (start.kind === 'marker') return input.map.starts.find((s) => s.key === start.key)?.cells ?? null;
  if (start.kind === 'circle') {
    const c = input.circles.find((x) => x.id === start.id);
    const acc = c ? accessOf(input, c) : [];
    return acc.length ? acc : null;
  }
  return null;
}

function request(input: PlanInput, targets: RouteTarget[], start: number[] | null, mustFirst: boolean, optimize: boolean): RouteRequest {
  return { cols: input.map.cols, rows: input.map.rows, passable: input.map.passable, targets, start, mustFirst, optimize };
}

export interface PlanResult {
  /** 新しい回る順番(全サークル): 買い終わったもの(今の順番のまま)→ 計算した順番 → 位置が分からないもの */
  order: string[];
  result: RouteResult;
  /** 位置が分からず、順番に入れられなかったサークル */
  unplaced: string[];
}

/** 回る順番を決める */
export async function planOrder(input: PlanInput, start: RouteStart, mustFirst: boolean): Promise<PlanResult> {
  const byOrder = [...input.circles].sort((a, b) => a.order - b.order);
  const done = byOrder.filter((c) => input.isDone(c));
  const todo = byOrder.filter((c) => !input.isDone(c));
  const targets: RouteTarget[] = [];
  const unplaced: string[] = [];
  for (const c of todo) {
    const access = accessOf(input, c);
    if (access.length === 0) unplaced.push(c.id);
    else targets.push({ id: c.id, priority: c.priority === 'must' ? 0 : 1, access });
  }
  const result = await solveRoute(request(input, targets, startCells(input, start), mustFirst, true));
  return { order: [...done.map((c) => c.id), ...result.order, ...unplaced], result, unplaced };
}

export interface RemainingRoute {
  result: RouteResult;
  /** 線の始まり(スタート地点のマス、または最後に買ったサークルの立つ場所)。無ければ null */
  from: number[] | null;
  /** 次に行くサークル */
  next: string | null;
}

/**
 * 今の順番のまま、まだ買っていないサークルの道のりを求める。
 * 線は、順番が前のサークルのうち最後に買い終わったもの(無ければスタート地点)から始める
 */
export async function remaining(input: PlanInput, start: RouteStart): Promise<RemainingRoute> {
  const byOrder = [...input.circles].sort((a, b) => a.order - b.order);
  const targets: RouteTarget[] = [];
  let lastDone: CircleRec | null = null;
  for (const c of byOrder) {
    const access = accessOf(input, c);
    if (access.length === 0) continue;
    if (input.isDone(c)) {
      if (targets.length === 0) lastDone = c;
      continue;
    }
    targets.push({ id: c.id, priority: c.priority === 'must' ? 0 : 1, access });
  }
  const from = lastDone ? accessOf(input, lastDone) : startCells(input, start);
  const result = await solveRoute(request(input, targets, from, false, false));
  return { result, from, next: targets[0]?.id ?? null };
}
