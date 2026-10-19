// メイン画面: イベント・日付の切り替え、合計、サークル一覧。

import { currentEvent, dayItems, isCollapsed, itemsOf, state } from '../store.js';
import type { CircleRec, ItemRec } from '../types.js';
import { STATUS_LABEL } from '../types.js';
import { compareSpace, esc, spaceLabel, totals, xUrl, yen } from '../util.js';

// 編集ボタンの鉛筆アイコン(文字の ✎ は端末のフォントで見た目が変わるため図形で描く)
const PENCIL =
  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

export function renderMain(): string {
  if (!state.ready) return `<p class="loading">読み込み中…</p>`;
  const ev = currentEvent();
  if (!ev) return renderEmpty();
  // マップ表示: 上部の帯と会場図だけ(画面を広く使う)
  if (state.view === 'map') {
    return `
      ${renderHeader(ev.name)}
      <div id="map-host"></div>
      ${renderTabbar()}
    `;
  }
  return `
    ${renderHeader(ev.name)}
    ${renderSummary(ev.budget)}
    ${renderToolbar()}
    <main class="list">${renderList()}</main>
    <button class="fab" data-action="add-circle" aria-label="サークルを追加">＋</button>
    ${renderTabbar()}
  `;
}

/** 画面下のタブ: リスト ⇔ マップ(今いる方が明るく、上に線が付く) */
function renderTabbar(): string {
  const tab = (view: 'list' | 'map', label: string, icon: string): string => `
    <button role="tab" class="tab${state.view === view ? ' on' : ''}" aria-selected="${state.view === view}" data-action="set-view" data-value="${view}">
      ${icon}<span>${label}</span>
    </button>`;
  return `
    <nav class="tabbar" role="tablist" aria-label="表示の切り替え">
      ${tab('list', 'リスト', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" fill="none"/></svg>')}
      ${tab('map', 'マップ', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s-7-7.3-7-12.2A7 7 0 0 1 19 9.8C19 14.7 12 22 12 22Z" fill="currentColor"/><circle cx="12" cy="9.6" r="2.6" fill="var(--tab-bg)"/></svg>')}
    </nav>`;
}

function renderEmpty(): string {
  return `
    <div class="empty">
      <h1>同人即売会お買い物</h1>
      <p>まずはイベントを作成してください。<br>例: C107(1日目・2日目)</p>
      <button class="btn primary" data-action="new-event">イベントを作成</button>
      <p class="or">PCで作ったデータがある場合</p>
      <button class="btn" data-action="open-data">ファイルから読み込む</button>
    </div>`;
}

/** 上部の帯(1段): イベント名・日付・データ。日付は1日だけならそのまま表示、2日以上はリストボックス */
function renderHeader(eventName: string): string {
  const day =
    state.days.length <= 1
      ? `<span class="day-one">${esc(state.days[0] ? dayText(state.days[0], 0) : '')}</span>`
      : `<select class="day-select" data-action="select-day" aria-label="日付を切り替え">
           ${state.days
             .map((d, i) => `<option value="${esc(d.id)}"${d.id === state.dayId ? ' selected' : ''}>${esc(dayText(d, i))}</option>`)
             .join('')}
         </select>`;
  return `
    <header class="top">
      <button class="event-btn" data-action="open-events" aria-label="イベントを切り替え">
        <span class="ev-name">${esc(eventName)}</span><span class="caret">▾</span>
      </button>
      ${day}
      <button class="data-btn" data-action="open-data">データ</button>
    </header>`;
}

