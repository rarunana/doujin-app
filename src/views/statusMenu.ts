// 頒布物の状態を選ぶメニュー。
// 標準のリストボックスは iPhone で選択肢の色を付けられないため、独自に作る。
// 選択肢の並びと色はいつも同じ(売り切れ=赤、見送り=黄)で、今の状態に ✓ を付けるだけ。

import type { ItemStatus } from '../types.js';
import { STATUS_LABEL } from '../types.js';

const ORDER: ItemStatus[] = ['todo', 'bought', 'soldout', 'skip'];
const MENU_WIDTH = 168;

let closeCurrent: (() => void) | null = null;

export function openStatusMenu(anchor: HTMLElement, current: ItemStatus, onPick: (s: ItemStatus) => void): void {
  closeCurrent?.();

  const layer = document.createElement('div');
  layer.className = 'menu-layer';
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = ORDER.map(
    (s) => `
      <button type="button" role="menuitemradio" class="menu-item m-${s}" data-status="${s}" aria-checked="${s === current}">
        <span class="m-check" aria-hidden="true">${s === current ? '✓' : ''}</span>${STATUS_LABEL[s]}
      </button>`,
  ).join('');
  layer.appendChild(menu);
  document.body.appendChild(layer);

  // ボタンの右端にそろえ、下に入らなければ上に出す
  const r = anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  const left = Math.min(Math.max(8, r.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
  const below = r.bottom + 4 + h <= window.innerHeight - 8;
  menu.style.left = `${left}px`;
  menu.style.top = `${below ? r.bottom + 4 : Math.max(8, r.top - 4 - h)}px`;

  const close = (): void => {
    layer.remove();
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    document.removeEventListener('keydown', onKey);
    if (closeCurrent === close) closeCurrent = null;
    anchor.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  closeCurrent = close;

  layer.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-status]');
    const picked = item?.dataset.status as ItemStatus | undefined;
    close();
    if (picked && picked !== current) onPick(picked);
  });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', onKey);
  menu.querySelector<HTMLElement>('[aria-checked=true]')?.focus({ preventScroll: true });
}
