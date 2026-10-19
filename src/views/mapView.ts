// マップ画面: 会場図の上にサークルのピンを表示する。
// ・指2本(ピンチ)/ホイール/ボタンで拡大縮小、ドラッグで移動、ダブルタップで拡大
// ・ピンをタップすると、そのサークルのカード(チェックもできる)を下に表示
// ・「ピンを置く」モード: サークルを選んで地図をタップすると配置。ピンはドラッグで動かせる
// ・「島の編集」モード(L1): 会場図の島を長方形で囲み、各辺の番号を入れると、
//   配置番号からピンの位置が自動で決まる(手で置いたピンがあればそちらが優先)
// ・会場データ(マス目)がある日は、画像の代わりにマス目を描いて表示し、配置番号から位置を決める
//   (会場データに無い番号のサークルだけ、手でピンを置ける)。
//   会場データは1日に何枚も持てる(シート)。上のタブで切り替え、サークルは配置番号が見つかったシートに出る
// ・動線(「動線」をオン): 回る順番の番号をピンに出し、まだ買っていないサークルを順に結ぶ線を描く。
//   線は最後に買い終わったサークル(無ければスタート地点)から始まり、次に行くサークルを強調する。
//   距離は通路に沿って測る(計算は C++ / WebAssembly。src/route/)
//
// 画面全体は状態が変わるたびに描き直されるが、この画面の要素は作り直さずに付け替える
// (画像の読み込み直しや、拡大・移動の状態が失われるのを防ぐため)。

import { buildIslandIndex, islandSpaces, matchesBlock, parseNumbers, SIDES } from '../islands.js';
import type { IslandIndex, Side } from '../islands.js';
import {
  deleteGrid,
  deleteIsland,
  deleteMap,
  getGrids,
  getMap,
  itemsOf,
  reorderGrids,
  saveIsland,
  saveMap,
  setCirclePos,
  setFilter,
  setSheetPref,
  sheetPref,
  state,
} from '../store.js';
import type { CircleRec, GridRec, IslandRec } from '../types.js';
import { buildGridIndex, CELL_PX, gridFromTokens, renderGridSvg, resolveGrid, spaceCount } from '../venueGrid.js';
import type { GridIndex, ResolvedGrid } from '../venueGrid.js';
import { compareSpace, esc, spaceLabel, uid } from '../util.js';
import { closeDialog, openDialog, toast } from './dialog.js';
import { blocksHtml, exportGridCsv, issuesHtml, openBlockRename, openGridPicker } from './gridDialogs.js';
import { routeMapFromGrid, routeMapFromImage } from '../route/build.js';
import type { RouteMap } from '../route/build.js';
import { parseStartKey, remaining } from '../route/plan.js';
import type { PlanInput, RemainingRoute } from '../route/plan.js';
import { computeRoute, distText, openRouteEditDialog, openRoutePlanDialog } from './routeView.js';
import { isDone, renderCircle } from './mainView.js';

interface Viewport {
  s: number; // 拡大率(画像1pxが画面で何px か)
  tx: number; // 画像の左上の画面上の位置
  ty: number;
  fitted: boolean; // 全体表示のままか(画面の大きさが変わったら合わせ直す)
}

type Mode = 'view' | 'place' | 'island';

let root: HTMLElement | null = null;
let wrap!: HTMLElement;
let layer!: HTMLElement;
let img!: HTMLImageElement;
let islLayer!: HTMLElement;
let pinLayer!: HTMLElement;
let bar!: HTMLElement;
let tabs!: HTMLElement;
let panel!: HTMLElement;
let empty!: HTMLElement;

let loadedView = ''; // 表示中の「日|シート」(拡大・移動の状態を覚えておく単位)
let loadedKey = ''; // 表示中のもの(会場データ/画像)と更新時刻

/** 会場データの1枚(シート)と、読み取った結果 */
interface SheetView {
  rec: GridRec;
  res: ResolvedGrid;
  idx: GridIndex;
}
let sheets: SheetView[] = []; // この日のシート(並び順)
let sheetsSig = '';
const sheetCache = new Map<string, SheetView>(); // id → 読み取った結果(更新時刻が同じなら使い回す)
let gridRec: GridRec | null = null; // 表示中のシート(あれば画像の代わりに表示)
let gridRes: ResolvedGrid | null = null;
let gridIdx: GridIndex | null = null;
const multi = (): boolean => sheets.length > 1;
let hasImage = false; // この日に会場図の画像があるか(会場データ表示中も)
let imgW = 0;
let imgH = 0;
let objectUrl: string | null = null;
let loadToken = 0;

// 会場データを組ごとに色分けするか(端末ごとの表示設定)
const COLOR_KEY = 'doujin-shopping:gridColor';
function gridColorOn(): boolean {
  try {
    return localStorage.getItem(COLOR_KEY) !== '0';
  } catch {
    return true;
  }
}
function setGridColor(on: boolean): void {
  try {
    localStorage.setItem(COLOR_KEY, on ? '1' : '0');
  } catch {
    /* 保存できなくても今回の表示は切り替える */
  }
}

// 動線を表示するか(端末ごとの表示設定)
const ROUTE_KEY = 'doujin-shopping:route';
let routeOn = ((): boolean => {
  try {
    return localStorage.getItem(ROUTE_KEY) === '1';
  } catch {
    return false;
  }
})();
function setRouteOn(on: boolean): void {
  routeOn = on;
  try {
    localStorage.setItem(ROUTE_KEY, on ? '1' : '0');
  } catch {
    /* 保存できなくても今回の表示は切り替える */
  }
}
let routeSvg!: SVGGElement; // 線を入れる <g>。拡大・移動は transform で合わせる(線の太さは画面上で一定)
let routeData: { key: string; rr: RemainingRoute; map: RouteMap } | null = null;
let routeBusy = ''; // 計算中の内容(同じ内容で何度も計算しないように)
let routeMapCache: { src: unknown; islands: IslandRec[]; w: number; map: RouteMap } | null = null;

const viewports = new Map<string, Viewport>(); // 日ごとに拡大・移動の状態を覚えておく
let vp: Viewport = { s: 1, tx: 0, ty: 0, fitted: true };

let mode: Mode = 'view';
let selected: string | null = null; // カードを出しているサークル
let target: string | null = null; // ピンを置く対象のサークル
let selIsland: string | null = null; // 編集中の島
let drawArmed = false; // 「＋島を追加」の後、次のドラッグで島を描く

/** 画面内の置き場所(#map-host)に、マップ画面を付ける */
export function mountMap(host: HTMLElement): void {
  if (!root) build();
  host.replaceWith(root!);
  renderAll();
  void loadMapIfNeeded();
}

// ---------------------------------------------------------------- 組み立て

function build(): void {
  root = document.createElement('div');
  root.className = 'map-view';
  root.innerHTML = `
    <div class="map-bar"></div>
    <div class="sheet-tabs" role="tablist" aria-label="会場データのシート" hidden></div>
    <div class="map-wrap">
      <div class="map-layer"><img class="map-img" alt="会場図" draggable="false"></div>
      <svg class="route-layer" xmlns="http://www.w3.org/2000/svg"><g class="route-g"></g></svg>
      <div class="isl-layer"></div>
      <div class="pin-layer"></div>
      <div class="map-ctl" role="group" aria-label="拡大縮小">
        <button type="button" data-mact="zoom-in" aria-label="拡大">＋</button>
        <button type="button" data-mact="zoom-out" aria-label="縮小">－</button>
        <button type="button" data-mact="fit" aria-label="全体を表示">全体</button>
      </div>
      <div class="map-empty" hidden></div>
    </div>
    <div class="map-panel"></div>`;
  bar = root.querySelector('.map-bar')!;
  tabs = root.querySelector('.sheet-tabs')!;
  wrap = root.querySelector('.map-wrap')!;
  layer = root.querySelector('.map-layer')!;
  img = root.querySelector('.map-img')!;
  routeSvg = root.querySelector('.route-g')!;
  islLayer = root.querySelector('.isl-layer')!;
  pinLayer = root.querySelector('.pin-layer')!;
  panel = root.querySelector('.map-panel')!;
  empty = root.querySelector('.map-empty')!;

  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('input', onInput);
  setupGestures();
  new ResizeObserver(() => {
    if (!imgW) return;
    if (vp.fitted) fit();
    apply();
  }).observe(wrap);
}

