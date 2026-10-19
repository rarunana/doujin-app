// 一覧から選んで追加する画面。検索して「追加」を押すと、その場で買い物リストに入る(画面は開いたまま)。

import { circleFromCatalog, isInList, searchCatalog } from '../catalog.js';
import { addCircles, state } from '../store.js';
import type { CatalogRec, Priority } from '../types.js';
import { esc, spaceLabel, uid, xUrl } from '../util.js';
import { closeDialog, openDialog } from './dialog.js';

const LIMIT = 80;

export function openCatalogPicker(): void {
  const entries = state.catalog.filter((e) => e.dayId === state.dayId);
  openDialog(
    `
    <div class="sheet pick-sheet">
      <div class="pick-head">
        <h2>一覧から追加</h2>
        <button type="button" class="btn small" data-act="close">閉じる</button>
      </div>
      <input type="search" class="search" placeholder="サークル名・ペンネーム・配置・キャラで検索" data-act="search"
        autocomplete="off" enterkeyhint="search">
      <div class="pick-opts">
        <label>追加するときの優先度
          <select name="priority"><option value="must">必須</option><option value="want">できれば</option></select>
        </label>
        <span class="note small" data-count></span>
      </div>
      <ul class="pick-list" data-list></ul>
    </div>`,
    (root) => {
      const sheet = root.querySelector<HTMLElement>('.sheet')!;
      const list = sheet.querySelector<HTMLElement>('[data-list]')!;
      const count = sheet.querySelector<HTMLElement>('[data-count]')!;
      const search = sheet.querySelector<HTMLInputElement>('[data-act=search]')!;

      const render = (): void => {
        const { hits, total } = searchCatalog(entries, search.value, LIMIT);
        count.textContent = search.value.trim() ? `${total}件` : `全${total}件`;
        list.innerHTML =
          hits.map(renderRow).join('') +
          (total > hits.length ? `<li class="pick-more">ほか ${total - hits.length}件。名前などで絞り込んでください</li>` : '') +
          (total === 0 ? '<li class="pick-more">見つかりませんでした</li>' : '');
      };
      search.addEventListener('input', render);
      render();
      // スマホでいきなりキーボードが出ると一覧が見えにくいので、PCのときだけ自動で入力欄へ
      if (window.matchMedia('(pointer: fine)').matches) search.focus();

      sheet.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'close') closeDialog();
        if (btn.dataset.act !== 'add') return;
        const entry = entries.find((x) => x.id === btn.dataset.id);
        if (!entry || isInList(entry, state.circles)) return;
        const priority = (sheet.querySelector<HTMLSelectElement>('[name=priority]')?.value ?? 'must') as Priority;
        const order = Math.max(0, ...state.circles.map((c) => c.order)) + 1;
        btn.setAttribute('disabled', '');
        await addCircles([circleFromCatalog(entry, uid(), priority, order)]);
        btn.outerHTML = '<span class="added">追加済み</span>';
      });
    },
  );
}

function renderRow(e: CatalogRec): string {
  const added = isInList(e, state.circles);
  return `
    <li class="pick-row">
      <div class="pick-info">
        <div><span class="space">${esc(spaceLabel(e))}</span> <span class="pick-name">${esc(e.name)}</span></div>
        <div class="pick-sub">
          ${e.penName ? `<span>${esc(e.penName)}</span>` : ''}
          ${e.tags ? `<span class="tag">${esc(e.tags)}</span>` : ''}
          ${e.xHandle ? `<a href="${esc(xUrl(e.xHandle))}" target="_blank" rel="noopener noreferrer" class="x-link small">@${esc(e.xHandle)} ↗</a>` : ''}
        </div>
      </div>
      ${added ? '<span class="added">追加済み</span>' : `<button type="button" class="btn small" data-act="add" data-id="${esc(e.id)}">追加</button>`}
    </li>`;
}
