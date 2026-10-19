// サークルの追加・編集ダイアログ(頒布物と値段もここで入力)。

import { isInList, searchCatalog } from '../catalog.js';
import { deleteCircle, itemsOf, saveCircle, state } from '../store.js';
import type { CircleRec, ItemRec, Priority } from '../types.js';
import { esc, spaceLabel, toInt, toXHandle, uid, yen } from '../util.js';
import { closeDialog, openDialog, val } from './dialog.js';

export function openCircleDialog(circleId?: string): void {
  const existing = state.circles.find((c) => c.id === circleId);
  const c: CircleRec = existing ?? {
    id: uid(),
    dayId: state.dayId!,
    name: '',
    hall: '',
    block: '',
    number: '',
    priority: 'must',
    order: Math.max(0, ...state.circles.map((x) => x.order)) + 1,
    memo: '',
  };
  const items = existing ? itemsOf(c.id) : [];
  // この日のサークル一覧(カタログ)があれば、名前などで探して入力できる
  const catalog = state.catalog.filter((e) => e.dayId === c.dayId);
  const catalogSearch = catalog.length
    ? `<div class="field cat-search">一覧から探す
         <input type="search" name="catq" placeholder="サークル名・ペンネーム・配置など" autocomplete="off" enterkeyhint="search">
         <ul class="cat-cands" data-cands></ul>
       </div>`
    : '';
  const prio = (p: Priority, label: string): string =>
    `<label class="radio"><input type="radio" name="priority" value="${p}"${c.priority === p ? ' checked' : ''}>${label}</label>`;

  openDialog(
    `
    <form class="sheet" novalidate>
      <h2>${existing ? 'サークルを編集' : 'サークルを追加'}</h2>
      ${catalogSearch}
      <label class="field">サークル名
        <input name="name" value="${esc(c.name)}" autocomplete="off">
      </label>
      <label class="field">ペンネーム
        <input name="penName" value="${esc(c.penName ?? '')}" autocomplete="off">
      </label>
      <div class="field-row">
        <label class="field">ホール<input name="hall" value="${esc(c.hall)}" placeholder="東" autocomplete="off"></label>
        <label class="field">ブロック<input name="block" value="${esc(c.block)}" placeholder="ア" autocomplete="off"></label>
        <label class="field">番号<input name="number" value="${esc(c.number)}" placeholder="01a" autocomplete="off"></label>
      </div>
      <div class="field">優先度<div class="radios">${prio('must', '必須')}${prio('want', 'できれば')}</div></div>
      <label class="field">X(Twitter)
        <input name="xHandle" value="${c.xHandle ? `@${esc(c.xHandle)}` : ''}" placeholder="@アカウント名 またはURL"
          autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url">
      </label>

      <div class="field">頒布物
        <div class="item-rows">${items.map(itemRow).join('')}</div>
        <button type="button" class="btn ghost" data-act="add-item">＋ 頒布物を追加</button>
        <p class="sum">合計 <strong data-sum>¥0</strong></p>
      </div>

      <label class="field">メモ<textarea name="memo" rows="2">${esc(c.memo)}</textarea></label>

      <p class="error" data-error hidden></p>
      <div class="actions">
        ${existing ? '<button type="button" class="btn danger" data-act="delete">削除</button>' : ''}
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="cancel">キャンセル</button>
        <button type="submit" class="btn primary">保存</button>
      </div>
    </form>`,
    (root) => {
      const form = root.querySelector('form')!;
      const rows = root.querySelector('.item-rows')!;
      const sumEl = root.querySelector('[data-sum]')!;
      const updateSum = (): void => {
        let sum = 0;
        rows.querySelectorAll<HTMLElement>('.item-row').forEach((r) => {
          sum += toInt(val(r, '[name=price]')) * Math.max(1, toInt(val(r, '[name=qty]'), 1));
        });
        sumEl.textContent = yen(sum);
      };
      if (items.length === 0) rows.insertAdjacentHTML('beforeend', itemRow());
      updateSum();

      root.querySelector<HTMLInputElement>(catalog.length && !existing ? '[name=catq]' : '[name=name]')?.focus();

      // ---- 一覧から探す ----
      const catq = form.querySelector<HTMLInputElement>('[name=catq]');
      const cands = form.querySelector<HTMLElement>('[data-cands]');
      catq?.addEventListener('input', () => {
        if (!cands) return;
        const q = catq.value.trim();
        const { hits, total } = q ? searchCatalog(catalog, q, 6) : { hits: [], total: 0 };
        const others = state.circles.filter((x) => x.id !== c.id);
        cands.innerHTML =
          hits
            .map(
              (e) => `
            <li><button type="button" class="cand" data-act="pick-cat" data-id="${esc(e.id)}">
              <span class="space">${esc(spaceLabel(e))}</span>
              <span class="cand-name">${esc(e.name)}${e.penName ? ` <small>${esc(e.penName)}</small>` : ''}</span>
              ${isInList(e, others) ? '<small class="added">追加済み</small>' : ''}
            </button></li>`,
            )
            .join('') +
          (q && total === 0 ? '<li class="cand-none">見つかりませんでした</li>' : '') +
          (total > hits.length ? `<li class="cand-none">ほか ${total - hits.length}件</li>` : '');
      });
      // 入力欄でEnterを押してもフォームが送信されないように
      catq?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });
      form.addEventListener('input', updateSum);

      form.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'pick-cat') {
          const entry = catalog.find((x) => x.id === btn.dataset.id);
          if (!entry) return;
          const set = (name: string, v: string): void => {
            const input = form.querySelector<HTMLInputElement>(`[name=${name}]`);
            if (input) input.value = v;
          };
          set('name', entry.name);
          set('penName', entry.penName);
          set('hall', entry.hall);
          set('block', entry.block);
          set('number', entry.number);
          set('xHandle', entry.xHandle ? `@${entry.xHandle}` : '');
          if (catq) catq.value = '';
          if (cands) cands.innerHTML = `<li class="cand-none">「${esc(entry.name)}」の配置・ペンネーム・Xを入れました</li>`;
          form.querySelector<HTMLInputElement>('.item-row [name=iname]')?.focus({ preventScroll: true });
        } else if (act === 'add-item') {
          rows.insertAdjacentHTML('beforeend', itemRow());
          rows.querySelector<HTMLInputElement>('.item-row:last-child [name=iname]')?.focus();
        } else if (act === 'remove-item') {
          btn.closest('.item-row')?.remove();
          updateSum();
        } else if (act === 'cancel') {
          closeDialog();
        } else if (act === 'delete') {
          if (confirm(`「${c.name || 'このサークル'}」と頒布物を削除しますか?`)) {
            await deleteCircle(c.id);
            closeDialog();
          }
        }
      });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const next: CircleRec = {
          ...c,
          name: val(form, '[name=name]'),
          hall: val(form, '[name=hall]'),
          block: val(form, '[name=block]'),
          number: val(form, '[name=number]'),
          priority: (form.querySelector<HTMLInputElement>('[name=priority]:checked')?.value ?? 'must') as Priority,
          memo: val(form, '[name=memo]'),
        };
        if (!next.name && !next.block && !next.number) {
          showError(form, 'サークル名か配置のどちらかを入力してください。');
          return;
        }
        const handle = toXHandle(val(form, '[name=xHandle]'));
        if (handle === null) {
          showError(form, 'Xのアカウント名を読み取れませんでした。「@アカウント名」かプロフィールのURLを入力してください。');
          return;
        }
        if (handle) next.xHandle = handle;
        else delete next.xHandle;
        const pen = val(form, '[name=penName]');
        if (pen) next.penName = pen;
        else delete next.penName;
        const old = new Map(items.map((i) => [i.id, i]));
        const nextItems: ItemRec[] = [];
        rows.querySelectorAll<HTMLElement>('.item-row').forEach((r) => {
          const name = val(r, '[name=iname]');
          const price = toInt(val(r, '[name=price]'));
          if (!name && price === 0) return; // 空の行は無視
          const id = r.dataset.id || uid();
          nextItems.push({
            id,
            circleId: next.id,
            dayId: next.dayId,
            name,
            price,
            qty: Math.max(1, toInt(val(r, '[name=qty]'), 1)),
            status: old.get(id)?.status ?? 'todo',
            order: nextItems.length, // 画面に並んでいる順
          });
        });
        await saveCircle(next, nextItems);
        closeDialog();
      });
    },
  );
}

function itemRow(i?: ItemRec): string {
  return `
    <div class="item-row" data-id="${esc(i?.id ?? '')}">
      <input name="iname" value="${esc(i?.name ?? '')}" placeholder="品名(新刊など)" autocomplete="off" aria-label="品名">
      <input name="price" value="${i ? i.price : ''}" placeholder="値段" inputmode="numeric" aria-label="値段(円)">
      <input name="qty" value="${i ? i.qty : 1}" inputmode="numeric" aria-label="数量">
      <button type="button" class="icon-btn" data-act="remove-item" aria-label="この頒布物を削除">✕</button>
    </div>`;
}

function showError(form: HTMLElement, msg: string): void {
  const el = form.querySelector<HTMLElement>('[data-error]')!;
  el.textContent = msg;
  el.hidden = false;
}
