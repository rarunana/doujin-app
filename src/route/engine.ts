// 動線の計算の窓口。C++(WebAssembly)を読み込んで使い、使えないときは JavaScript 版で計算する。
// 呼ぶ側は solveRoute(依頼) → 結果、だけを知っていればよい(どちらで計算したかは結果の engine に入る)。

import { solveJs } from './routeJs.js';
import type { RawResult } from './routeJs.js';
import type { RouteRequest, RouteResult } from './types.js';

interface WasmExports {
  memory: WebAssembly.Memory;
  in_passable(): number;
  in_acc(): number;
  in_acc_start(): number;
  in_prio(): number;
  in_order(): number;
  out_order(): number;
  out_leg_cost(): number;
  out_leg_start(): number;
  out_path(): number;
  limits(which: number): number;
  solve(cols: number, rows: number, n: number, hasStart: number, mustFirst: number, optimize: number): number;
}

let wasm: Promise<WasmExports | null> | null = null;

/** route.wasm を読み込む(1回だけ)。読み込めなければ null(JS 版を使う) */
export function loadWasm(url = './route.wasm'): Promise<WasmExports | null> {
  if (!wasm) {
    wasm = (async () => {
      try {
        if (typeof WebAssembly === 'undefined') return null;
        const res = await fetch(url);
        if (!res.ok) return null;
        const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
        return instance.exports as unknown as WasmExports;
      } catch {
        return null;
      }
    })();
  }
  return wasm;
}

/** テスト用: 読み込んだ WebAssembly を直接渡す */
export function useWasmExports(exports: unknown): void {
  wasm = Promise.resolve(exports as WasmExports);
}

/** WebAssembly で計算する。大きさの上限を超えたら null */
function solveWasm(w: WasmExports, req: RouteRequest): RawResult | null {
  const n = req.targets.length;
  const nodes = req.targets.map((t) => t.access);
  if (req.start) nodes.push(req.start);
  const accTotal = nodes.reduce((a, x) => a + x.length, 0);
  if (req.cols * req.rows > w.limits(0) || n > w.limits(1) || accTotal > w.limits(2)) return null;

  // 入力を書き込む(memory.buffer は計算中に変わらない。大きさは固定)
  const buf = w.memory.buffer;
  new Uint8Array(buf, w.in_passable(), req.passable.length).set(req.passable);
  const acc = new Int32Array(buf, w.in_acc(), accTotal);
  const accStart = new Int32Array(buf, w.in_acc_start(), nodes.length + 1);
  let p = 0;
  nodes.forEach((cells, i) => {
    accStart[i] = p;
    acc.set(cells, p);
    p += cells.length;
  });
  accStart[nodes.length] = p;
  new Int32Array(buf, w.in_prio(), n).set(req.targets.map((t) => t.priority));
  new Int32Array(buf, w.in_order(), n).set(req.targets.map((_, i) => i));

  const total = w.solve(req.cols, req.rows, n, req.start ? 1 : 0, req.mustFirst ? 1 : 0, req.optimize ? 1 : 0);
  if (total < 0) return null;

  const order = Array.from(new Int32Array(buf, w.out_order(), n));
  const legCost = Array.from(new Int32Array(buf, w.out_leg_cost(), n));
  const legStart = new Int32Array(buf, w.out_leg_start(), n + 1);
  const path = new Int32Array(buf, w.out_path(), legStart[n]);
  const legPaths = order.map((_, k) => Array.from(path.subarray(legStart[k], legStart[k + 1])));
  return { order, legCost, legPaths, total };
}

/** 動線を計算する */
export async function solveRoute(req: RouteRequest, opts: { forceJs?: boolean } = {}): Promise<RouteResult> {
  let raw: RawResult | null = null;
  let engine: RouteResult['engine'] = 'js';
  if (!opts.forceJs) {
    const w = await loadWasm();
    if (w) {
      try {
        raw = solveWasm(w, req);
        if (raw) engine = 'wasm';
      } catch {
        raw = null;
      }
    }
  }
  if (!raw) raw = solveJs(req);
  return {
    order: raw.order.map((i) => req.targets[i].id),
    legs: raw.order.map((i, k) => ({ id: req.targets[i].id, cost: raw!.legCost[k], path: raw!.legPaths[k] })),
    total: raw.total,
    engine,
  };
}
