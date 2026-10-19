// 会場(マス目の会場データ、または画像 + 島)から、動線の計算に使う「通れるマス」の地図を作る。

import type { IslandRec } from '../types.js';
import type { ResolvedGrid } from '../venueGrid.js';

export interface RouteMap {
  kind: 'grid' | 'image';
  cols: number;
  rows: number;
  passable: Uint8Array;
  /** スタート地点の候補(会場データの「*入口」などの目印) */
  starts: { key: string; name: string; cells: number[] }[];
  /** サークルのスペースのマス(会場データで分かるとき)から、立つ場所(となりの通路)を返す */
  accessFromCells(cells: number[]): number[];
  /** ピンの位置(0〜1)から、立つ場所(いちばん近い通れるマス)を返す */
  accessFromPos(pos: { x: number; y: number }): number[];
  /** マス → 会場図上の位置(0〜1) */
  center(cell: number): { x: number; y: number };
}

function makeMap(kind: RouteMap['kind'], cols: number, rows: number, passable: Uint8Array, starts: RouteMap['starts']): RouteMap {
  const inside = (r: number, c: number): boolean => r >= 0 && r < rows && c >= 0 && c < cols;

  /** そのマスから近い順に広げて、最初に見つかった通れるマス(同じ近さのものは全部。最大4つ) */
  const nearestPassable = (from: number): number[] => {
    if (passable[from]) return [from];
    const seen = new Uint8Array(cols * rows);
    let frontier = [from];
    seen[from] = 1;
    while (frontier.length) {
      const found = frontier.filter((x) => passable[x]);
      if (found.length) return found.sort((a, b) => a - b).slice(0, 4);
      const next: number[] = [];
      for (const cell of frontier) {
        const r = Math.floor(cell / cols);
        const c = cell % cols;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr;
          const nc = c + dc;
          if (!inside(nr, nc) || seen[nr * cols + nc]) continue;
          seen[nr * cols + nc] = 1;
          next.push(nr * cols + nc);
        }
      }
      frontier = next;
    }
    return [];
  };

  return {
    kind,
    cols,
    rows,
    passable,
    starts,
    accessFromCells(cells) {
      const out = new Set<number>();
      for (const cell of cells) {
        const r = Math.floor(cell / cols);
        const c = cell % cols;
        for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
          const nr = r + dr;
          const nc = c + dc;
          if (inside(nr, nc) && passable[nr * cols + nc]) out.add(nr * cols + nc);
        }
      }
      if (out.size) return [...out].sort((a, b) => a - b);
      // 通路に面していない(囲まれている)ときは、いちばん近い通れるマス
      return cells.length ? nearestPassable(cells[0]) : [];
    },
    accessFromPos(pos) {
      const r = Math.min(rows - 1, Math.max(0, Math.floor(pos.y * rows)));
      const c = Math.min(cols - 1, Math.max(0, Math.floor(pos.x * cols)));
      return nearestPassable(r * cols + c);
    },
    center(cell) {
      return { x: ((cell % cols) + 0.5) / cols, y: (Math.floor(cell / cols) + 0.5) / rows };
    },
  };
}

/** マス目の会場データから。通れるのは通路・ラベル・目印のマス */
export function routeMapFromGrid(res: ResolvedGrid): RouteMap {
  const { cols, rows } = res.grid;
  const passable = new Uint8Array(cols * rows);
  const starts: RouteMap['starts'] = [];
  res.cells.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell.kind === 'aisle' || cell.kind === 'label' || cell.kind === 'marker') passable[r * cols + c] = 1;
      if (cell.kind === 'marker' && cell.text) {
        const same = starts.find((s) => s.name === cell.text);
        if (same) same.cells.push(r * cols + c);
        else starts.push({ key: `marker:${cell.text}`, name: cell.text, cells: [r * cols + c] });
      }
    }),
  );
  return makeMap('grid', cols, rows, passable, starts);
}

/**
 * 会場図の画像から。画像を細かいマス(長い辺が約120マス)に分け、島の長方形を通れない場所にする。
 * 島が無ければ全部通れる(= ほぼ直線の距離)
 */
export function routeMapFromImage(width: number, height: number, islands: IslandRec[]): RouteMap {
  const size = Math.max(width, height) / 120;
  const cols = Math.max(1, Math.ceil(width / size));
  const rows = Math.max(1, Math.ceil(height / size));
  const passable = new Uint8Array(cols * rows).fill(1);
  for (const isl of islands) {
    const c0 = Math.floor(isl.x * cols);
    const c1 = Math.ceil((isl.x + isl.w) * cols) - 1;
    const r0 = Math.floor(isl.y * rows);
    const r1 = Math.ceil((isl.y + isl.h) * rows) - 1;
    for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
      for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) passable[r * cols + c] = 0;
    }
  }
  return makeMap('image', cols, rows, passable, []);
}