// ---------------------------------------------------------------- 会場図の読み込み

async function loadMapIfNeeded(): Promise<void> {
  const dayId = state.dayId;
  if (!dayId) return;
  const token = ++loadToken;
  const [grids, rec] = await Promise.all([getGrids(dayId), getMap(dayId)]);
  if (token !== loadToken) return; // 途中で日が切り替わった

  // シートの一覧(読み取りは更新時刻が変わったものだけ)
  const sig = `${dayId}|${grids.map((g) => `${g.id}:${g.updatedAt}:${g.order}`).join(',')}`;
  const sheetsChanged = sig !== sheetsSig;
  if (sheetsChanged) {
    sheets = grids.map((g) => {
      const hit = sheetCache.get(g.id);
      if (hit && hit.rec.updatedAt === g.updatedAt) return { ...hit, rec: g };
      const res = resolveGrid(gridFromTokens(g.name, g.tokens, g.hall));
      const v = { rec: g, res, idx: buildGridIndex(res) };
      sheetCache.set(g.id, v);
      return v;
    });
    sheetsSig = sig;
    sheetOfCache = new WeakMap();
  }
  const cur = sheets.find((v) => v.rec.id === sheetPref(dayId)) ?? sheets[0] ?? null;
  const view = `${dayId}|${cur ? cur.rec.id : 'img'}`;
  const key = cur ? `grid:${cur.rec.id}:${cur.rec.updatedAt}:${gridColorOn() ? 'c' : 'm'}` : rec ? `img:${rec.updatedAt}` : '';
  hasImage = !!rec;
  if (view === loadedView && key === loadedKey) {
    if (sheetsChanged) renderAll(); // シートの追加・並べ替えなど(表示中の図は同じ)
    return;
  }

  const sameView = view === loadedView; // 同じ日・同じシートで、中身だけ変わった(差し替え・ブロック名の変更)
  if (loadedView && !sameView) viewports.set(loadedView, vp);
  loadedView = view;
  loadedKey = key;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  gridRec = cur?.rec ?? null;
  gridRes = cur?.res ?? null;
  gridIdx = cur?.idx ?? null;
  if (selected && !state.circles.some((c) => c.id === selected && posOf(c))) selected = null; // 別のシートのサークル

  if (gridRes) {
    // マス目の図は SVG。表示の大きさで一度だけ描かれ、拡大するとぼやけるため、
    // 大きめ(画素数 約1200万まで・最大3倍)の大きさで描かせる
    const w = gridRes.grid.cols * CELL_PX;
    const h = gridRes.grid.rows * CELL_PX;
    const k = Math.max(1, Math.min(3, Math.sqrt(12_000_000 / Math.max(1, w * h))));
    imgW = Math.round(w * k);
    imgH = Math.round(h * k);
    objectUrl = URL.createObjectURL(new Blob([renderGridSvg(gridRes, { color: gridColorOn() })], { type: 'image/svg+xml' }));
  } else if (rec) {
    imgW = rec.width;
    imgH = rec.height;
    objectUrl = URL.createObjectURL(rec.blob);
  } else {
    imgW = imgH = 0;
    img.removeAttribute('src');
    renderAll();
    return;
  }
  img.width = imgW;
  img.height = imgH;
  img.src = objectUrl;
  if (!sameView) {
    const saved = viewports.get(view);
    if (saved && !saved.fitted) vp = { ...saved };
    else fit();
  } else if (!gridRes) fit(); // 画像の差し替え。会場データの更新(ブロック名の変更など)では見ている場所を保つ
  apply();
  renderAll();
}

// ---------------------------------------------------------------- ピンの位置(手動 → 島から自動)

const dayIslands = (): IslandRec[] => state.islands.filter((x) => x.dayId === state.dayId);

let indexCache: { islands: IslandRec[]; w: number; h: number; index: IslandIndex } | null = null;
function islandIndex(): IslandIndex {
  const islands = dayIslands();
  const c = indexCache;
  if (!c || c.w !== imgW || c.h !== imgH || c.islands.length !== islands.length || c.islands.some((x, i) => x !== islands[i])) {
    indexCache = { islands, w: imgW, h: imgH, index: buildIslandIndex(islands, imgW, imgH) };
  }
  return indexCache!.index;
}

// ---- 会場データのシート ----

let sheetOfCache = new WeakMap<CircleRec, string | null>();

/** 配置番号から位置が決まるシート(並び順で最初のもの) */
function autoSheetOf(c: CircleRec): SheetView | null {
  return sheets.find((v) => v.idx.find(c)) ?? null;
}

/**
 * サークルのピンが出るシートの id。配置番号から決まるシート → 手で置いたシート
 * (シートの記録が無い・消えたピンは最初のシート)。どこにも無ければ null
 */
function sheetIdOf(c: CircleRec): string | null {
  if (!sheets.length) return null;
  const hit = sheetOfCache.get(c);
  if (hit !== undefined) return hit;
  const auto = autoSheetOf(c);
  const id = auto
    ? auto.rec.id
    : c.x !== undefined && c.y !== undefined
      ? sheets.some((v) => v.rec.id === c.sheet)
        ? c.sheet!
        : sheets[0].rec.id
      : null;
  sheetOfCache.set(c, id);
  return id;
}

const sheetName = (id: string | null): string => sheets.find((v) => v.rec.id === id)?.rec.name || '(名前なし)';

/** 表示中のシートにピンが出るサークル(シートが1枚以下なら全部) */
const onThisSheet = (c: CircleRec): boolean => !multi() || sheetIdOf(c) === gridRec?.id;

/** シートの並び順(動線の順番をシートごとにまとめるため)。どのシートにも無ければ最後 */
function sheetRank(c: CircleRec): number {
  const i = sheets.findIndex((v) => v.rec.id === sheetIdOf(c));
  return i < 0 ? sheets.length : i;
}

function switchSheet(id: string): void {
  if (!state.dayId || id === gridRec?.id) return;
  selected = null;
  target = null;
  setSheetPref(state.dayId, id);
}

/** 配置番号から決まる位置(会場データがあればそれ、無ければ島から) */
function autoPos(c: CircleRec): { x: number; y: number } | null {
  if (!imgW) return null;
  return gridIdx ? gridIdx.find(c) : islandIndex().find(c);
}

/**
 * ピンの位置。
 * 会場データ表示中: 会場データの位置 → 手で置いた位置(会場データに無い番号のとき)
 * 画像表示中: 手で置いた位置 → 島から計算した位置
 */
function posOf(c: CircleRec): { x: number; y: number; auto: boolean } | null {
  if (gridIdx) {
    if (sheetIdOf(c) !== gridRec!.id) return null; // 別のシートにある
    const g = gridIdx.find(c);
    if (g) return { ...g, auto: true };
  }
  if (c.x !== undefined && c.y !== undefined) return { x: c.x, y: c.y, auto: false };
  if (gridIdx) return null;
  const p = autoPos(c);
  return p ? { ...p, auto: true } : null;
}

/** 会場データ(どれかのシート)で位置が決まっていて、手では動かせないサークル */
const fixedByGrid = (c: CircleRec | undefined): boolean => !!(c && autoSheetOf(c));

// ---------------------------------------------------------------- 描画

