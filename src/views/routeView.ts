// 動線のダイアログ: 回る順番を計算する(スタート地点・必須を先に)/ 順番を手で並べ替える。
// 地図への線の表示は mapView.ts が行う。

import type { RouteMap } from '../route/build.js';
import { parseStartKey, planOrder, startKey } from '../route/plan.js';
import type { PlanInput, RouteStart } from '../route/plan.js';
import { STEP } from '../route/types.js';
import { itemsOf, saveRouteOrder, state } from '../store.js';
import type { CircleRec } from '../types.js';
import { esc, spaceLabel } from '../util.js';
import { closeDialog, openDialog, toast } from './dialog.js';
import { isDone } from './mainView.js';

const currentDay = () => state.days.find((d) => d.id === state.dayId);

/** 距離の表示(1マス = 1スペースの幅くらい) */
export const distText = (cost: number): string => `約${Math.round(cost / STEP)}マス`;

/**
 * 会場データのシートが何枚もある日の設定。
 * sheetName: 表示中のシートの名前 / rank: サークルのシートの並び(順番をシートごとにまとめる)
 */
export interface RouteOpts {
  sheetName?: string;
  rank?: (c: CircleRec) => number;
}

/**
 * 一部のサークル(表示中のシートの分)の新しい順番を、日全体の順番に入れる。
 * rank があれば、シートの並び → 各シートの中の順番、になるように並べ直す(リストの「回る順」がホールごとにまとまる)。
 * 無ければ、そのサークルたちが今いた位置に、新しい順番で入れ直す
 */
export function mergeOrder(partIds: string[], opts: RouteOpts = {}): string[] {
  const part = new Set(partIds);
  const all = [...state.circles].sort((a, b) => a.order - b.order);
  if (opts.rank) {
    const pos = new Map(partIds.map((id, i) => [id, i]));
    const key = (c: CircleRec): number => (part.has(c.id) ? pos.get(c.id)! : c.order);
    return all
      .map((c, i) => ({ c, i }))
      .sort((a, b) => opts.rank!(a.c) - opts.rank!(b.c) || (part.has(a.c.id) && part.has(b.c.id) ? key(a.c) - key(b.c) : a.i - b.i))
      .map((x) => x.c.id);
  }
  const queue = [...partIds];
  return all.map((c) => (part.has(c.id) ? queue.shift()! : c.id));
}

/** 計算して保存する(ダイアログを使わず、「ここから計算」などから直接呼ぶ) */
export async function computeRoute(input: PlanInput, start: RouteStart, mustFirst: boolean, opts: RouteOpts = {}): Promise<void> {
  const plan = await planOrder(input, start, mustFirst);
  await saveRouteOrder(mergeOrder(plan.order, opts), { start: startKey(start), mustFirst, updatedAt: Date.now() });
  const n = plan.result.order.length;
  const unreached = plan.result.legs.filter((l) => l.cost < 0).length;
  toast(
    n === 0
      ? 'まだ買っていない、位置の分かるサークルがありません'
      : `${n}件の順番を決めました(道のり ${distText(plan.result.total)}${unreached ? `・たどり着けない所 ${unreached}件` : ''})`,
  );
}

