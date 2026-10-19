// 「1日目」「土」「12/30」などの日の指定を、イベントの開催日に結びつける(一括登録・カタログ共通)。

import { weekdayOf } from './parseSpace.js';
import type { DayHint } from './parseSpace.js';
import type { DayRec } from './types.js';

export function resolveDay(hint: DayHint, days: DayRec[]): DayRec | null {
  if (!hint) return null;
  switch (hint.kind) {
    case 'index':
      return days[hint.n - 1] ?? null;
    case 'weekday':
      return days.find((d) => (d.date && weekdayOf(d.date) === hint.w) || d.label.includes(hint.w)) ?? null;
    case 'date':
      return (
        days.find((d) => {
          const [, m, dd] = d.date.split('-').map(Number);
          return m === hint.m && dd === hint.d;
        }) ?? null
      );
  }
}

/** 選択肢などに出す日の名前。名前が空なら日付、両方空なら「n日目」 */
export function dayName(d: DayRec, i: number): string {
  if (d.label) return d.label;
  if (d.date) {
    const [, m, dd] = d.date.split('-').map(Number);
    return `${m}/${dd}(${weekdayOf(d.date)})`;
  }
  return `${i + 1}日目`;
}
