// 動線の計算の入出力(JSON と同じ形のオブジェクト)。
// 計算は C++(WebAssembly)で行い、読み込めないときは同じ処理の JavaScript 版で行う。

/** 計算の依頼 */
export interface RouteRequest {
  cols: number;
  rows: number;
  /** マスごとに 1 = 通れる、0 = 通れない(行 * cols + 列 の順) */
  passable: Uint8Array;
  /** 目的地(サークル)。access は立つ場所のマスの番号 */
  targets: RouteTarget[];
  /** スタート地点のマス(無ければ、いちばん短くなる所から始める) */
  start: number[] | null;
  /** 必須を全部回ってから「できれば」を回る */
  mustFirst: boolean;
  /** 順番を決める(false なら targets の順番のまま道のりだけ求める) */
  optimize: boolean;
}

export interface RouteTarget {
  id: string;
  priority: 0 | 1; // 0 = 必須、1 = できれば
  access: number[];
}

/** 計算の結果 */
export interface RouteResult {
  /** 回る順番(目的地の id) */
  order: string[];
  /** 区間ごとの距離と道のり(order と同じ並び)。cost: 1マス = 10、斜め = 14。届かない区間は -1 */
  legs: { id: string; cost: number; path: number[] }[];
  total: number;
  engine: 'wasm' | 'js';
}

export const STEP = 10; // 1マス進む距離