/** 「順番を計算」のダイアログ */
export function openRoutePlanDialog(map: RouteMap, input: () => PlanInput, opts: RouteOpts = {}): void {
  const meta = currentDay()?.route;
  const cur = parseStartKey(meta?.start);
  const curKey = cur.kind === 'circle' ? 'auto' : startKey(cur); // 「ここから」は1回限りなので、選び直すときは自動に戻す
  const todo = input().circles.filter((c) => !isDone(itemsOf(c.id))).length;
  openDialog(
    `
    <div class="sheet">
      <h2>回る順番を計算${opts.sheetName ? `<small>・${esc(opts.sheetName)}</small>` : ''}</h2>
      <p class="note">${opts.sheetName ? `このシートの、` : ''}まだ買っていないサークル ${todo}件の順番を、通路に沿った道のりが短くなるように決めます。買い終わったサークルは順番の最初に残します。${
        opts.sheetName ? '他のシートの順番は変わりません。' : ''
      }</p>
      <label class="field">スタート地点
        <select name="start">
          <option value="auto"${curKey === 'auto' ? ' selected' : ''}>自動(いちばん短くなるサークルから)</option>
          ${map.starts
            .map((s) => `<option value="${esc(s.key)}"${curKey === s.key ? ' selected' : ''}>${esc(s.name)}</option>`)
            .join('')}
        </select>
      </label>
      ${map.starts.length ? '' : '<p class="note small">会場データの「*入口」などの目印があると、そこをスタート地点に選べます。</p>'}
      <label class="check-line"><input type="checkbox" name="mustFirst"${meta?.mustFirst === false ? '' : ' checked'}>必須を先に回る(できればは、そのあと)</label>
      ${map.kind === 'image' ? '<p class="note small">会場データ(マス目)が無い日は、島をよけた近道で距離を測ります(通路の形までは分かりません)。</p>' : ''}
      <div class="actions">
        <button type="button" class="btn" data-act="close">やめる</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-act="run">計算する</button>
      </div>
    </div>`,
    (dlg) => {
      const sheet = dlg.querySelector<HTMLElement>('.sheet')!;
      sheet.addEventListener('click', async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeDialog();
        if (act !== 'run') return;
        const start = parseStartKey(sheet.querySelector<HTMLSelectElement>('[name=start]')!.value);
        const mustFirst = sheet.querySelector<HTMLInputElement>('[name=mustFirst]')!.checked;
        const btn = sheet.querySelector<HTMLButtonElement>('[data-act=run]')!;
        btn.disabled = true;
        btn.textContent = '計算中…';
        try {
          await computeRoute(input(), start, mustFirst, opts);
          closeDialog();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '計算する';
          toast(err instanceof Error ? err.message : String(err));
        }
      });
    },
  );
}

/**
 * 「順番を編集」のダイアログ。
 * 各サークルをカードで並べ、①大きな番号を書き換える、②右の ≡ をつかんで上下に動かす、のどちらかで並べ替える。
 * 動かしたカードは画面内に見えるようにして、少しの間だけ光らせる(見失わないように)
 */
