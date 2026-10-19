// 画面の状態と、データを変更する操作をまとめる。
// 変更のたびに IndexedDB へ即保存し、購読している画面を再描画する。

import { makeBackup, remapIds } from './backup.js';
import type { Backup, BackupMap } from './backup.js';
import { getAll, getOne, write } from './db.js';
import { blobToDataUrl, dataUrlToBlob, prepareMapImage } from './imageTools.js';
import type { CatalogInfo, CatalogRec, CircleRec, DayRec, EventRec, GridRec, IslandRec, RouteMeta, ItemRec, ItemStatus, MapRec } from './types.js';
import { uid } from './util.js';
import type { VenueGrid } from './venueGrid.js';

export type Filter = 'all' | 'todo';
export type Sort = 'space' | 'priority' | 'route';
export type View = 'list' | 'map';

export interface State {
  ready: boolean;
  events: EventRec[];
  days: DayRec[]; // 選択中イベントの開催日
  circles: CircleRec[]; // 選択中の日のサークル
  eventItems: ItemRec[]; // 選択中イベントの全日程の頒布物(予算計算用)
  catalog: CatalogRec[]; // 選択中イベントのカタログ(全サークル一覧)
  islands: IslandRec[]; // 選択中イベントの島(会場図の上の長方形と番号)
  eventId: string | null;
  dayId: string | null;
  filter: Filter;
  sort: Sort;
  view: View;
}

export const state: State = {
  ready: false,
  events: [],
  days: [],
  circles: [],
  eventItems: [],
  catalog: [],
  islands: [],
  eventId: null,
  dayId: null,
  filter: 'all',
  sort: 'space',
  view: 'list',
};

type Listener = () => void;
const listeners = new Set<Listener>();
export const subscribe = (fn: Listener): void => void listeners.add(fn);
const emit = (): void => listeners.forEach((fn) => fn());

// ---- 前回の選択を覚えておく(端末ごとの小さな設定なので localStorage) ----
const PREFS_KEY = 'doujin-shopping:prefs';
function loadPrefs(): Partial<Pick<State, 'eventId' | 'dayId' | 'filter' | 'sort' | 'view'>> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function savePrefs(): void {
  try {
    const { eventId, dayId, filter, sort, view } = state;
    localStorage.setItem(PREFS_KEY, JSON.stringify({ eventId, dayId, filter, sort, view }));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

// ---- 頒布物リストの折りたたみ(端末ごとの表示設定なので localStorage) ----
const FOLD_KEY = 'doujin-shopping:collapsed';
const collapsed: Set<string> = (() => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]'));
  } catch {
    return new Set<string>();
  }
})();
function saveFold(): void {
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* 保存できなくても動作は続ける */
  }
}

export const isCollapsed = (circleId: string): boolean => collapsed.has(circleId);

export function toggleFold(circleId: string): void {
  if (collapsed.has(circleId)) collapsed.delete(circleId);
  else collapsed.add(circleId);
  saveFold();
  emit();
}

/** 指定したサークルをまとめて開く/閉じる */
export function setFold(circleIds: string[], fold: boolean): void {
  for (const id of circleIds) {
    if (fold) collapsed.add(id);
    else collapsed.delete(id);
  }
  saveFold();
  emit();
}

// ---- 読み込み ----
export async function init(): Promise<void> {
  const prefs = loadPrefs();
  state.filter = prefs.filter ?? 'all';
  state.sort = prefs.sort ?? 'space';
  state.view = prefs.view === 'map' ? 'map' : 'list';
  state.events = (await getAll<EventRec>('events')).sort((a, b) => b.createdAt - a.createdAt);
  const eventId = state.events.some((e) => e.id === prefs.eventId) ? prefs.eventId! : state.events[0]?.id ?? null;
  await loadEvent(eventId, prefs.dayId ?? null);
  state.ready = true;
  emit();
}

