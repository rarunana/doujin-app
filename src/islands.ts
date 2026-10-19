// 島(L1)からスペースの位置を計算する。画面に依存しない純粋な処理。
//
// 島の長方形の中に、各辺に沿ってマスが並んでいるとみなす:
//   ・上辺・下辺のマスは、島の幅を等分(マスは正方形とみなし、帯の厚み = 幅 ÷ マスの数)
//   ・左辺・右辺のマスは、上下の帯を除いた高さを等分
// 片方の辺だけに番号がある細長い島(壁沿いの列など)は、その帯の中心に並ぶ。

import { normalizeForSearch } from './catalog.js';
import type { CircleRec, IslandRec } from './types.js';

export type Side = 'top' | 'right' | 'bottom' | 'left';
export const SIDES: Side[] = ['top', 'right', 'bottom', 'left'];

export interface SpacePos {
  number: string; // 2桁にそろえた番号("05")
  side: Side;
  x: number; // 会場図に対する割合
  y: number;
}

/** 「23-26」「22-15」「14,13,36,35」「01〜04」→ ["23","24","25","26"] など。読めない部分は飛ばす */
export function parseNumbers(text: string): string[] {
  const out: string[] = [];
  const parts = text.normalize('NFKC').split(/[,、\s]+/).filter(Boolean);
  for (const part of parts) {
    const range = /^(\d{1,3})\s*[-~〜ー−]\s*(\d{1,3})$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (Math.abs(a - b) > 200) continue; // 打ち間違いで巨大な範囲にならないように
      const step = a <= b ? 1 : -1;
      for (let n = a; n !== b + step; n += step) out.push(pad(n));
      continue;
    }
    if (/^\d{1,3}$/.test(part)) out.push(pad(Number(part)));
  }
  return out;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 島の各スペースの位置。imgW/imgH は会場図の大きさ(px)。縦横の比率をそろえて計算するために使う */
export function islandSpaces(isl: IslandRec, imgW: number, imgH: number): SpacePos[] {
  const nums = { top: parseNumbers(isl.top), right: parseNumbers(isl.right), bottom: parseNumbers(isl.bottom), left: parseNumbers(isl.left) };
  // ピクセル単位で計算(割合のままだと縦横の長さがそろわない)
  const x = isl.x * imgW;
  const y = isl.y * imgH;
  const w = isl.w * imgW;
  const h = isl.h * imgH;
  const nT = nums.top.length;
  const nB = nums.bottom.length;
  const nL = nums.left.length;
  const nR = nums.right.length;
  const across = Math.max(nT, nB);
  const down = Math.max(nL, nR);

  // 上下の帯の厚み
  const tb = across ? Math.min(w / across, nT && nB ? h / 2 : h) : 0;
  const y0 = y + (nT ? tb : 0);
  const y1 = y + h - (nB ? tb : 0);
  // 左右の帯の厚み
  const lr = down ? Math.min(across ? w / across : (y1 - y0) / down, nL && nR ? w / 2 : w) : 0;

  const out: SpacePos[] = [];
  const push = (side: Side, list: string[], at: (i: number, n: number) => [number, number]): void => {
    list.forEach((number, i) => {
      const [px, py] = at(i, list.length);
      out.push({ number, side, x: px / imgW, y: py / imgH });
    });
  };
  push('top', nums.top, (i, n) => [x + ((i + 0.5) * w) / n, y + tb / 2]);
  push('bottom', nums.bottom, (i, n) => [x + ((i + 0.5) * w) / n, y + h - tb / 2]);
  push('left', nums.left, (i, n) => [x + lr / 2, y0 + ((i + 0.5) * (y1 - y0)) / n]);
  push('right', nums.right, (i, n) => [x + w - lr / 2, y0 + ((i + 0.5) * (y1 - y0)) / n]);
  return out;
}

const blockKey = (s: string): string => normalizeForSearch(s);

/** 島のブロック名がサークルの配置に当たるか(「3組」=「3組」、「東ア」=ホール東+ブロックア、「ア」=ブロックア) */
export function matchesBlock(isl: IslandRec, c: Pick<CircleRec, 'hall' | 'block'>): boolean {
  const b = blockKey(isl.block);
  return b !== '' && (b === blockKey(c.block) || b === blockKey(`${c.hall}${c.block}`));
}

/** 配置番号の番号部分 → ["03","04"]。「01a」「01ab」の a/b は外して同じ机として扱う */
export function circleNumbers(number: string): string[] {
  return number
    .normalize('NFKC')
    .split(/[,、・/]/)
    .map((n) => /^(\d{1,3})/.exec(n.trim())?.[1])
    .filter((n): n is string => !!n)
    .map((n) => pad(Number(n)));
}

export interface IslandIndex {
  find(c: Pick<CircleRec, 'hall' | 'block' | 'number'>): { x: number; y: number } | null;
}

/** 島からサークルの位置を引けるようにまとめる。複数スペース(03,04)は中間に置く */
export function buildIslandIndex(islands: IslandRec[], imgW: number, imgH: number): IslandIndex {
  const spaces = islands.map((isl) => ({ isl, list: islandSpaces(isl, imgW, imgH) }));
  return {
    find(c) {
      const nums = circleNumbers(c.number);
      if (nums.length === 0) return null;
      const hits: { x: number; y: number }[] = [];
      for (const n of nums) {
        for (const { isl, list } of spaces) {
          if (!matchesBlock(isl, c)) continue;
          const p = list.find((s) => s.number === n);
          if (p) {
            hits.push(p);
            break;
          }
        }
      }
      if (hits.length === 0) return null;
      return {
        x: hits.reduce((a, p) => a + p.x, 0) / hits.length,
        y: hits.reduce((a, p) => a + p.y, 0) / hits.length,
      };
    },
  };
}