export function openRouteEditDialog(circles: CircleRec[], where: (c: CircleRec) => string, opts: RouteOpts = {}): void {
  let list = [...circles].sort((a, b) => a.order - b.order);
  const cardHtml = (c: CircleRec, i: number): string => {
    const done = isDone(itemsOf(c.id));
    return `
      <li class="re-card${done ? ' done' : ''}${c.priority === 'must' ? ' must' : ''}" data-id="${esc(c.id)}">
        <input class="re-num" type="number" inputmode="numeric" min="1" max="${list.length}" value="${i + 1}" aria-label="${esc(c.name)}の順番" enterkeyhint="done">
        <span class="re-main">
          <span class="re-space">${esc(spaceLabel(c) || '配置なし')}</span>
          <span class="re-name">${esc(c.name || '(名前なし)')}</span>
          <small>${c.priority === 'must' ? '必須' : 'できれば'}${done ? '・買い終わり' : ''}${where(c) ? `・${esc(where(c))}` : ''}</small>
        </span>
        <span class="re-handle" aria-hidden="true" title="つかんで上下に動かす">≡</span>
      </li>`;
  };
  openDialog(
    `
    <div class="sheet re-sheet">
      <h2>回る順番を編集${opts.sheetName ? `<small>・${esc(opts.sheetName)}</small>` : ''}</h2>
      <p class="note small">左の番号を書き換えるか、右の ≡ をつかんで上下に動かします。地図の線とリストの「回る順」に使います。${
        opts.sheetName ? 'このシートのサークルだけを並べています。' : ''
      }</p>
      <ol class="re-list">${list.map(cardHtml).join('')}</ol>
      <div class="actions">
        <button type="button" class="btn" data-act="close">やめる</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-act="save">保存</button>
      </div>
    </div>`,
    (dlg) => {
      const sheet = dlg.querySelector<HTMLElement>('.sheet')!;
      const ol = sheet.querySelector<HTMLElement>('.re-list')!;

      /** 番号を振り直し、動かしたカードを見える所へ出して光らせる */
      const settle = (movedId: string | null): void => {
        ol.querySelectorAll<HTMLElement>('.re-card').forEach((el, i) => {
          el.querySelector<HTMLInputElement>('.re-num')!.value = String(i + 1);
        });
        if (!movedId) return;
        const el = ol.querySelector<HTMLElement>(`[data-id="${CSS.escape(movedId)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el.classList.remove('moved');
        void el.offsetWidth; // 続けて動かしたときも、もう一度光らせる
        el.classList.add('moved');
      };
      const syncList = (): void => {
        const byId = new Map(list.map((c) => [c.id, c]));
        list = [...ol.querySelectorAll<HTMLElement>('.re-card')].map((el) => byId.get(el.dataset.id!)!);
      };

      // ---- ① 番号を書き換える ----
      const moveTo = (input: HTMLInputElement): void => {
        const card = input.closest<HTMLElement>('.re-card')!;
        const from = list.findIndex((c) => c.id === card.dataset.id);
        const to = Math.min(list.length, Math.max(1, Math.round(Number(input.value) || from + 1))) - 1;
        if (to !== from) {
          const cards = [...ol.children];
          cards.splice(from, 1);
          ol.insertBefore(card, cards[to] ?? null);
          syncList();
        }
        settle(card.dataset.id!);
      };
      ol.addEventListener('change', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.classList.contains('re-num')) moveTo(input);
      });
      ol.addEventListener('keydown', (e) => {
        const input = e.target as HTMLInputElement;
        if (e.key === 'Enter' && input.classList.contains('re-num')) {
          e.preventDefault();
          input.blur(); // change が起きて動く
        }
      });
      ol.addEventListener('focusin', (e) => {
        const input = e.target as HTMLInputElement;
        if (input.classList.contains('re-num')) input.select();
      });

      // ---- ② ≡ をつかんで動かす ----
      let drag: { card: HTMLElement; grab: number; y: number; timer: number } | null = null;
      const place = (): void => {
        if (!drag) return;
        const { card } = drag;
        // 指の位置にカードを追従させ、となりのカードの中ほどを越えたら入れ替える
        card.style.transform = '';
        let natural = card.getBoundingClientRect().top;
        const top = drag.y - drag.grab;
        const prev = card.previousElementSibling as HTMLElement | null;
        const next = card.nextElementSibling as HTMLElement | null;
        if (prev) {
          const r = prev.getBoundingClientRect();
          if (top < r.top + r.height / 2) ol.insertBefore(card, prev);
        }
        if (next) {
          const r = next.getBoundingClientRect();
          if (top + card.offsetHeight > r.top + r.height / 2) ol.insertBefore(card, next.nextElementSibling);
        }
        natural = card.getBoundingClientRect().top;
        card.style.transform = `translateY(${top - natural}px)`;
      };
      ol.addEventListener('pointerdown', (e) => {
        const handle = (e.target as HTMLElement).closest('.re-handle');
        if (!handle) return;
        e.preventDefault();
        const card = handle.closest<HTMLElement>('.re-card')!;
        const r = card.getBoundingClientRect();
        handle.setPointerCapture(e.pointerId);
        card.classList.add('dragging');
        // 端に近いあいだは、一覧を少しずつ自動で送る
        const timer = window.setInterval(() => {
          if (!drag) return;
          const lr = ol.getBoundingClientRect();
          const step = drag.y < lr.top + 48 ? -12 : drag.y > lr.bottom - 48 ? 12 : 0;
          if (step) {
            ol.scrollTop += step;
            place();
          }
        }, 30);
        drag = { card, grab: e.clientY - r.top, y: e.clientY, timer };
      });
      ol.addEventListener('pointermove', (e) => {
        if (!drag) return;
        drag.y = e.clientY;
        place();
      });
      const drop = (): void => {
        if (!drag) return;
        window.clearInterval(drag.timer);
        drag.card.style.transform = '';
        drag.card.classList.remove('dragging');
        const id = drag.card.dataset.id!;
        drag = null;
        syncList();
        settle(id);
      };
      ol.addEventListener('pointerup', drop);
      ol.addEventListener('pointercancel', drop);

      sheet.addEventListener('click', async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeDialog();
        if (act === 'save') {
          // 入力途中の番号があれば先に反映する
          const active = document.activeElement as HTMLInputElement | null;
          if (active?.classList.contains('re-num')) moveTo(active);
          // 手で決めた順番も「順番がある」扱いにする(スタート地点などの設定はそのまま)
          const meta = currentDay()?.route ?? { start: 'auto', mustFirst: true, updatedAt: 0 };
          await saveRouteOrder(mergeOrder(list.map((c) => c.id), opts), { ...meta, updatedAt: Date.now() });
          closeDialog();
          toast('回る順番を保存しました');
        }
      });
    },
  );
}