async function loadEvent(eventId: string | null, preferDayId: string | null): Promise<void> {
  state.eventId = eventId;
  state.days = eventId ? (await getAll<DayRec>('days', 'eventId', eventId)).sort((a, b) => a.order - b.order) : [];
  const itemsByDay = await Promise.all(state.days.map((d) => getAll<ItemRec>('items', 'dayId', d.id)));
  state.eventItems = itemsByDay.flat();
  state.catalog = eventId ? await getAll<CatalogRec>('catalog', 'eventId', eventId) : [];
  state.islands = eventId ? await getAll<IslandRec>('islands', 'eventId', eventId) : [];
  const dayId = state.days.some((d) => d.id === preferDayId) ? preferDayId : state.days[0]?.id ?? null;
  await loadDay(dayId);
}

async function loadDay(dayId: string | null): Promise<void> {
  state.dayId = dayId;
  state.circles = dayId ? await getAll<CircleRec>('circles', 'dayId', dayId) : [];
  savePrefs();
}

export const currentEvent = (): EventRec | undefined => state.events.find((e) => e.id === state.eventId);
export const dayItems = (): ItemRec[] => state.eventItems.filter((i) => i.dayId === state.dayId);
export const itemsOf = (circleId: string): ItemRec[] =>
  state.eventItems.filter((i) => i.circleId === circleId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

// ---- 選択・表示 ----
export async function selectEvent(id: string): Promise<void> {
  await loadEvent(id, null);
  emit();
}

export async function selectDay(id: string): Promise<void> {
  await loadDay(id);
  emit();
}

export function setFilter(f: Filter): void {
  state.filter = f;
  savePrefs();
  emit();
}

export function setSort(s: Sort): void {
  state.sort = s;
  savePrefs();
  emit();
}

export function setView(v: View): void {
  state.view = v;
  savePrefs();
  emit();
}

// ---- イベントと開催日 ----
/** イベントと開催日をまとめて保存する。消えた開催日は、そのサークルと頒布物ごと削除。 */
export async function saveEvent(ev: EventRec, days: DayRec[]): Promise<void> {
  const oldDays = await getAll<DayRec>('days', 'eventId', ev.id);
  const keep = new Set(days.map((d) => d.id));
  const removed = oldDays.filter((d) => !keep.has(d.id));
  const del = await cascadeForDays(removed);
  const removedIds = new Set(removed.map((d) => d.id));
  const catalogDel = (await getAll<CatalogRec>('catalog', 'eventId', ev.id)).filter((c) => removedIds.has(c.dayId));
  const islandDel = (await getAll<IslandRec>('islands', 'eventId', ev.id)).filter((x) => removedIds.has(x.dayId));
  const sheetDel = (await getAll<GridRec>('sheets', 'eventId', ev.id)).filter((x) => removedIds.has(x.dayId));
  await write({
    put: { events: [ev], days },
    del: {
      days: removed.map((d) => d.id),
      ...del,
      catalog: catalogDel.map((c) => c.id),
      maps: removed.map((d) => d.id),
      sheets: sheetDel.map((x) => x.id),
      islands: islandDel.map((x) => x.id),
    },
  });
  state.events = [ev, ...state.events.filter((e) => e.id !== ev.id)].sort((a, b) => b.createdAt - a.createdAt);
  await loadEvent(ev.id, state.eventId === ev.id ? state.dayId : null);
  emit();
}

export async function deleteEvent(id: string): Promise<void> {
  const days = await getAll<DayRec>('days', 'eventId', id);
  const del = await cascadeForDays(days);
  const catalog = await getAll<CatalogRec>('catalog', 'eventId', id);
  const islands = await getAll<IslandRec>('islands', 'eventId', id);
  const sheets = await getAll<GridRec>('sheets', 'eventId', id);
  await write({
    del: {
      events: [id],
      days: days.map((d) => d.id),
      ...del,
      catalog: catalog.map((c) => c.id),
      maps: days.map((d) => d.id),
      sheets: sheets.map((x) => x.id),
      islands: islands.map((x) => x.id),
    },
  });
  state.events = state.events.filter((e) => e.id !== id);
  if (state.eventId === id) await loadEvent(state.events[0]?.id ?? null, null);
  emit();
}

async function cascadeForDays(days: DayRec[]): Promise<{ circles: string[]; items: string[] }> {
  const circles = (await Promise.all(days.map((d) => getAll<CircleRec>('circles', 'dayId', d.id)))).flat();
  const items = (await Promise.all(days.map((d) => getAll<ItemRec>('items', 'dayId', d.id)))).flat();
  return { circles: circles.map((c) => c.id), items: items.map((i) => i.id) };
}

// ---- 書き出し・読み込み ----
async function collect(eventIds: string[], withMaps = false): Promise<Backup> {
  const ids = new Set(eventIds);
  const events = (await getAll<EventRec>('events')).filter((e) => ids.has(e.id));
  const days = (await Promise.all(events.map((e) => getAll<DayRec>('days', 'eventId', e.id)))).flat();
  const circles = (await Promise.all(days.map((d) => getAll<CircleRec>('circles', 'dayId', d.id)))).flat();
  const items = (await Promise.all(days.map((d) => getAll<ItemRec>('items', 'dayId', d.id)))).flat();
  const catalog = (await Promise.all(events.map((e) => getAll<CatalogRec>('catalog', 'eventId', e.id)))).flat();
  const backup = makeBackup(events, days, circles, items, catalog);
  backup.islands = (await Promise.all(events.map((e) => getAll<IslandRec>('islands', 'eventId', e.id)))).flat();
  backup.grids = (await Promise.all(events.map((e) => getAll<GridRec>('sheets', 'eventId', e.id)))).flat();
  if (withMaps) {
    const maps = (await Promise.all(events.map((e) => getAll<MapRec>('maps', 'eventId', e.id)))).flat();
    backup.maps = await Promise.all(
      maps.map(async (m): Promise<BackupMap> => ({
        dayId: m.dayId,
        eventId: m.eventId,
        name: m.name,
        width: m.width,
        height: m.height,
        dataUrl: await blobToDataUrl(m.blob),
      })),
    );
  }
  return backup;
}

/** 指定したイベント(省略時は全イベント)を書き出し用にまとめる。会場図の画像は任意で同梱 */
export async function exportData(eventIds?: string[], withMaps = false): Promise<Backup> {
  return collect(eventIds ?? state.events.map((e) => e.id), withMaps);
}

/** 書き出し対象に会場図があるか(同梱の選択肢を出すかどうか) */
export async function hasMaps(eventIds: string[]): Promise<boolean> {
  for (const id of eventIds) if ((await getAll<MapRec>('maps', 'eventId', id)).length) return true;
  return false;
}

export type ImportMode = 'replace' | 'copy';

/**
 * 読み込んだデータを保存する。
 * replace: 同じイベントがあれば、その全日程を消してファイルの内容に置き換える(PC→スマホ反映)
 * copy:    IDを振り直し、別のイベントとして追加する
 */
export async function importData(b: Backup, mode: ImportMode): Promise<void> {
  const data = mode === 'copy' ? remapIds(b, uid) : b;
  const existing = await collect(data.events.map((e) => e.id));
  const maps: MapRec[] = data.maps
    ? await Promise.all(
        data.maps.map(async (m) => ({
          dayId: m.dayId,
          eventId: m.eventId,
          blob: await dataUrlToBlob(m.dataUrl),
          width: m.width,
          height: m.height,
          name: m.name,
          updatedAt: Date.now(),
        })),
      )
    : [];
  const oldIslands = data.islands
    ? (await Promise.all(data.events.map((e) => getAll<IslandRec>('islands', 'eventId', e.id)))).flat().map((x) => x.id)
    : [];
  const oldGrids = data.grids
    ? (await Promise.all(data.events.map((e) => getAll<GridRec>('sheets', 'eventId', e.id)))).flat().map((g) => g.id)
    : [];
  const oldMaps = data.maps
    ? (await Promise.all(data.events.map((e) => getAll<MapRec>('maps', 'eventId', e.id)))).flat().map((m) => m.dayId)
    : [];
  // カタログを含まない古いファイルなら、端末側のカタログはそのまま残す
  const keepCatalog = data.catalog === undefined;
  const events = keepCatalog
    ? data.events.map((e) => {
        const old = existing.events.find((o) => o.id === e.id);
        return old?.catalogInfo ? { ...e, catalogInfo: old.catalogInfo } : e;
      })
    : data.events;
  await write({
    del: {
      events: existing.events.map((e) => e.id),
      days: existing.days.map((d) => d.id),
      circles: existing.circles.map((c) => c.id),
      items: existing.items.map((i) => i.id),
      catalog: keepCatalog ? [] : (existing.catalog ?? []).map((c) => c.id),
      maps: oldMaps,
      sheets: oldGrids,
      islands: oldIslands,
    },
    put: {
      events,
      days: data.days,
      circles: data.circles,
      items: data.items,
      catalog: data.catalog ?? [],
      maps,
      sheets: data.grids ?? [],
      islands: data.islands ?? [],
    },
  });
  state.events = (await getAll<EventRec>('events')).sort((a, b2) => b2.createdAt - a.createdAt);
  // 読み込んだイベントを表示する。今見ているイベントを上書きした場合は同じ日を保つ
  const target = data.events[0].id;
  await loadEvent(target, state.eventId === target ? state.dayId : null);
  emit();
}

// ---- カタログ(全サークル一覧) ----
/**
 * カタログを保存する。指定した開催日の分は、いったん消してから入れ替える
 * (一覧が更新されたら取り込み直す使い方)。
 */
export async function saveCatalog(entries: CatalogRec[], dayIds: string[], source: string): Promise<void> {
  const ev = currentEvent();
  if (!ev) return;
  const target = new Set(dayIds);
  const old = (await getAll<CatalogRec>('catalog', 'eventId', ev.id)).filter((c) => target.has(c.dayId));
  const info: CatalogInfo = { importedAt: Date.now(), source };
  const nextEv: EventRec = { ...ev, catalogInfo: info };
  await write({ del: { catalog: old.map((c) => c.id) }, put: { catalog: entries, events: [nextEv] } });
  state.events = state.events.map((e) => (e.id === ev.id ? nextEv : e));
  state.catalog = [...state.catalog.filter((c) => !target.has(c.dayId)), ...entries];
  emit();
}

export async function clearCatalog(): Promise<void> {
  const ev = currentEvent();
  if (!ev) return;
  const nextEv: EventRec = { ...ev };
  delete nextEv.catalogInfo;
  await write({ del: { catalog: state.catalog.map((c) => c.id) }, put: { events: [nextEv] } });
  state.events = state.events.map((e) => (e.id === ev.id ? nextEv : e));
  state.catalog = [];
  emit();
}

// ---- 会場図とピン ----
export async function getMap(dayId: string): Promise<MapRec | undefined> {
  return getOne<MapRec>('maps', dayId);
}

/** 会場図を登録・差し替える。戻り値: 縮小したかどうか */
export async function saveMap(dayId: string, file: File): Promise<boolean> {
  const ev = currentEvent();
  if (!ev) return false;
  const img = await prepareMapImage(file);
  const rec: MapRec = {
    dayId,
    eventId: ev.id,
    blob: img.blob,
    width: img.width,
    height: img.height,
    name: file.name,
    updatedAt: Date.now(),
  };
  await write({ put: { maps: [rec] } });
  emit();
  return img.resized;
}

export async function deleteMap(dayId: string): Promise<void> {
  await write({ del: { maps: [dayId] } });
  emit();
}

// ---- 会場データ(マス目)。1日に何枚も持てる(シート) ----
/** その日のシート(並び順) */
export async function getGrids(dayId: string): Promise<GridRec[]> {
  return (await getAll<GridRec>('sheets', 'dayId', dayId)).sort((a, b) => a.order - b.order || a.updatedAt - b.updatedAt);
}

/** 端末にある会場データ全部(他の日・他のイベントから使い回すとき用) */
export async function allGrids(): Promise<GridRec[]> {
  return (await getAll<GridRec>('sheets')).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 会場データを開催日に設定する(複数の日・複数のシートをまとめて設定できる)。
 * その日に同じ名前のシートがあれば中身を置き換え、無ければ最後に足す。
 * 戻り値: 今の日に設定したシートの id(設定した順)
 */
export async function saveGrids(dayIds: string[], grids: VenueGrid[]): Promise<string[]> {
  const ev = currentEvent();
  if (!ev || dayIds.length === 0 || grids.length === 0) return [];
  const now = Date.now();
  const recs: GridRec[] = [];
  const shown: string[] = [];
  for (const dayId of dayIds) {
    const have = await getGrids(dayId);
    let order = Math.max(-1, ...have.map((g) => g.order));
    for (const grid of grids) {
      const same = have.find((g) => g.name === grid.name);
      const rec: GridRec = {
        id: same?.id ?? uid(),
        dayId,
        eventId: ev.id,
        name: grid.name,
        tokens: grid.tokens,
        order: same?.order ?? ++order,
        updatedAt: now,
      };
      if (grid.hall) rec.hall = grid.hall;
      recs.push(rec);
      if (dayId === state.dayId) shown.push(rec.id);
    }
  }
  await write({ put: { sheets: recs } });
  if (shown.length) setSheetPref(state.dayId!, shown[0]);
  emit();
  return shown;
}

/** シートの中身を書き換える(ブロック名の変更など。id・並びはそのまま) */
export async function updateGrids(recs: GridRec[], grid: VenueGrid): Promise<void> {
  const now = Date.now();
  const next = recs.map((r): GridRec => {
    const rec: GridRec = { ...r, name: grid.name, tokens: grid.tokens, updatedAt: now };
    if (grid.hall) rec.hall = grid.hall;
    else delete rec.hall;
    return rec;
  });
  await write({ put: { sheets: next } });
  emit();
}

export async function deleteGrid(id: string): Promise<void> {
  await write({ del: { sheets: [id] } });
  emit();
}

/** シートの並びを変える(ids の順にする) */
export async function reorderGrids(dayId: string, ids: string[]): Promise<void> {
  const have = await getGrids(dayId);
  const recs = have.map((g) => ({ ...g, order: ids.indexOf(g.id) < 0 ? ids.length + g.order : ids.indexOf(g.id) }));
  await write({ put: { sheets: recs } });
  emit();
}

// 日ごとに、マップで見ているシート(端末ごとの表示設定)
const SHEET_KEY = 'doujin-shopping:sheet';
const sheetPrefs: Record<string, string> = (() => {
  try {
    return JSON.parse(localStorage.getItem(SHEET_KEY) ?? '{}');
  } catch {
    return {};
  }
})();
export const sheetPref = (dayId: string): string | undefined => sheetPrefs[dayId];
export function setSheetPref(dayId: string, id: string): void {
  sheetPrefs[dayId] = id;
  try {
    localStorage.setItem(SHEET_KEY, JSON.stringify(sheetPrefs));
  } catch {
    /* 保存できなくても今回の表示は切り替える */
  }
  emit();
}

/** ピンの位置(会場図に対する割合 0〜1)。null でピンを外す。sheet: 置いたシート(会場データが何枚もある日) */
export async function setCirclePos(circleId: string, pos: { x: number; y: number } | null, sheet?: string): Promise<void> {
  const c = state.circles.find((x) => x.id === circleId);
  if (!c) return;
  const next: CircleRec = { ...c };
  if (pos) {
    next.x = Math.min(1, Math.max(0, pos.x));
    next.y = Math.min(1, Math.max(0, pos.y));
    if (sheet) next.sheet = sheet;
    else delete next.sheet;
  } else {
    delete next.x;
    delete next.y;
    delete next.sheet;
  }
  state.circles = state.circles.map((x) => (x.id === circleId ? next : x));
  emit();
  await write({ put: { circles: [next] } });
}

// ---- 島(L1) ----
// 島の編集中は入力欄のフォーカスを保つため、画面全体の描き直し(emit)はしない。
// マップ画面が自分で描き直す。

export async function saveIsland(isl: IslandRec): Promise<void> {
  state.islands = [...state.islands.filter((x) => x.id !== isl.id), isl];
  await write({ put: { islands: [isl] } });
}

export async function deleteIsland(id: string): Promise<void> {
  state.islands = state.islands.filter((x) => x.id !== id);
  await write({ del: { islands: [id] } });
}

// ---- 動線 ----
/**
 * 回る順番を保存する。ids の順に order を 1, 2, 3… と振り直す(ids に無いサークルは後ろに今の順のまま)。
 * meta を渡すと、その日の動線の設定(スタート地点など)も保存する
 */
export async function saveRouteOrder(ids: string[], meta?: RouteMeta): Promise<void> {
  const dayId = state.dayId;
  if (!dayId) return;
  const rank = new Map(ids.map((id, i) => [id, i]));
  const sorted = [...state.circles].sort((a, b) => {
    const ra = rank.get(a.id) ?? Infinity;
    const rb = rank.get(b.id) ?? Infinity;
    return ra !== rb ? ra - rb : a.order - b.order;
  });
  const next = sorted.map((c, i) => ({ ...c, order: i + 1 }));
  const changed = next.filter((c) => state.circles.find((x) => x.id === c.id)?.order !== c.order);
  const day = state.days.find((d) => d.id === dayId);
  const nextDay = day && meta ? { ...day, route: meta } : null;
  await write({ put: { circles: changed, ...(nextDay ? { days: [nextDay] } : {}) } });
  state.circles = next;
  if (nextDay) state.days = state.days.map((d) => (d.id === dayId ? nextDay : d));
  emit();
}

// ---- 一括登録 ----
/** 選択中イベントの全日程のサークル(重複チェック用) */
export async function circlesOfEvent(): Promise<CircleRec[]> {
  return (await Promise.all(state.days.map((d) => getAll<CircleRec>('circles', 'dayId', d.id)))).flat();
}

export async function addCircles(circles: CircleRec[]): Promise<void> {
  if (circles.length === 0) return;
  await write({ put: { circles } });
  state.circles = [...state.circles, ...circles.filter((c) => c.dayId === state.dayId)];
  emit();
}

// ---- サークルと頒布物 ----
/** サークルと、その頒布物一覧を保存する。一覧から消えた頒布物は削除。 */
export async function saveCircle(circle: CircleRec, items: ItemRec[]): Promise<void> {
  const keep = new Set(items.map((i) => i.id));
  const removed = itemsOf(circle.id).filter((i) => !keep.has(i.id));
  await write({
    put: { circles: [circle], items },
    del: { items: removed.map((i) => i.id) },
  });
  state.circles = [...state.circles.filter((c) => c.id !== circle.id), circle];
  state.eventItems = [...state.eventItems.filter((i) => i.circleId !== circle.id), ...items];
  emit();
}

export async function deleteCircle(id: string): Promise<void> {
  const items = itemsOf(id);
  await write({ del: { circles: [id], items: items.map((i) => i.id) } });
  if (collapsed.delete(id)) saveFold();
  state.circles = state.circles.filter((c) => c.id !== id);
  state.eventItems = state.eventItems.filter((i) => i.circleId !== id);
  emit();
}

/**
 * サークルの頒布物をまとめてチェック/解除する。
 * チェック: 未購入 → 購入済み。解除: 購入済み → 未購入。売り切れ・見送りはそのまま。
 */
export async function setCircleBought(circleId: string, bought: boolean): Promise<void> {
  const from: ItemStatus = bought ? 'todo' : 'bought';
  const to: ItemStatus = bought ? 'bought' : 'todo';
  const changed = itemsOf(circleId)
    .filter((i) => i.status === from)
    .map((i) => ({ ...i, status: to }));
  if (changed.length === 0) return;
  const byId = new Map(changed.map((i) => [i.id, i]));
  state.eventItems = state.eventItems.map((i) => byId.get(i.id) ?? i);
  emit();
  await write({ put: { items: changed } });
}

export async function setItemStatus(id: string, status: ItemStatus): Promise<void> {
  const item = state.eventItems.find((i) => i.id === id);
  if (!item || item.status === status) return;
  const next = { ...item, status };
  // 当日の操作なので、画面を先に更新してから保存する(体感を速く)
  state.eventItems = state.eventItems.map((i) => (i.id === id ? next : i));
  emit();
  await write({ put: { items: [next] } });
}