/** 「1日目 12/30(水)」。名前が空なら日付だけ、両方空なら「n日目」 */
function dayText(d: { label: string; date: string }, idx: number): string {
  const date = d.date ? formatDate(d.date) : '';
  if (d.label && date) return `${d.label} ${date}`;
  return d.label || date || `${idx + 1}日目`;
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]})`;
}

function renderSummary(budget: number): string {
  const ev = totals(state.eventItems);
  const day = totals(dayItems());
  const pct = day.count ? Math.round((day.boughtCount / day.count) * 100) : 0;
  const left = budget - ev.bought;
  const leftIfAll = budget - ev.planned;
  const budgetCell = budget
    ? `<div class="stat">
         <span class="label">予算の残り</span>
         <span class="value${left < 0 ? ' over' : ''}">${yen(left)}</span>
         <span class="sub${leftIfAll < 0 ? ' over' : ''}">全部買うと ${yen(leftIfAll)}</span>
       </div>`
    : `<div class="stat">
         <span class="label">全日程の予定</span>
         <span class="value">${yen(ev.planned)}</span>
         <span class="sub">予算は未設定</span>
       </div>`;
  return `
    <section class="summary">
      <div class="stat">
        <span class="label">この日の予定</span>
        <span class="value">${yen(day.planned)}</span>
        <span class="sub">購入済み ${yen(day.bought)}</span>
      </div>
      ${budgetCell}
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="bar" style="width:${pct}%"></div>
        <span>${day.boughtCount} / ${day.count} 点</span>
      </div>
    </section>`;
}

/** いま表示中で、折りたためるサークルのID(「全て閉じる/開く」用) */
export function foldableIds(): string[] {
  return visibleCircles()
    .filter((c) => itemsOf(c.id).length > 0 || c.memo !== '')
    .map((c) => c.id);
}

function renderToolbar(): string {
  const todo = state.circles.filter((c) => !isDone(itemsOf(c.id))).length;
  const foldable = foldableIds();
  const anyOpen = foldable.some((id) => !isCollapsed(id));
  return `
    <div class="toolbar">
      <div class="seg" role="group" aria-label="表示">
        <button class="${state.filter === 'all' ? 'on' : ''}" data-action="filter" data-value="all">すべて<small>${state.circles.length}</small></button>
        <button class="${state.filter === 'todo' ? 'on' : ''}" data-action="filter" data-value="todo">未購入<small>${todo}</small></button>
      </div>
      ${
        foldable.length
          ? `<button class="fold-all" data-action="fold-all" data-value="${anyOpen ? 'close' : 'open'}">${anyOpen ? '全て閉じる' : '全て開く'}</button>`
          : '<span class="spacer"></span>'
      }
      <select class="sort" data-action="sort" aria-label="並び順">
        <option value="space"${state.sort === 'space' ? ' selected' : ''}>配置順</option>
        <option value="priority"${state.sort === 'priority' ? ' selected' : ''}>優先度順</option>
        <option value="route"${state.sort === 'route' ? ' selected' : ''}>回る順</option>
      </select>
    </div>`;
}

export function isDone(items: ItemRec[]): boolean {
  return items.length > 0 && items.every((i) => i.status !== 'todo');
}

function visibleCircles(): CircleRec[] {
  let list = [...state.circles];
  if (state.filter === 'todo') list = list.filter((c) => !isDone(itemsOf(c.id)));
  list.sort((a, b) => {
    if (state.sort === 'route') return a.order - b.order || compareSpace(a, b);
    if (state.sort === 'priority' && a.priority !== b.priority) return a.priority === 'must' ? -1 : 1;
    return compareSpace(a, b);
  });
  // 買い終わったサークルは下へ
  return list.sort((a, b) => Number(isDone(itemsOf(a.id))) - Number(isDone(itemsOf(b.id))));
}

function renderList(): string {
  const list = visibleCircles();
  if (state.circles.length === 0) {
    return `<p class="hint">右下の「＋」からサークルを追加します。<br>まとめて登録するときは右上の「データ」から。</p>`;
  }
  if (list.length === 0) return `<p class="hint">未購入のサークルはありません。</p>`;
  return list.map(renderCircle).join('');
}

export function renderCircle(c: CircleRec): string {
  const items = itemsOf(c.id);
  const t = totals(items);
  const done = isDone(items);
  const canFold = items.length > 0 || c.memo !== '';
  const folded = canFold && isCollapsed(c.id);
  // 折りたたみ中は1点だけのサークルでもチェックできるようにする
  const showCheckAll = items.length >= 2 || (folded && items.length === 1);
  // 見出しのタップ = 開閉。編集は右上の ✎ だけ(誤って編集画面に移らないように)
  const headAttrs = canFold
    ? `data-action="fold" data-id="${esc(c.id)}" role="button" tabindex="0" aria-expanded="${!folded}"`
    : '';
  return `
    <article class="circle${done ? ' done' : ''}${folded ? ' folded' : ''}">
      <div class="c-top">
        ${showCheckAll ? renderCheckAll(c.id, items) : ''}
        <div class="c-head${canFold ? ' foldable' : ''}" ${headAttrs}>
          <div class="c-line1">
            ${canFold ? '<span class="chev" aria-hidden="true"></span>' : ''}
            <span class="space">${esc(spaceLabel(c))}</span>
            ${c.priority === 'must' ? '<span class="badge must">必須</span>' : '<span class="badge">できれば</span>'}
          </div>
          <div class="c-name">${esc(c.name || '(名前未設定)')}${c.penName ? ` <span class="c-pen">${esc(c.penName)}</span>` : ''}</div>
          ${folded && items.length ? `<div class="c-fold-sum">${foldSummary(items)}</div>` : ''}
        </div>
        <div class="c-side">
          <div class="c-side-top">
            <span class="c-total">${yen(t.planned)}</span>
            <button class="edit-btn" data-action="edit-circle" data-id="${esc(c.id)}" aria-label="「${esc(c.name || 'サークル')}」を編集">${PENCIL}</button>
          </div>
          ${
            c.xHandle
              ? `<a class="x-link" href="${esc(xUrl(c.xHandle))}" target="_blank" rel="noopener noreferrer"
                   aria-label="Xで @${esc(c.xHandle)} を開く">@${esc(c.xHandle)} ↗</a>`
              : ''
          }
        </div>
      </div>
      ${!folded && items.length ? `<ul class="items">${items.map(renderItem).join('')}</ul>` : ''}
      ${!folded && c.memo ? `<p class="memo">${esc(c.memo)}</p>` : ''}
    </article>`;
}

/** 折りたたみ中に見出しへ出す要約(例: 3点・購入済み1・売り切れ1) */
function foldSummary(items: ItemRec[]): string {
  const n = (s: ItemRec['status']): number => items.filter((i) => i.status === s).reduce((a, i) => a + i.qty, 0);
  const all = items.reduce((a, i) => a + i.qty, 0);
  const parts = [`${all}点`];
  if (n('bought')) parts.push(`購入済み${n('bought')}`);
  if (n('soldout')) parts.push(`売り切れ${n('soldout')}`);
  if (n('skip')) parts.push(`見送り${n('skip')}`);
  return esc(parts.join('・'));
}

/** 頒布物が2つ以上あるサークル用の「まとめてチェック」。売り切れ・見送りは対象外 */
function renderCheckAll(circleId: string, items: ItemRec[]): string {
  const target = items.filter((i) => i.status === 'todo' || i.status === 'bought');
  const bought = target.filter((i) => i.status === 'bought').length;
  const all = target.length > 0 && bought === target.length;
  const some = bought > 0 && !all;
  return `
    <label class="check-all" aria-label="まとめてチェック">
      <input type="checkbox" data-action="toggle-circle" data-id="${esc(circleId)}"
        ${all ? ' checked' : ''}${some ? ' data-indeterminate' : ''}${target.length === 0 ? ' disabled' : ''}>
    </label>`;
}

function renderItem(i: ItemRec): string {
  // 売り切れ・見送りはチェックできない(状態を「未購入」に戻すと押せる)
  const locked = i.status === 'soldout' || i.status === 'skip';
  // 状態ボタン: 売り切れ・見送りのときだけ色付きの文字、それ以外は「⋯」
  const statusText = locked ? STATUS_LABEL[i.status] : '⋯';
  return `
    <li class="item st-${i.status}">
      <label class="check">
        <input type="checkbox" data-action="toggle-item" data-id="${esc(i.id)}"${i.status === 'bought' ? ' checked' : ''}${locked ? ' disabled' : ''}>
        <span class="i-name">${esc(i.name || '(品名なし)')}</span>
        <span class="i-price">${yen(i.price)}${i.qty > 1 ? ` ×${i.qty}` : ''}</span>
      </label>
      <button class="i-status" data-action="status-menu" data-id="${esc(i.id)}"
        aria-haspopup="menu" aria-label="状態を変更(今: ${STATUS_LABEL[i.status]})">${statusText}</button>
    </li>`;
}