function renderAll(): void {
  if (!root) return;
  if ((mode !== 'view' && !imgW) || (mode === 'island' && gridIdx)) mode = 'view';
  if (selected && !state.circles.some((c) => c.id === selected)) selected = null;
  if (target && !state.circles.some((c) => c.id === target)) target = null;
  if (selIsland && !dayIslands().some((x) => x.id === selIsland)) selIsland = null;
  root.classList.toggle('mode-island', mode === 'island');
  renderBar();
  renderTabs();
  renderEmpty();
  renderIslands();
  updateRoute();
  renderPins();
  renderPanel();
}

// ---------------------------------------------------------------- 動線

const routeMeta = () => state.days.find((d) => d.id === state.dayId)?.route;
const showRoute = (): boolean => routeOn && mode === 'view' && imgW > 0;

/** 動線の計算に使う地図(会場データがあればマス目、無ければ画像 + 島) */
function routeMap(): RouteMap {
  const islands = dayIslands();
  const src = gridRes ?? img.src;
  const c = routeMapCache;
  if (c && c.src === src && c.w === imgW && c.islands.length === islands.length && c.islands.every((x, i) => x === islands[i])) {
    return c.map;
  }
  const map = gridRes ? routeMapFromGrid(gridRes) : routeMapFromImage(imgW, imgH, islands);
  routeMapCache = { src, islands, w: imgW, map };
  return map;
}

function planInput(map: RouteMap): PlanInput {
  return {
    map,
    circles: state.circles.filter(onThisSheet), // シートが何枚もある日は、表示中のシートのサークルだけ
    cellsOf: (c) => gridIdx?.cells(c) ?? [],
    posOf: (c) => {
      const p = posOf(c);
      return p ? { x: p.x, y: p.y } : null;
    },
    isDone: (c) => isDone(itemsOf(c.id)),
  };
}

/** 線を引き直す必要があるか調べ、必要なら計算する(終わったら描く) */
function updateRoute(): void {
  const meta = routeMeta();
  if (!showRoute() || !meta) {
    if (routeData || routeSvg.innerHTML) {
      routeData = null;
      routeSvg.innerHTML = '';
    }
    return;
  }
  const map = routeMap();
  const key = [
    state.dayId,
    loadedKey,
    meta.start,
    map.cols,
    map.rows,
    ...state.circles.map((c) => {
      const p = posOf(c);
      return `${c.id}:${c.order}:${isDone(itemsOf(c.id)) ? 1 : 0}:${p ? `${p.x.toFixed(4)},${p.y.toFixed(4)}` : '-'}:${c.hall}${c.block}${c.number}`;
    }),
  ].join('|');
  if (routeData?.key === key || routeBusy === key) return;
  routeBusy = key;
  void remaining(planInput(map), parseStartKey(meta.start)).then((rr) => {
    if (routeBusy !== key) return; // 途中で内容が変わった
    routeBusy = '';
    routeData = { key, rr, map };
    drawRoute();
    renderPins();
    renderPanel();
  });
}

function drawRoute(): void {
  if (!routeData || !showRoute()) {
    routeSvg.innerHTML = '';
    return;
  }
  const { rr, map } = routeData;
  const pt = (cell: number): string => {
    const p = map.center(cell);
    return `${(p.x * imgW).toFixed(1)},${(p.y * imgH).toFixed(1)}`;
  };
  const parts: string[] = [];
  // 次の区間を最後に描いて、いちばん上に重ねる
  rr.result.legs.forEach((leg, i) => {
    if (i === 0 || leg.path.length < 2) return;
    parts.push(`<polyline class="leg" points="${leg.path.map(pt).join(' ')}"/>`);
  });
  const first = rr.result.legs[0];
  if (first && first.path.length >= 2) {
    parts.push(`<polyline class="leg next" points="${first.path.map(pt).join(' ')}"/>`);
    const [sx, sy] = pt(first.path[0]).split(',');
    parts.push(`<circle class="leg-start" cx="${sx}" cy="${sy}" r="${7 / vp.s}"/>`);
  }
  routeSvg.innerHTML = parts.join('');
}

/** 回る順番の番号(位置の分かるサークルを順番どおりに 1, 2, 3…) */
function routeNumbers(): Map<string, number> {
  const m = new Map<string, number>();
  if (!showRoute() || !routeMeta()) return m;
  [...state.circles]
    .filter((c) => posOf(c))
    .sort((a, b) => a.order - b.order)
    .forEach((c, i) => m.set(c.id, i + 1));
  return m;
}

function sortedCircles(): CircleRec[] {
  return [...state.circles].sort(compareSpace);
}

/**
 * 中身が変わったときだけ書き換える。押そうとしているボタンを押す途中で作り直すと、
 * クリックが届かなくなる(入力欄から別のボタンへ移ったときなど)ため
 */
