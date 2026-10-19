// イベントの切り替え・作成・編集(開催日もここで管理)。

import { getAll } from '../db.js';
import { deleteEvent, saveEvent, selectEvent, state } from '../store.js';
import type { DayRec, EventRec, Venue } from '../types.js';
import { VENUE_LABEL } from '../types.js';
import { esc, toInt, uid, yen } from '../util.js';
import { closeDialog, openDialog, val } from './dialog.js';

/** イベント一覧(切り替え用) */
export function openEventList(): void {
  const rows = state.events
    .map(
      (e) => `
      <li class="ev-row${e.id === state.eventId ? ' current' : ''}">
        <button class="ev-pick" data-act="pick" data-id="${esc(e.id)}">
          <strong>${esc(e.name)}</strong>
          <small>${esc(VENUE_LABEL[e.venue])}${e.budget ? `・予算 ${yen(e.budget)}` : ''}</small>
        </button>
        <button class="btn small" data-act="edit" data-id="${esc(e.id)}">編集</button>
      </li>`,
    )
    .join('');

  openDialog(
    `
    <div class="sheet">
      <h2>イベント</h2>
      <ul class="ev-list">${rows}</ul>
      <div class="actions">
        <button class="btn ghost" data-act="new">＋ 新しいイベント</button>
        <span class="spacer"></span>
        <button class="btn" data-act="close">閉じる</button>
      </div>
    </div>`,
    (root) => {
      root.querySelector('.sheet')!.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        const { act, id } = btn.dataset;
        if (act === 'pick' && id) {
          await selectEvent(id);
          closeDialog();
        } else if (act === 'edit' && id) {
          await openEventEditor(id);
        } else if (act === 'new') {
          await openEventEditor();
        } else if (act === 'close') {
          closeDialog();
        }
      });
    },
  );
}

/** イベントの作成・編集。開催日の追加・削除もここで行う。 */
export async function openEventEditor(eventId?: string): Promise<void> {
  const existing = state.events.find((e) => e.id === eventId);
  const ev: EventRec = existing ?? { id: uid(), name: '', venue: 'bigsight', budget: 0, createdAt: Date.now() };
  const days: DayRec[] = existing
    ? (await getAll<DayRec>('days', 'eventId', ev.id)).sort((a, b) => a.order - b.order)
    : [{ id: uid(), eventId: ev.id, label: '1日目', date: '', order: 0 }];

  const venueOptions = (Object.keys(VENUE_LABEL) as Venue[])
    .map((v) => `<option value="${v}"${ev.venue === v ? ' selected' : ''}>${VENUE_LABEL[v]}</option>`)
    .join('');

  openDialog(
    `
    <form class="sheet" novalidate>
      <h2>${existing ? 'イベントを編集' : '新しいイベント'}</h2>
      <label class="field">イベント名<input name="name" value="${esc(ev.name)}" placeholder="C107" autocomplete="off"></label>
      <div class="field-row">
        <label class="field">会場<select name="venue">${venueOptions}</select></label>
        <label class="field">予算(円)<input name="budget" value="${ev.budget || ''}" inputmode="numeric" placeholder="未設定"></label>
      </div>
      <div class="field">開催日
        <div class="day-rows">${days.map(dayRow).join('')}</div>
        <button type="button" class="btn ghost" data-act="add-day">＋ 日を追加</button>
      </div>
      <p class="error" data-error hidden></p>
      <div class="actions">
        ${existing ? '<button type="button" class="btn danger" data-act="delete">削除</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="back">${state.events.length ? '戻る' : 'キャンセル'}</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`,
    (root) => {
      const form = root.querySelector('form')!;
      const rows = root.querySelector('.day-rows')!;
      if (!existing) root.querySelector<HTMLInputElement>('[name=name]')?.focus();

      form.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'add-day') {
          const n = rows.querySelectorAll('.day-row').length + 1;
          rows.insertAdjacentHTML('beforeend', dayRow({ id: uid(), eventId: ev.id, label: `${n}日目`, date: '', order: n - 1 }));
        } else if (act === 'remove-day') {
          if (rows.querySelectorAll('.day-row').length <= 1) {
            showError(form, '開催日は1日以上必要です。');
            return;
          }
          const isSaved = days.some((d) => d.id === btn.closest<HTMLElement>('.day-row')?.dataset.id);
          if (isSaved && !confirm('この日のサークルと頒布物も保存時に削除されます。よろしいですか?')) return;
          btn.closest('.day-row')?.remove();
        } else if (act === 'back') {
          if (state.events.length) openEventList();
          else closeDialog();
        } else if (act === 'delete') {
          if (confirm(`「${ev.name}」の全日程のデータを削除しますか?この操作は元に戻せません。`)) {
            await deleteEvent(ev.id);
            closeDialog();
          }
        }
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = val(form, '[name=name]');
        if (!name) {
          showError(form, 'イベント名を入力してください。');
          return;
        }
        const nextDays: DayRec[] = [];
        rows.querySelectorAll<HTMLElement>('.day-row').forEach((r, idx) => {
          const prev = days.find((d) => d.id === r.dataset.id);
          nextDays.push({
            ...(prev?.route ? { route: prev.route } : {}), // 動線の設定は残す
            id: r.dataset.id!,
            eventId: ev.id,
            label: val(r, '[name=label]'), // 空のままなら日付だけを表示する
            date: val(r, '[name=date]'),
            order: idx,
          });
        });
        await saveEvent(
          { ...ev, name, venue: val(form, '[name=venue]') as Venue, budget: toInt(val(form, '[name=budget]')) },
          nextDays,
        );
        if (!existing) await selectEvent(ev.id);
        closeDialog();
      });
    },
  );
}

function dayRow(d: DayRec): string {
  return `
    <div class="day-row" data-id="${esc(d.id)}">
      <input name="label" value="${esc(d.label)}" placeholder="空欄なら日付のみ" aria-label="日の名前" autocomplete="off">
      <input name="date" type="date" value="${esc(d.date)}" aria-label="日付">
      <button type="button" class="icon-btn" data-act="remove-day" aria-label="この日を削除">✕</button>
    </div>`;
}

function showError(form: HTMLElement, msg: string): void {
  const el = form.querySelector<HTMLElement>('[data-error]')!;
  el.textContent = msg;
  el.hidden = false;
}
