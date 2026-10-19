import { requestPersist } from './db.js';
import {
  init,
  selectDay,
  setCircleBought,
  setFilter,
  setFold,
  setItemStatus,
  setSort,
  setView,
  state,
  subscribe,
  toggleFold,
} from './store.js';
import type { Filter, Sort } from './store.js';
import { openCircleDialog } from './views/circleDialog.js';
import { openDataDialog } from './views/dataDialog.js';
import { openEventEditor, openEventList } from './views/eventDialog.js';
import { foldableIds, renderMain } from './views/mainView.js';
import { mountMap } from './views/mapView.js';
import { openStatusMenu } from './views/statusMenu.js';

const app = document.getElementById('app')!;

function render(): void {
  app.innerHTML = renderMain();
  app.classList.toggle('is-map', state.view === 'map' && !!state.eventId);
  const host = document.getElementById('map-host');
  if (host) mountMap(host);
  // 一部だけ購入済みのサークルは「－」表示(HTML属性では指定できないためここで設定)
  app.querySelectorAll<HTMLInputElement>('input[data-indeterminate]').forEach((el) => (el.indeterminate = true));
}

// 画面内の操作は data-action 属性でまとめて受け取る
app.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.tagName === 'INPUT') return;
  const { action, id, value } = el.dataset;
  switch (action) {
    case 'open-events':
      openEventList();
      break;
    case 'new-event':
      run(openEventEditor());
      break;
    case 'add-circle':
      openCircleDialog();
      break;
    case 'edit-circle':
      openCircleDialog(id);
      break;
    case 'filter':
      setFilter(value as Filter);
      break;
    case 'fold':
      if (id) toggleFold(id);
      break;
    case 'fold-all':
      setFold(foldableIds(), value === 'close');
      break;
    case 'toggle-view':
      setView(state.view === 'map' ? 'list' : 'map');
      break;
    case 'set-view':
      if (value === 'list' || value === 'map') setView(value);
      break;
    case 'open-data':
      run(openDataDialog());
      break;
    case 'status-menu': {
      const item = state.eventItems.find((i) => i.id === id);
      if (item) openStatusMenu(el, item.status, (s) => run(setItemStatus(item.id, s)));
      break;
    }
  }
});

// 見出し(開閉)はキーボードでも操作できるようにする
app.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement;
  if ((e.key === 'Enter' || e.key === ' ') && el.dataset.action === 'fold' && el.dataset.id) {
    e.preventDefault();
    toggleFold(el.dataset.id);
  }
});

app.addEventListener('change', (e) => {
  const el = e.target as HTMLInputElement | HTMLSelectElement;
  const { action, id } = el.dataset;
  if (action === 'toggle-item' && id) {
    run(setItemStatus(id, (el as HTMLInputElement).checked ? 'bought' : 'todo'));
  } else if (action === 'toggle-circle' && id) {
    run(setCircleBought(id, (el as HTMLInputElement).checked));
  } else if (action === 'select-day') {
    if (el.value !== state.dayId) run(selectDay(el.value));
  } else if (action === 'sort') {
    setSort(el.value as Sort);
  }
});

// 背景タップでダイアログを閉じる
const dlg = document.getElementById('dlg') as HTMLDialogElement;
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) dlg.close();
});

function run(p: Promise<unknown>): void {
  p.catch((err) => {
    console.error(err);
    alert(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
  });
}

subscribe(render);
render();
run(init());
run(requestPersist());

// オフライン対応(http://localhost または HTTPS のときだけ有効)
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker の登録に失敗', err));
  });
}
