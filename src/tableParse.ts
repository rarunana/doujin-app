// 表の読み取り: 保存したWebページ(.html)、ブラウザからコピーした表、CSV/タブ区切りテキスト。
// どれも「行 × セル(文字とリンク先)」の形にそろえる。

import { parseCsv } from './csv.js';

export interface Cell {
  text: string;
  hrefs: string[]; // セル内のリンク先(http/https のみ)
}

export type Table = Cell[][];

/**
 * HTMLの中の表をすべて取り出す。結合セル(rowspan/colspan)は展開して、行ごとに同じ列数にそろえる。
 * DOMParser で読むだけなので、ページ内のスクリプトは実行されず、画像も読み込まれない。
 */
export function tablesFromHtml(html: string): Table[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return [...doc.querySelectorAll('table')]
    .filter((t) => !t.querySelector('table')) // 入れ子の外側(レイアウト用の表)は除く
    .map(readTable)
    .filter((t) => t.length > 0);
}

/** 一番行の多い表(サークル一覧はたいていこれ) */
export function largestTable(tables: Table[]): Table | null {
  return tables.reduce<Table | null>((best, t) => (!best || t.length > best.length ? t : best), null);
}

function readTable(table: HTMLTableElement): Table {
  const grid: Cell[][] = [];
  [...table.rows].forEach((tr, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const td of [...tr.cells]) {
      while (grid[r][c]) c++; // 上の行の rowspan で埋まっている列は飛ばす
      const cell: Cell = { text: cellText(td), hrefs: cellLinks(td) };
      const rs = Math.max(1, Math.min(td.rowSpan || 1, 1000));
      const cs = Math.max(1, Math.min(td.colSpan || 1, 100));
      for (let dr = 0; dr < rs; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cs; dc++) grid[r + dr][c + dc] = cell;
      }
      c += cs;
    }
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid
    .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? { text: '', hrefs: [] }))
    .filter((row) => row.some((cell) => cell.text || cell.hrefs.length));
}

function cellText(el: Element): string {
  // <br> を空白にしてから文字だけを取り出す
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function cellLinks(el: Element): string[] {
  return [...el.querySelectorAll('a[href]')]
    .map((a) => (a.getAttribute('href') ?? '').trim())
    .filter((h) => /^https?:\/\//i.test(h));
}

/** タブ区切り(表をコピーしたときの文字だけの形)か、なければCSVとして読む */
export function tableFromText(text: string): Table {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.some((l) => l.includes('\t')) ? lines.map((l) => l.split('\t')) : parseCsv(text);
  return rows.map((r) =>
    r.map((t) => {
      const text = t.replace(/\s+/g, ' ').trim();
      return { text, hrefs: /^https?:\/\//i.test(text) ? [text] : [] };
    }),
  );
}