function setHtml(el: HTMLElement, html: string): void {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

function renderBar(): void {
  if (!imgW) {
    setHtml(bar, '');
    return;
  }
  if (mode === 'island') {
    const n = dayIslands().length;
    setHtml(bar, drawArmed
      ? `<span class="map-count strong">地図の上をドラッグして島を囲んでください</span>
         <span class="spacer"></span>
         <button type="button" class="btn small" data-mact="isl-cancel">やめる</button>`
      : `<span class="map-count">島の編集・${n}個</span>
         <span class="spacer"></span>
         <button type="button" class="btn small" data-mact="isl-add">＋島を追加</button>
         <button type="button" class="btn small primary" data-mact="isl-done">完了</button>`);
    return;
  }
  const placed = state.circles.filter((c) => (multi() ? sheetIdOf(c) : posOf(c))).length;
  setHtml(bar, `
    <label class="chip-toggle"><input type="checkbox" data-mact="filter"${state.filter === 'todo' ? ' checked' : ''}>未購入のみ</label>
    ${mode === 'view' ? `<label class="chip-toggle"><input type="checkbox" data-mact="route"${routeOn ? ' checked' : ''}>動線</label>` : ''}
    <span class="map-count">ピン ${placed}/${state.circles.length}</span>
    <span class="spacer"></span>
    ${
      mode === 'place'
        ? '<button type="button" class="btn small primary" data-mact="place-done">完了</button>'
        : `<button type="button" class="btn small" data-mact="place-start"${state.circles.length ? '' : ' disabled'}>ピンを置く</button>`
    }
    <button type="button" class="btn small" data-mact="map-menu">会場図</button>`);
}

/** シートのタブ(2枚以上のとき)。まだ買っていないサークルの数も出す */
function renderTabs(): void {
  if (!multi() || mode === 'island') {
    tabs.hidden = true;
    setHtml(tabs, '');
    return;
  }
  tabs.hidden = false;
  const todo = new Map<string, number>();
  for (const c of state.circles) {
    const id = sheetIdOf(c);
    if (id && !isDone(itemsOf(c.id))) todo.set(id, (todo.get(id) ?? 0) + 1);
  }
  setHtml(
    tabs,
    sheets
      .map((v) => {
        const on = v.rec.id === gridRec?.id;
        const n = todo.get(v.rec.id) ?? 0;
        return `<button type="button" class="sheet-tab${on ? ' on' : ''}" role="tab" aria-selected="${on}" data-mact="sheet" data-id="${esc(v.rec.id)}">
          <span class="st-name">${esc(v.rec.name || '(名前なし)')}</span>${n ? `<span class="st-count" aria-label="未購入${n}件">${n}</span>` : ''}
        </button>`;
      })
      .join(''),
  );
  tabs.querySelector('.sheet-tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderEmpty(): void {
  const has = imgW > 0;
  empty.hidden = has;
  wrap.classList.toggle('no-map', !has);
  if (has) return;
  setHtml(empty, `
    <p><strong>この日の会場図がありません</strong></p>
    <button type="button" class="btn primary file-btn" data-mact="grid-use">会場データ(マス目)を使う</button>
    <p class="note small">東京流通センター(GSF)はアプリに入っています。Excelで作ったCSVも読み込めます。配置番号からピンの位置が自動で決まります。</p>
    <label class="btn file-btn">画像を選ぶ
      <input type="file" accept="image/*" data-mact="file" hidden>
    </label>
    <p class="note small">公式サイトやカタログの配置図の画像(PNG・JPEG)を読み込みます。画像は端末の中だけに保存されます。PDFしかない場合は、PCで画像として保存してから読み込んでください。</p>`);
}

/** ピンの文字: スペース番号だけ(ブロックは地図で分かるので出さない)。番号が無ければ名前の先頭 */
function pinLabel(c: CircleRec): string {
  return c.number || (c.name || '?').slice(0, 5);
}

/** 引いて見ているときの短い表示(番号だけ) */
function pinShort(c: CircleRec): string {
  return c.number || (c.name || '?').slice(0, 3);
}

function renderPins(): void {
  if (!imgW) {
    pinLayer.innerHTML = '';
    return;
  }
  const visible = state.circles.filter(
    (c) => posOf(c) && (mode !== 'view' || state.filter === 'all' || !isDone(itemsOf(c.id)) || c.id === selected),
  );
  const nums = routeNumbers();
  const next = showRoute() ? routeData?.rr.next : null;
  pinLayer.innerHTML = visible
    .map((c) => {
      const n = nums.get(c.id);
      const cls = [
        'pin',
        c.priority === 'must' ? 'must' : 'want',
        isDone(itemsOf(c.id)) ? 'done' : '',
        posOf(c)?.auto ? 'auto' : '',
        c.id === selected ? 'selected' : '',
        mode === 'place' && c.id === target ? 'target' : '',
        c.id === next ? 'next' : '',
        n ? 'numbered' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const num = n ? `<span class="pl-num">${n}</span>` : '';
      return `<button type="button" class="${cls}" data-pin="${esc(c.id)}" aria-label="${esc(`${n ? `${n}番目 ` : ''}${spaceLabel(c)} ${c.name}`)}">${num}<span class="pl-full">${esc(pinLabel(c))}</span><span class="pl-short">${n ? '' : esc(pinShort(c))}</span></button>`;
    })
    .join('');
  positionPins();
}

function positionPins(): void {
  // 全体表示に近い倍率では、ピンが重ならないよう番号だけにする
  pinLayer.classList.toggle('compact', vp.s < fitScale() * 1.6);
  const byId = new Map(state.circles.map((c) => [c.id, c]));
  pinLayer.querySelectorAll<HTMLElement>('[data-pin]').forEach((el) => {
    const c = byId.get(el.dataset.pin!);
    const p = c && posOf(c);
    if (!p) return;
    el.style.transform = `translate(${vp.tx + p.x * imgW * vp.s}px, ${vp.ty + p.y * imgH * vp.s}px) translate(-50%, -50%)`;
  });
}

// ---- 島(編集モードのときだけ表示) ----

function renderIslands(): void {
  if (mode !== 'island' || !imgW) {
    islLayer.innerHTML = '';
    return;
  }
  islLayer.innerHTML = dayIslands()
    .map((isl) => {
      const sel = isl.id === selIsland;
      const nums = sel
        ? islandSpaces(isl, imgW, imgH)
            .map((s) => `<span class="isl-num" data-nx="${s.x}" data-ny="${s.y}">${esc(s.number)}</span>`)
            .join('')
        : '';
      const handles = sel
        ? ['nw', 'ne', 'sw', 'se'].map((h) => `<span class="isl-handle h-${h}" data-handle="${h}"></span>`).join('')
        : '';
      return `
        <div class="isl${sel ? ' selected' : ''}" data-isl="${esc(isl.id)}">
          <span class="isl-label">${esc(isl.block || '(ブロック名なし)')}</span>${handles}
        </div>${nums}`;
    })
    .join('');
  positionIslands();
}

function positionIslands(): void {
  if (mode !== 'island') return;
  const byId = new Map(dayIslands().map((x) => [x.id, x]));
  islLayer.querySelectorAll<HTMLElement>('[data-isl]').forEach((el) => {
    const isl = byId.get(el.dataset.isl!);
    if (!isl) return;
    el.style.left = `${vp.tx + isl.x * imgW * vp.s}px`;
    el.style.top = `${vp.ty + isl.y * imgH * vp.s}px`;
    el.style.width = `${isl.w * imgW * vp.s}px`;
    el.style.height = `${isl.h * imgH * vp.s}px`;
  });
  // 番号のマスが画面上で小さいとき(引いて見ているとき)は、文字の代わりに点で示す
  const sel = byId.get(selIsland ?? '');
  if (sel) {
    const across = Math.max(parseNumbers(sel.top).length, parseNumbers(sel.bottom).length, 1);
    const down = Math.max(parseNumbers(sel.left).length, parseNumbers(sel.right).length, 1);
    const cell = Math.min((sel.w * imgW) / across, (sel.h * imgH) / (down + 2)) * vp.s;
    islLayer.classList.toggle('tiny', cell < 14);
  }
  islLayer.querySelectorAll<HTMLElement>('.isl-num').forEach((el) => {
    const x = Number(el.dataset.nx);
    const y = Number(el.dataset.ny);
    el.style.transform = `translate(${vp.tx + x * imgW * vp.s}px, ${vp.ty + y * imgH * vp.s}px) translate(-50%, -50%)`;
  });
}

function renderPanel(): void {
  if (mode === 'island') {
    renderIslandPanel();
    return;
  }
  if (mode === 'place') {
    const list = placeList();
    const t = list.find((c) => c.id === target);
    const tp = t ? posOf(t) : null;
    setHtml(panel, `
      <div class="place-panel">
        <p class="note">${
          fixedByGrid(t)
            ? `「${esc(t!.name || spaceLabel(t!))}」は会場データ${multi() ? `(${esc(sheetName(sheetIdOf(t!)))})` : ''}で位置が決まっています(違うときは配置番号を直してください)。`
            : t
              ? `「${esc(t.name || spaceLabel(t))}」を置く場所を、地図の上でタップしてください。置いたピンはドラッグで動かせます。`
              : '下からサークルを選んで、地図の上をタップするとピンを置けます。'
        }</p>
        <div class="chips">
          ${list
            .map((c) => {
              const p = posOf(c);
              return `
            <button type="button" class="chip${p ? ' placed' : ''}${c.id === target ? ' on' : ''}" data-mact="target" data-id="${esc(c.id)}">
              ${p ? `<span class="chip-ok" aria-label="${p.auto ? '配置番号から自動' : '配置済み'}">${p.auto ? '自動' : '✓'}</span>` : ''}<span class="space">${esc(spaceLabel(c) || pinLabel(c))}</span>
              <span class="chip-name">${esc(c.name)}</span>
            </button>`;
            })
            .join('')}
        </div>
        ${
          t && tp && !tp.auto
            ? `<button type="button" class="btn small danger" data-mact="unpin">${
                autoPos(t) ? '自動の位置に戻す' : 'このピンを外す'
              }</button>`
            : ''
        }
      </div>`);
    panel.querySelector('.chip.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    return;
  }
  const c = state.circles.find((x) => x.id === selected);
  if (c) {
    setHtml(panel, `
      <div class="map-card">
        <div class="map-card-head">
          ${showRoute() && posOf(c) && !isDone(itemsOf(c.id)) ? '<button type="button" class="btn small" data-mact="route-here">ここから順番を計算</button>' : ''}
          <span class="spacer"></span>
          <button type="button" class="map-card-close" data-mact="close-card">✕ 閉じる</button>
        </div>
        ${renderCircle(c)}
      </div>`);
    panel.querySelectorAll<HTMLInputElement>('input[data-indeterminate]').forEach((el) => (el.indeterminate = true));
    return;
  }
  if (showRoute()) {
    setHtml(panel, routePanelHtml());
    return;
  }
  const unplaced = state.circles.filter((x) => (multi() ? !sheetIdOf(x) : !posOf(x))).length;
  setHtml(
    panel,
    imgW
    ? `<p class="map-hint">${
        state.circles.length === 0
          ? 'この日のサークルがまだありません。'
          : unplaced
            ? gridIdx
              ? `ピンをタップするとサークルの詳細が出ます。会場データに配置番号が無いサークルが${unplaced}件あります(ブロック名の違いなら「会場図」→「ブロック名を変更」、または「ピンを置く」から手で置けます)。`
              : `ピンをタップするとサークルの詳細が出ます。位置が決まっていないサークルが${unplaced}件あります(「ピンを置く」か、「会場図」→「島を編集」から)。`
            : 'ピンをタップするとサークルの詳細が出ます。'
      }</p>`
    : '',
  );
}

/** 動線の順番の計算・編集に渡す設定(シートが何枚もある日は、表示中のシートの分だけ) */
function routeOpts(): { sheetName?: string; rank?: (c: CircleRec) => number } {
  return multi() ? { sheetName: gridRec?.name || '(名前なし)', rank: sheetRank } : {};
}

/** このシートを回り終えたときの、他のシートへのボタン(まだ買っていないサークルがあるもの) */
function otherSheetsHtml(): string {
  if (!multi()) return '';
  const left = sheets
    .filter((v) => v.rec.id !== gridRec?.id)
    .map((v) => ({ v, n: state.circles.filter((c) => sheetIdOf(c) === v.rec.id && !isDone(itemsOf(c.id))).length }))
    .filter((x) => x.n > 0);
  if (!left.length) return '';
  return `<div class="route-others">${left
    .map((x) => `<button type="button" class="btn small" data-mact="sheet" data-id="${esc(x.v.rec.id)}">${esc(x.v.rec.name || '(名前なし)')}へ(残り${x.n}件)</button>`)
    .join('')}</div>`;
}

/** 動線を表示しているときの下の欄: 次に行くサークルと、残りの道のり */
function routePanelHtml(): string {
  const actions = `
    <div class="actions">
      <button type="button" class="btn small" data-mact="route-plan">順番を計算</button>
      <button type="button" class="btn small" data-mact="route-edit"${state.circles.length ? '' : ' disabled'}>順番を編集</button>
    </div>`;
  if (!routeMeta()) {
    return `<div class="route-panel"><p class="note">回る順番がまだ決まっていません。「順番を計算」で、通路に沿った道のりが短くなる順番を決めます。</p>${actions}</div>`;
  }
  if (!routeData) return `<div class="route-panel"><p class="note">計算中…</p>${actions}</div>`;
  const { rr } = routeData;
  const next = state.circles.find((c) => c.id === rr.next);
  if (!next) {
    const others = otherSheetsHtml();
    return others
      ? `<div class="route-panel"><p class="note"><strong>このシートは全部回りました。</strong>次のシートへ:</p>${others}${actions}</div>`
      : `<div class="route-panel"><p class="note"><strong>全部回りました。</strong>おつかれさまでした。</p>${actions}</div>`;
  }
  const left = rr.result.legs.length;
  const unreached = rr.result.legs.filter((l) => l.cost < 0).length;
  const n = routeNumbers().get(next.id);
  return `
    <div class="route-panel">
      <button type="button" class="route-next" data-mact="route-next">
        <span class="rn-label">次</span>
        ${n ? `<span class="rn-num">${n}</span>` : ''}
        <span class="space">${esc(spaceLabel(next))}</span>
        <span class="rn-name">${esc(next.name)}</span>
        ${next.priority === 'must' ? '<span class="badge must">必須</span>' : ''}
      </button>
      <p class="note small">残り ${left}件・道のり ${distText(rr.result.total)}${unreached ? `・たどり着けない所 ${unreached}件` : ''}${
        rr.result.engine === 'js' ? '(JavaScriptで計算)' : ''
      }</p>
      ${actions}
    </div>`;
}

const SIDE_LABEL: Record<Side, string> = {
  top: '上辺(左→右)',
  right: '右辺(上→下)',
  bottom: '下辺(左→右)',
  left: '左辺(上→下)',
};

/** 島の入力欄の下の説明(ブロックのサークルのうち、何件の位置が決まったか) */
function islandNote(isl: IslandRec): string {
  const inBlock = state.circles.filter((c) => c.block && matchesBlock(isl, c));
  const located = inBlock.filter((c) => islandIndex().find(c)).length;
  const head = !isl.block.trim()
    ? 'ブロック名を入れてください。'
    : inBlock.length
      ? `買い物リストの「${esc(isl.block)}」のサークル ${inBlock.length}件のうち ${located}件の位置が決まっています。`
      : `「${esc(isl.block)}」のサークルは、まだ買い物リストにありません。`;
  return `${head}番号の位置は地図に表示されます。印刷とずれていたら、島の位置・大きさや番号を直してください。`;
}

function renderIslandPanel(): void {
  const isl = dayIslands().find((x) => x.id === selIsland);
  if (!isl) {
    setHtml(panel, `
      <div class="isl-panel">
        <p class="note">会場図の島を長方形で囲み、各辺に印刷されている番号を入れると、配置番号からピンの位置が自動で決まります。</p>
        <ol class="steps note">
          <li>「＋島を追加」→ 地図の上をドラッグして、番号のマスを含めて島を囲む</li>
          <li>ブロック名(例: 3組、東ア)と、各辺の番号を入れる。上辺・下辺は左から、左辺・右辺は上から順に(「23-26」「22-15」「14,13,36,35」など)</li>
          <li>同じ形の島は「複製」して動かし、ブロック名だけ変えると速い</li>
        </ol>
        <p class="note small">壁沿いの1列などは、番号のある辺だけ入れてください。手で置いたピンは、自動の位置より優先されます。</p>
      </div>`);
    return;
  }
  setHtml(panel, `
    <div class="isl-panel">
      <div class="field-row">
        <label class="field">ブロック名<input data-isl-field="block" value="${esc(isl.block)}" placeholder="3組 / 東ア" autocomplete="off"></label>
      </div>
      <div class="isl-sides">
        ${SIDES.map(
          (s) => `
          <label class="field">${SIDE_LABEL[s]}
            <input data-isl-field="${s}" value="${esc(isl[s])}" placeholder="例: ${s === 'top' ? '23-26' : s === 'right' ? '27-34' : s === 'bottom' ? '14,13,36,35' : '22-15'}" inputmode="text" autocomplete="off">
          </label>`,
        ).join('')}
      </div>
      <p class="note small isl-note">${islandNote(isl)}</p>
      <div class="actions">
        <button type="button" class="btn small danger" data-mact="isl-del">削除</button>
        <span class="spacer"></span>
        <button type="button" class="btn small" data-mact="isl-dup">複製</button>
        <button type="button" class="btn small" data-mact="isl-unsel">選択を外す</button>
      </div>
    </div>`);
}

// ---------------------------------------------------------------- 拡大・移動

function fitScale(): number {
  const w = wrap.clientWidth || 1;
  const h = wrap.clientHeight || 1;
  return Math.min(w / imgW, h / imgH);
}

function fit(): void {
  if (!imgW) return;
  const s = fitScale();
  vp = { s, tx: (wrap.clientWidth - imgW * s) / 2, ty: (wrap.clientHeight - imgH * s) / 2, fitted: true };
}

function clampViewport(): void {
  const fs = fitScale();
  vp.s = Math.min(Math.max(vp.s, fs * 0.5), Math.max(3, fs * 2));
  // 画像が画面の外へ行き過ぎないように(端が最低 60px は見える)
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  const m = 60;
  vp.tx = Math.min(Math.max(vp.tx, m - imgW * vp.s), w - m);
  vp.ty = Math.min(Math.max(vp.ty, m - imgH * vp.s), h - m);
}

function apply(): void {
  if (!imgW) return;
  clampViewport();
  layer.style.transform = `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.s})`;
  routeSvg.setAttribute('transform', `matrix(${vp.s} 0 0 ${vp.s} ${vp.tx} ${vp.ty})`);
  routeSvg.querySelector('.leg-start')?.setAttribute('r', String(7 / vp.s)); // 印の大きさは画面上で一定
  positionIslands();
  positionPins();
}

function zoomAt(px: number, py: number, k: number): void {
  const before = vp.s;
  vp.s = before * k;
  clampViewport();
  const real = vp.s / before;
  vp.tx = px - (px - vp.tx) * real;
  vp.ty = py - (py - vp.ty) * real;
  vp.fitted = false;
  apply();
}

/** そのサークルのピンが画面の中央に来るように動かす(小さく見えているときは少し拡大する) */
function focusCircle(id: string): void {
  const c = state.circles.find((x) => x.id === id);
  const p = c && posOf(c);
  if (!p) return;
  const s = Math.max(vp.s, fitScale() * 2.5);
  vp = { s, tx: wrap.clientWidth / 2 - p.x * imgW * s, ty: wrap.clientHeight / 2 - p.y * imgH * s, fitted: false };
  apply();
}

/** 画面上の点 → 会場図上の割合(0〜1) */
function toImage(px: number, py: number): { x: number; y: number } {
  return { x: (px - vp.tx) / (imgW * vp.s), y: (py - vp.ty) / (imgH * vp.s) };
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

// ---------------------------------------------------------------- 指・マウスの操作

type Gesture = {
  kind: 'pan' | 'pinch' | 'pin' | 'isl-move' | 'isl-resize' | 'isl-draw';
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
  pinId?: string;
  islId?: string;
  handle?: string;
  orig?: IslandRec; // 島を動かし始めたときの形
  dist?: number;
};

function setupGestures(): void {
  const pts = new Map<number, { x: number; y: number }>();
  let g: Gesture | null = null;
  let pending: { x: number; y: number } | null = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let drawEl: HTMLElement | null = null;

  const local = (e: PointerEvent | WheelEvent): { x: number; y: number } => {
    const r = wrap.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const twoPoints = (): { mx: number; my: number; dist: number } => {
    const [a, b] = [...pts.values()];
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };

  wrap.addEventListener('pointerdown', (e) => {
    if (!imgW || (e.target as HTMLElement).closest('.map-ctl, .map-empty')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくても操作は続ける */
    }
    if (pts.size === 1) {
      const t = e.target as HTMLElement;
      const base = { sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false };
      pending = null;
      if (mode === 'island') {
        const handle = t.closest<HTMLElement>('[data-handle]')?.dataset.handle;
        const islId = t.closest<HTMLElement>('[data-isl]')?.dataset.isl;
        const orig = dayIslands().find((x) => x.id === islId);
        if (drawArmed) g = { ...base, kind: 'isl-draw' };
        else if (handle && orig) g = { ...base, kind: 'isl-resize', islId, handle, orig: { ...orig } };
        else if (orig) g = { ...base, kind: 'isl-move', islId, orig: { ...orig } };
        else g = { ...base, kind: 'pan' };
        return;
      }
      const pinId = t.closest<HTMLElement>('[data-pin]')?.dataset.pin;
      const movable = pinId && mode === 'place' && !fixedByGrid(state.circles.find((c) => c.id === pinId));
      g = { ...base, kind: movable ? 'pin' : 'pan', pinId };
    } else if (pts.size === 2 && g) {
      // 2本目の指: 島を描いている途中ならやめて、拡大縮小に切り替える
      drawEl?.remove();
      drawEl = null;
      const t = twoPoints();
      g = { ...g, kind: 'pinch', moved: true, lx: t.mx, ly: t.my, dist: t.dist };
    }
  });

  wrap.addEventListener('pointermove', (e) => {
    if (!g || !pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (g.kind === 'pinch' && pts.size >= 2) {
      const t = twoPoints();
      zoomAt(t.mx, t.my, t.dist / (g.dist ?? t.dist));
      vp.tx += t.mx - g.lx;
      vp.ty += t.my - g.ly;
      apply();
      g.lx = t.mx;
      g.ly = t.my;
      g.dist = t.dist;
      return;
    }
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 6) return;
    g.moved = true;
    if (g.kind === 'pin' && g.pinId) {
      // ピンをドラッグ中: 見た目だけ動かし、指を離したときに保存
      pending = toImage(p.x, p.y);
      const el = pinLayer.querySelector<HTMLElement>(`[data-pin="${CSS.escape(g.pinId)}"]`);
      if (el) el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
    } else if ((g.kind === 'isl-move' || g.kind === 'isl-resize') && g.orig) {
      const a = toImage(g.sx, g.sy);
      const b = toImage(p.x, p.y);
      updateIslandShape(g.orig, g.kind === 'isl-move' ? 'move' : g.handle!, b.x - a.x, b.y - a.y);
    } else if (g.kind === 'isl-draw') {
      if (!drawEl) {
        drawEl = document.createElement('div');
        drawEl.className = 'isl drawing';
        islLayer.appendChild(drawEl);
      }
      Object.assign(drawEl.style, {
        left: `${Math.min(g.sx, p.x)}px`,
        top: `${Math.min(g.sy, p.y)}px`,
        width: `${Math.abs(p.x - g.sx)}px`,
        height: `${Math.abs(p.y - g.sy)}px`,
      });
    } else {
      vp.tx += p.x - g.lx;
      vp.ty += p.y - g.ly;
      vp.fitted = false;
      apply();
    }
    g.lx = p.x;
    g.ly = p.y;
  });

  const end = (e: PointerEvent): void => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') {
      // 指が1本残ったら、そのまま移動に切り替える
      if (pts.size === 1) {
        const [rest] = [...pts.values()];
        g = { kind: 'pan', sx: rest.x, sy: rest.y, lx: rest.x, ly: rest.y, moved: true };
      } else if (pts.size === 0) g = null;
      return;
    }
    if (pts.size > 0) return;
    const done = g;
    g = null;
    if (e.type === 'pointercancel') {
      drawEl?.remove();
      drawEl = null;
      return;
    }
    if (done.kind === 'isl-draw') {
      drawEl?.remove();
      drawEl = null;
      if (Math.abs(p.x - done.sx) >= 8 && Math.abs(p.y - done.sy) >= 8) void createIsland(done.sx, done.sy, p.x, p.y);
      else toast('もう少し大きく囲んでください');
      return;
    }
    if ((done.kind === 'isl-move' || done.kind === 'isl-resize') && done.islId) {
      const isl = dayIslands().find((x) => x.id === done.islId);
      if (done.moved && isl) void saveIsland(isl);
      if (!done.moved) {
        selIsland = done.islId;
        renderAll();
      } else if (selIsland !== done.islId) {
        selIsland = done.islId;
        renderAll();
      }
      return;
    }
    if (done.kind === 'pin' && done.moved && done.pinId && pending) {
      const id = done.pinId;
      target = id;
      void setCirclePos(id, pending, multi() ? gridRec?.id : undefined);
      return;
    }
    if (done.moved) return;
    // ---- タップ ----
    const pinId = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-pin]')
      ?.dataset.pin;
    onTap(p.x, p.y, pinId ?? done.pinId, lastTap);
    lastTap = { t: Date.now(), x: p.x, y: p.y };
  };
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);

  wrap.addEventListener(
    'wheel',
    (e) => {
      if (!imgW) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
}

function onTap(x: number, y: number, pinId: string | undefined, last: { t: number; x: number; y: number }): void {
  if (mode === 'island') {
    // 何もないところをタップ: 選択を外す
    if (selIsland) {
      selIsland = null;
      renderAll();
    }
    return;
  }
  if (mode === 'place') {
    // 置こうとしているサークルにまだピンが無いときは、他のピンの上でもそこに置く
    // (ピンが混み合っていても置けるように)。置き済みなら、タップしたピンに対象を切り替える
    const t = state.circles.find((c) => c.id === target);
    const targetPlaced = !!(t && posOf(t));
    if (pinId && (!target || targetPlaced)) {
      target = pinId;
      renderAll();
      return;
    }
    if (!target) {
      toast('先に下の一覧からサークルを選んでください');
      return;
    }
    if (fixedByGrid(t)) {
      toast(multi() ? `このサークルは「${sheetName(sheetIdOf(t!))}」で位置が決まっています` : 'このサークルは会場データで位置が決まっています');
      return;
    }
    const pos = toImage(x, y);
    if (pos.x < 0 || pos.x > 1 || pos.y < 0 || pos.y > 1) return; // 会場図の外
    const placed = target;
    target = nextUnplaced(placed);
    void setCirclePos(placed, pos, multi() ? gridRec?.id : undefined);
    return;
  }
  if (pinId) {
    selected = selected === pinId ? null : pinId;
    renderAll();
    return;
  }
  // 何もないところのダブルタップで拡大
  if (Date.now() - last.t < 320 && Math.hypot(x - last.x, y - last.y) < 30) {
    zoomAt(x, y, 2);
    return;
  }
  if (selected) {
    selected = null;
    renderAll();
  }
}

/** 「ピンを置く」の一覧: 別のシートにあるサークルは出さない */
function placeList(): CircleRec[] {
  return sortedCircles().filter((c) => !multi() || !sheetIdOf(c) || sheetIdOf(c) === gridRec?.id);
}

/** 配置順で次の、位置がまだ決まっていないサークル */
function nextUnplaced(after: string): string | null {
  const list = placeList();
  const i = list.findIndex((c) => c.id === after);
  const rest = [...list.slice(i + 1), ...list.slice(0, Math.max(0, i))];
  return rest.find((c) => !posOf(c))?.id ?? null;
}

// ---------------------------------------------------------------- 島の編集

/** 島を動かす・大きさを変える(画面の見た目だけ更新。保存は指を離したとき) */
function updateIslandShape(orig: IslandRec, how: string, dx: number, dy: number): void {
  let { x, y, w, h } = orig;
  const min = 0.004;
  if (how === 'move') {
    x = Math.min(Math.max(0, x + dx), 1 - w);
    y = Math.min(Math.max(0, y + dy), 1 - h);
  } else {
    if (how.includes('w')) {
      const nx = Math.min(Math.max(0, x + dx), x + w - min);
      w += x - nx;
      x = nx;
    }
    if (how.includes('e')) w = Math.min(Math.max(min, w + dx), 1 - x);
    if (how.includes('n')) {
      const ny = Math.min(Math.max(0, y + dy), y + h - min);
      h += y - ny;
      y = ny;
    }
    if (how.includes('s')) h = Math.min(Math.max(min, h + dy), 1 - y);
  }
  replaceIsland({ ...orig, x, y, w, h });
  renderIslands();
  renderPins();
}

/** 保存前の島をメモリ上で差し替える(入力中・ドラッグ中の見た目用) */
function replaceIsland(isl: IslandRec): void {
  state.islands = state.islands.map((x) => (x.id === isl.id ? isl : x));
}

async function createIsland(x1: number, y1: number, x2: number, y2: number): Promise<void> {
  const ev = state.eventId;
  if (!ev || !state.dayId) return;
  const a = toImage(Math.min(x1, x2), Math.min(y1, y2));
  const b = toImage(Math.max(x1, x2), Math.max(y1, y2));
  const x = clamp01(a.x);
  const y = clamp01(a.y);
  // 直前に編集していた島のブロック名を引き継ぐ(同じブロックの島を続けて描くことが多いので)
  const prev = dayIslands().find((i) => i.id === selIsland) ?? dayIslands().at(-1);
  const isl: IslandRec = {
    id: uid(),
    eventId: ev,
    dayId: state.dayId,
    block: prev?.block ?? '',
    x,
    y,
    w: Math.max(0.004, clamp01(b.x) - x),
    h: Math.max(0.004, clamp01(b.y) - y),
    top: '',
    right: '',
    bottom: '',
    left: '',
  };
  await saveIsland(isl);
  drawArmed = false;
  selIsland = isl.id;
  renderAll();
  panel.querySelector<HTMLInputElement>(isl.block ? '[data-isl-field=top]' : '[data-isl-field=block]')?.focus({ preventScroll: true });
}

function onInput(e: Event): void {
  const el = e.target as HTMLInputElement;
  const field = el.dataset.islField as keyof IslandRec | undefined;
  if (!field || !selIsland) return;
  const isl = dayIslands().find((x) => x.id === selIsland);
  if (!isl) return;
  // 入力中は見た目だけ更新(パネルは作り直さないので、入力欄のフォーカスはそのまま)
  replaceIsland({ ...isl, [field]: el.value });
  renderIslands();
  renderPins();
}

// ---------------------------------------------------------------- ボタン

function onClick(e: Event): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-mact]');
  if (!el || el.tagName === 'INPUT') return;
  const w = wrap.clientWidth / 2;
  const h = wrap.clientHeight / 2;
  switch (el.dataset.mact) {
    case 'zoom-in':
      zoomAt(w, h, 1.6);
      break;
    case 'zoom-out':
      zoomAt(w, h, 1 / 1.6);
      break;
    case 'fit':
      fit();
      apply();
      break;
    case 'place-start':
      mode = 'place';
      selected = null;
      target = placeList().find((c) => !posOf(c))?.id ?? placeList()[0]?.id ?? null;
      renderAll();
      break;
    case 'place-done':
      mode = 'view';
      target = null;
      renderAll();
      break;
    case 'target':
      target = el.dataset.id ?? null;
      renderAll();
      break;
    case 'unpin':
      if (target) void setCirclePos(target, null);
      break;
    case 'close-card':
      selected = null;
      renderAll();
      break;
    case 'map-menu':
      openMapMenu();
      break;
    case 'grid-use':
      void openGridPicker();
      break;
    case 'sheet':
      if (el.dataset.id) switchSheet(el.dataset.id);
      break;
    // ---- 動線 ----
    case 'route-plan':
      openRoutePlanDialog(routeMap(), () => planInput(routeMap()), routeOpts());
      break;
    case 'route-edit':
      openRouteEditDialog(state.circles.filter(onThisSheet), (c) => (posOf(c) ? '' : '地図に位置なし'), routeOpts());
      break;
    case 'route-next':
      if (routeData?.rr.next) {
        selected = routeData.rr.next;
        renderAll();
        focusCircle(selected);
      }
      break;
    case 'route-here':
      if (selected) {
        const id = selected;
        void computeRoute(planInput(routeMap()), { kind: 'circle', id }, routeMeta()?.mustFirst ?? true, routeOpts());
      }
      break;
    // ---- 島 ----
    case 'isl-add':
      drawArmed = true;
      selIsland = null;
      renderAll();
      break;
    case 'isl-cancel':
      drawArmed = false;
      renderAll();
      break;
    case 'isl-done':
      mode = 'view';
      drawArmed = false;
      selIsland = null;
      renderAll();
      break;
    case 'isl-unsel':
      selIsland = null;
      renderAll();
      break;
    case 'isl-dup':
      void duplicateIsland();
      break;
    case 'isl-del': {
      const isl = dayIslands().find((x) => x.id === selIsland);
      if (isl && confirm(`島「${isl.block || '(ブロック名なし)'}」を削除しますか?`)) {
        void deleteIsland(isl.id).then(() => {
          selIsland = null;
          renderAll();
        });
      }
      break;
    }
  }
}

/** 選択中の島を複製して、右隣に置く(同じ形の島を続けて作るとき用) */
async function duplicateIsland(): Promise<void> {
  const isl = dayIslands().find((x) => x.id === selIsland);
  if (!isl) return;
  const gap = isl.w * 0.6;
  const fitsRight = isl.x + isl.w * 2 + gap <= 1;
  const copy: IslandRec = {
    ...isl,
    id: uid(),
    x: fitsRight ? isl.x + isl.w + gap : Math.max(0, isl.x - isl.w - gap),
  };
  await saveIsland(copy);
  selIsland = copy.id;
  renderAll();
  toast('複製しました。ドラッグで位置を合わせ、ブロック名を変えてください');
  panel.querySelector<HTMLInputElement>('[data-isl-field=block]')?.select();
}

function onChange(e: Event): void {
  const el = e.target as HTMLInputElement;
  if (el.dataset.mact === 'filter') setFilter(el.checked ? 'todo' : 'all');
  if (el.dataset.mact === 'route') {
    setRouteOn(el.checked);
    renderAll();
  }
  if (el.dataset.mact === 'file') void loadFile(el);
  if (el.dataset.islField && selIsland) {
    // 入力を確定したら保存(パネルは作り直さない)
    const isl = dayIslands().find((x) => x.id === selIsland);
    if (isl) {
      void saveIsland(isl);
      const note = panel.querySelector<HTMLElement>('.isl-note');
      if (note) note.innerHTML = islandNote(isl);
    }
  }
}

async function loadFile(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  input.value = '';
  if (!file || !state.dayId) return;
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    toast('PDFは読み込めません。画像(PNG・JPEG)にしてから選んでください');
    return;
  }
  try {
    const resized = await saveMap(state.dayId, file);
    viewports.delete(state.dayId);
    closeDialog();
    toast(resized ? '会場図を保存しました(大きい画像だったため縮小しました)' : '会場図を保存しました');
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  }
}

function openMapMenu(): void {
  const n = dayIslands().length;
  const grid = gridRec;
  const res = gridRes;
  const sheetList = multi()
    ? `
        <ol class="sheet-list">${sheets
          .map(
            (v, i) => `
          <li class="${v.rec.id === grid?.id ? 'on' : ''}">
            <button type="button" class="sl-name" data-act="s-show" data-id="${esc(v.rec.id)}">${esc(v.rec.name || '(名前なし)')}${
              v.rec.hall ? `<small>${esc(v.rec.hall)}</small>` : ''
            }${v.rec.id === grid?.id ? '<small>表示中</small>' : ''}</button>
            <button type="button" class="btn small" data-act="s-up" data-id="${esc(v.rec.id)}"${i === 0 ? ' disabled' : ''} aria-label="上へ">↑</button>
            <button type="button" class="btn small" data-act="s-down" data-id="${esc(v.rec.id)}"${i === sheets.length - 1 ? ' disabled' : ''} aria-label="下へ">↓</button>
          </li>`,
          )
          .join('')}</ol>`
    : '';
  const gridSec =
    grid && res
      ? `
      <section class="data-sec">
        <h3>会場データ(マス目)${multi() ? `・${sheets.length}枚` : ''}</h3>
        ${sheetList}
        <button type="button" class="btn wide" data-act="g-change">シートを追加・CSVを読み込む</button>
        <p class="note small">ホールごとなど、1日に何枚でも追加できます(マップの上のタブで切り替え)。Excelで直したCSVは、同じシート名で読み込むと中身が置き換わります。</p>
      </section>
      <section class="data-sec">
        <h3>${multi() ? '表示中のシート' : 'この会場データ'}</h3>
        <p class="note"><strong>${esc(grid.name || '(名前なし)')}</strong>${grid.hall ? `・ホール ${esc(grid.hall)}` : ''}・ブロック ${res.blocks.length}個・スペース ${spaceCount(res)}</p>
        ${blocksHtml(res)}
        ${issuesHtml(res)}
        <label class="check-line"><input type="checkbox" data-act="g-color"${gridColorOn() ? ' checked' : ''}>組ごとに色分けする</label>
        <button type="button" class="btn wide" data-act="g-rename">ブロック名を変更</button>
        <button type="button" class="btn wide" data-act="g-export">CSVで書き出す(Excelで編集)</button>
        <button type="button" class="btn danger wide" data-act="g-remove">${multi() ? 'このシートを外す' : 'この日の会場データを外す'}</button>
        <p class="note small">${
          multi()
            ? 'このシートに手で置いたピンは、最初のシートに移ります。'
            : hasImage
              ? '外すと、会場図の画像の表示に戻ります。'
              : '外しても、手で置いたピンはそのまま残ります。'
        }</p>
      </section>`
      : `
      <section class="data-sec">
        <h3>会場データ(マス目)</h3>
        <button type="button" class="btn primary wide" data-act="g-use">会場データ(マス目)を使う</button>
        <p class="note small">配置番号からピンの位置が自動で決まります。使っている間は、画像の代わりにマス目を表示します。ホールごとに何枚も持てます。</p>
      </section>`;
  const imageSec = grid
    ? ''
    : `
      <section class="data-sec">
        <h3>会場図の画像</h3>
        ${
          imgW
            ? `<button type="button" class="btn wide" data-act="islands">島を編集する(ピンの自動配置)${n ? `・${n}個` : ''}</button>
        <p class="note small" style="margin-bottom:12px">島を囲んで番号を入れておくと、サークルの配置番号からピンが自動で置かれます。</p>`
            : ''
        }
        <label class="btn wide file-btn">${imgW ? '画像を差し替える' : '画像を選ぶ'}
          <input type="file" accept="image/*" data-mact="file" hidden>
        </label>
        ${imgW ? '<p class="note small">差し替えても、ピンや島は画像に対する割合で保存しているので、同じ配置図なら位置はほぼそのまま使えます。</p>' : ''}
        ${imgW ? '<button type="button" class="btn danger wide" data-act="delete">会場図の画像を削除</button>' : ''}
      </section>`;
  openDialog(
    `
    <div class="sheet">
      <h2>会場図</h2>
      ${gridSec}
      ${imageSec}
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close">閉じる</button>
      </div>
    </div>`,
    (dlg) => {
      dlg.querySelector('[data-mact=file]')?.addEventListener('change', (e) => void loadFile(e.target as HTMLInputElement));
      dlg.querySelector('[data-act=g-color]')?.addEventListener('change', (e) => {
        setGridColor((e.target as HTMLInputElement).checked);
        void loadMapIfNeeded();
      });
      dlg.querySelector('.sheet')!.addEventListener('click', async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeDialog();
        if (act === 'islands') {
          closeDialog();
          mode = 'island';
          selected = null;
          target = null;
          renderAll();
        }
        if (act === 'delete' && state.dayId && confirm('この日の会場図の画像を削除しますか?(ピンと島の位置は残ります)')) {
          await deleteMap(state.dayId);
          closeDialog();
        }
        if (act === 'g-use' || act === 'g-change') void openGridPicker();
        if (act === 'g-rename' && grid) void openBlockRename(grid);
        if (act === 'g-export' && grid) exportGridCsv(grid);
        if (act === 'g-remove' && grid && confirm(multi() ? `シート「${grid.name || '(名前なし)'}」を外しますか?` : 'この日の会場データを外しますか?')) {
          await deleteGrid(grid.id);
          closeDialog();
        }
        const sid = (e.target as HTMLElement).closest<HTMLElement>('[data-id]')?.dataset.id;
        if (act === 's-show' && sid) {
          closeDialog();
          switchSheet(sid);
        }
        if ((act === 's-up' || act === 's-down') && sid && state.dayId) {
          const ids = sheets.map((v) => v.rec.id);
          const i = ids.indexOf(sid);
          const j = act === 's-up' ? i - 1 : i + 1;
          if (i < 0 || j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          await reorderGrids(state.dayId, ids);
          await loadMapIfNeeded();
          closeDialog();
          openMapMenu();
        }
      });
    },
  );
}
