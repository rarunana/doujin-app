// 動線の計算(JavaScript 版)。cpp/route.cpp と同じ処理を同じ順番で行うので、結果は一致する。
// WebAssembly が読み込めないときに使う。処理の説明は route.cpp を参照。

import type { RouteRequest } from './types.js';

const INF = 1000000000;
const STRAIGHT = 10;
const DIAG = 14;
const DR = [-1, 1, 0, 0, -1, -1, 1, 1];
const DC = [0, 0, -1, 1, -1, 1, -1, 1];

export interface RawResult {
  order: number[];
  legCost: number[];
  legPaths: number[][];
  total: number;
}

export function solveJs(req: RouteRequest): RawResult {
  const { cols, rows, passable } = req;
  const nCells = cols * rows;
  const n = req.targets.length;
  const hasStart = !!req.start;
  const acc: number[][] = req.targets.map((t) => t.access);
  if (req.start) acc.push(req.start);
  const start = hasStart ? n : -1;
  const nodeCount = n + (hasStart ? 1 : 0);

  const dist = new Int32Array(nCells);
  const parent = new Int32Array(nCells);
  const goalMark = new Int32Array(nCells);
  let stamp = 0;

  // ---- 待ち行列(二分ヒープ)。距離が同じならマスの番号が小さい方が先 ----
  let hKey: number[] = [];
  let hCell: number[] = [];
  const less = (a: number, b: number): boolean => hKey[a] < hKey[b] || (hKey[a] === hKey[b] && hCell[a] < hCell[b]);
  const swap = (a: number, b: number): void => {
    [hKey[a], hKey[b]] = [hKey[b], hKey[a]];
    [hCell[a], hCell[b]] = [hCell[b], hCell[a]];
  };
  const push = (key: number, cell: number): void => {
    let i = hKey.length;
    hKey.push(key);
    hCell.push(cell);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): void => {
    const last = hKey.length - 1;
    hKey[0] = hKey[last];
    hCell[0] = hCell[last];
    hKey.pop();
    hCell.pop();
    let i = 0;
    const size = hKey.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < size && less(l, m)) m = l;
      if (r < size && less(r, m)) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
  };

  const dijkstra = (sources: number[], stopAtGoal: boolean): number => {
    dist.fill(INF);
    parent.fill(-1);
    hKey = [];
    hCell = [];
    for (const s of sources) {
      if (s < 0 || s >= nCells || !passable[s] || dist[s] === 0) continue;
      dist[s] = 0;
      push(0, s);
    }
    while (hKey.length > 0) {
      const d = hKey[0];
      const cell = hCell[0];
      pop();
      if (d !== dist[cell]) continue;
      if (stopAtGoal && goalMark[cell] === stamp) return cell;
      const r = Math.floor(cell / cols);
      const c = cell % cols;
      for (let k = 0; k < 8; k++) {
        const nr = r + DR[k];
        const nc = c + DC[k];
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const next = nr * cols + nc;
        if (!passable[next]) continue;
        if (k >= 4 && (!passable[r * cols + nc] || !passable[nr * cols + c])) continue;
        const nd = d + (k >= 4 ? DIAG : STRAIGHT);
        if (nd < dist[next]) {
          dist[next] = nd;
          parent[next] = cell;
          push(nd, next);
        }
      }
    }
    return -1;
  };

  // ---- 距離の表 ----
  const D = new Int32Array(nodeCount * nodeCount);
  const dd = (a: number, b: number): number => (a < 0 ? 0 : D[a * nodeCount + b]);

  const order: number[] = [];
  if (req.optimize) {
    for (let i = 0; i < nodeCount; i++) {
      dijkstra(acc[i], false);
      for (let j = 0; j < nodeCount; j++) {
        let best = INF;
        for (const cell of acc[j]) if (cell >= 0 && cell < nCells && dist[cell] < best) best = dist[cell];
        D[i * nodeCount + j] = i === j ? 0 : best;
      }
    }

    const pathCost = (prev: number, seq: number[]): number => {
      let sum = 0;
      let p = prev;
      for (const x of seq) {
        const d = dd(p, x);
        sum += d >= INF ? INF : d;
        p = x;
      }
      return sum;
    };
    const nearest = (from: number, list: number[]): number[] => {
      const used = new Array<boolean>(list.length).fill(false);
      const out: number[] = [];
      let p = from;
      for (let k = 0; k < list.length; k++) {
        let best = -1;
        let bestD = 0;
        for (let i = 0; i < list.length; i++) {
          if (used[i]) continue;
          const d = dd(p, list[i]);
          if (best < 0 || d < bestD) {
            best = i;
            bestD = d;
          }
        }
        used[best] = true;
        out.push(list[best]);
        p = list[best];
      }
      return out;
    };
    const twoOpt = (prev: number, seq: number[]): boolean => {
      const base = pathCost(prev, seq);
      const m = seq.length;
      for (let i = 0; i < m - 1; i++) {
        for (let j = i + 1; j < m; j++) {
          const cand = seq.slice();
          for (let a = i, b = j; a < b; a++, b--) [cand[a], cand[b]] = [cand[b], cand[a]];
          if (pathCost(prev, cand) < base) {
            seq.splice(0, m, ...cand);
            return true;
          }
        }
      }
      return false;
    };
    const orOpt = (prev: number, seq: number[]): boolean => {
      const base = pathCost(prev, seq);
      const m = seq.length;
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= m; i++) {
          for (let pos = 0; pos <= m - len; pos++) {
            if (pos === i) continue;
            const rest = seq.filter((_, k) => k < i || k >= i + len);
            const cand = [...rest.slice(0, pos), ...seq.slice(i, i + len), ...rest.slice(pos)];
            if (pathCost(prev, cand) < base) {
              seq.splice(0, m, ...cand);
              return true;
            }
          }
        }
      }
      return false;
    };
    const solveSegment = (prev: number, list: number[]): number[] => {
      const m = list.length;
      if (m === 0) return [];
      let seq: number[] = [];
      if (prev >= 0) {
        seq = nearest(prev, list);
      } else {
        let best = -1;
        for (let s = 0; s < m; s++) {
          const work = list.slice();
          work[0] = list[s];
          work[s] = list[0];
          const trial = [work[0], ...nearest(work[0], work.slice(1))];
          const c = pathCost(-1, trial);
          if (best < 0 || c < best) {
            best = c;
            seq = trial;
          }
        }
      }
      for (let guard = 0; guard < 2000; guard++) {
        if (twoOpt(prev, seq)) continue;
        if (orOpt(prev, seq)) continue;
        break;
      }
      return seq;
    };

    const groups: number[][] = [[], []];
    const lost: number[] = [];
    for (let t = 0; t < n; t++) {
      let reach = false;
      for (let u = 0; u < nodeCount && !reach; u++) if (u !== t && D[u * nodeCount + t] < INF) reach = true;
      if (n === 1 && !hasStart) reach = acc[t].length > 0;
      if (!reach) {
        lost.push(t);
        continue;
      }
      groups[req.mustFirst && req.targets[t].priority !== 0 ? 1 : 0].push(t);
    }
    let prev = start;
    for (const g of groups) {
      const seq = solveSegment(prev, g);
      order.push(...seq);
      if (order.length > 0) prev = order[order.length - 1];
    }
    order.push(...lost);
  } else {
    for (let k = 0; k < n; k++) order.push(k);
  }

  // ---- 道のり ----
  const legCost: number[] = [];
  const legPaths: number[][] = [];
  let total = 0;
  let arrival = -1;
  let fromNode = start;
  for (let k = 0; k < n; k++) {
    const to = order[k];
    if (arrival < 0 && fromNode < 0) {
      legCost.push(0);
      legPaths.push([]);
      if (acc[to].length > 0) fromNode = to;
      continue;
    }
    stamp++;
    for (const cell of acc[to]) if (cell >= 0 && cell < nCells) goalMark[cell] = stamp;
    const hit = arrival >= 0 ? dijkstra([arrival], true) : dijkstra(acc[fromNode], true);
    if (hit < 0) {
      legCost.push(-1);
      legPaths.push([]);
      if (acc[to].length > 0) {
        arrival = -1;
        fromNode = to;
      }
      continue;
    }
    const path: number[] = [];
    for (let c = hit; c >= 0; c = parent[c]) path.push(c);
    path.reverse();
    legCost.push(dist[hit]);
    legPaths.push(path);
    total += dist[hit];
    arrival = hit;
  }
  return { order, legCost, legPaths, total };
}
