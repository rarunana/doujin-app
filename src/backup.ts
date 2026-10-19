// バックアップ(JSON)の形式と、読み込み時の検証。
// 画面やデータベースに依存しない純粋な処理だけを置く。

import type { CatalogRec, CircleRec, DayRec, EventRec, GridRec, IslandRec, ItemRec, ItemStatus, Priority, Venue } from './types.js';
import { toXHandle } from './util.js';

export const BACKUP_APP = 'doujin-shopping';
export const BACKUP_VERSION = 1;

export interface Backup {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string; // ISO 8601
  events: EventRec[];
  days: DayRec[];
  circles: CircleRec[];
  items: ItemRec[];
  catalog?: CatalogRec[]; // 全サークル一覧。古いファイルには無い
  maps?: BackupMap[]; // 会場図(書き出し時に選んだときだけ)
  islands?: IslandRec[]; // 島。古いファイルには無い
  grids?: GridRec[]; // 会場データ(マス目)のシート。古いファイルには無い(1日1つだった頃のファイルは id・order が無い)
}

export interface BackupMap {
  dayId: string;
  eventId: string;
  name: string;
  width: number;
  height: number;
  dataUrl: string; // data:image/...;base64,...
}

export function makeBackup(
  events: EventRec[],
  days: DayRec[],
  circles: CircleRec[],
  items: ItemRec[],
  catalog: CatalogRec[],
  now = new Date(),
): Backup {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now.toISOString(), events, days, circles, items, catalog };
}

export type ParseResult = { ok: true; data: Backup; dropped: number } | { ok: false; error: string };

/**
 * ファイルの中身を検証して取り込める形に整える。
 * 型が合わない値は既定値に直し、親が見つからないデータ(壊れた参照)は捨てて件数を返す。
 */
export function parseBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return { ok: false, error: 'JSONとして読み込めませんでした。ファイルが壊れていないか確認してください。' };
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP) {
    return { ok: false, error: 'このアプリで書き出したファイルではありません。' };
  }
  const version = num(raw.version, 0);
  if (version > BACKUP_VERSION) {
    return { ok: false, error: '新しい版のアプリで書き出したファイルです。アプリを更新してから読み込んでください。' };
  }

  const events = arr(raw.events).map(toEvent).filter(notNull);
  if (events.length === 0) return { ok: false, error: 'ファイルにイベントが含まれていません。' };

  const rawCount =
    arr(raw.events).length + arr(raw.days).length + arr(raw.circles).length + arr(raw.items).length;

  const eventIds = new Set(events.map((e) => e.id));
  const days = arr(raw.days).map(toDay).filter(notNull).filter((d) => eventIds.has(d.eventId));
  const dayIds = new Set(days.map((d) => d.id));
  const circles = arr(raw.circles).map(toCircle).filter(notNull).filter((c) => dayIds.has(c.dayId));
  const circleDay = new Map(circles.map((c) => [c.id, c.dayId]));
  const items = arr(raw.items)
    .map(toItem)
    .filter(notNull)
    .filter((i) => circleDay.has(i.circleId))
    .map((i) => ({ ...i, dayId: circleDay.get(i.circleId)! })); // 所属日はサークルに合わせる

  // カタログ: 項目自体が無い(古いファイル)なら undefined のまま
  const catalog = Array.isArray(raw.catalog)
    ? raw.catalog.map(toCatalog).filter(notNull).filter((c) => eventIds.has(c.eventId) && dayIds.has(c.dayId))
    : undefined;
  const rawCatalog = Array.isArray(raw.catalog) ? raw.catalog.length : 0;
  const islands = Array.isArray(raw.islands)
    ? raw.islands.map(toIsland).filter(notNull).filter((x) => eventIds.has(x.eventId) && dayIds.has(x.dayId))
    : undefined;
  const grids = Array.isArray(raw.grids)
    ? raw.grids.map(toGrid).filter(notNull).filter((g) => eventIds.has(g.eventId) && dayIds.has(g.dayId))
    : undefined;
  const maps = Array.isArray(raw.maps)
    ? raw.maps.map(toMap).filter(notNull).filter((m) => eventIds.has(m.eventId) && dayIds.has(m.dayId))
    : undefined;

  const kept = events.length + days.length + circles.length + items.length + (catalog?.length ?? 0);
  return {
    ok: true,
    data: {
      app: BACKUP_APP,
      version: BACKUP_VERSION,
      exportedAt: str(raw.exportedAt),
      events,
      days,
      circles,
      items,
      ...(catalog ? { catalog } : {}),
      ...(maps && maps.length ? { maps } : {}),
      ...(islands ? { islands } : {}),
      ...(grids ? { grids } : {}),
    },
    dropped: rawCount + rawCatalog - kept,
  };
}

/** 別のイベントとして追加するために、全IDを振り直す(参照も合わせて置き換える) */
export function remapIds(b: Backup, newId: () => string, nameSuffix = '(コピー)'): Backup {
  const map = new Map<string, string>();
  const id = (old: string): string => {
    let v = map.get(old);
    if (!v) map.set(old, (v = newId()));
    return v;
  };
  return {
    ...b,
    events: b.events.map((e) => ({ ...e, id: id(e.id), name: `${e.name}${nameSuffix}`, createdAt: Date.now() })),
    days: b.days.map((d) => ({ ...d, id: id(d.id), eventId: id(d.eventId) })),
    circles: b.circles.map((c) => ({ ...c, id: id(c.id), dayId: id(c.dayId), ...(c.sheet ? { sheet: id(c.sheet) } : {}) })),
    items: b.items.map((i) => ({ ...i, id: id(i.id), circleId: id(i.circleId), dayId: id(i.dayId) })),
    ...(b.catalog ? { catalog: b.catalog.map((c) => ({ ...c, id: id(c.id), eventId: id(c.eventId), dayId: id(c.dayId) })) } : {}),
    ...(b.maps ? { maps: b.maps.map((m) => ({ ...m, eventId: id(m.eventId), dayId: id(m.dayId) })) } : {}),
    ...(b.islands ? { islands: b.islands.map((x) => ({ ...x, id: id(x.id), eventId: id(x.eventId), dayId: id(x.dayId) })) } : {}),
    ...(b.grids ? { grids: b.grids.map((g) => ({ ...g, id: id(g.id), eventId: id(g.eventId), dayId: id(g.dayId) })) } : {}),
  };
}

/** ファイル名に使えない文字を除く */
export function backupFileName(label: string, now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  const safe = label.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'data';
  return `お買い物_${safe}_${stamp}.json`;
}

// ---- 1件ずつの変換(不正な値は既定値に、IDがないものは捨てる) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const num = (v: unknown, d: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};
const nonNeg = (v: unknown, d = 0): number => Math.max(0, Math.round(num(v, d)));
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T =>
  list.includes(v as T) ? (v as T) : d;
const notNull = <T>(v: T | null): v is T => v !== null;

const VENUES: readonly Venue[] = ['bigsight', 'trc', 'other'];
const PRIORITIES: readonly Priority[] = ['must', 'want'];
const STATUSES: readonly ItemStatus[] = ['todo', 'bought', 'soldout', 'skip'];

function toEvent(v: unknown): EventRec | null {
  if (!isObj(v) || !str(v.id)) return null;
  return {
    id: str(v.id),
    name: str(v.name) || '(名前なし)',
    venue: oneOf(v.venue, VENUES, 'other'),
    budget: nonNeg(v.budget),
    createdAt: num(v.createdAt, Date.now()),
    ...(isObj(v.catalogInfo)
      ? { catalogInfo: { importedAt: num(v.catalogInfo.importedAt, Date.now()), source: str(v.catalogInfo.source) } }
      : {}),
  };
}

function toIsland(v: unknown): IslandRec | null {
  if (!isObj(v) || !str(v.id) || !str(v.eventId) || !str(v.dayId)) return null;
  const frac = (n: unknown, d: number): number => Math.min(1, Math.max(0, num(n, d)));
  return {
    id: str(v.id),
    eventId: str(v.eventId),
    dayId: str(v.dayId),
    block: str(v.block),
    x: frac(v.x, 0),
    y: frac(v.y, 0),
    w: Math.max(0.001, frac(v.w, 0.05)),
    h: Math.max(0.001, frac(v.h, 0.05)),
    top: str(v.top),
    right: str(v.right),
    bottom: str(v.bottom),
    left: str(v.left),
  };
}

function toGrid(v: unknown): GridRec | null {
  if (!isObj(v) || !str(v.dayId) || !str(v.eventId) || !Array.isArray(v.tokens)) return null;
  const tokens = v.tokens.filter(Array.isArray).map((row: unknown[]) => row.map(str));
  if (tokens.length === 0) return null;
  const g: GridRec = {
    id: str(v.id) || str(v.dayId), // 1日1つだった頃のファイルは、日の id をシートの id にする(端末の移し替えと同じ)
    dayId: str(v.dayId),
    eventId: str(v.eventId),
    name: str(v.name),
    tokens,
    order: num(v.order, 0),
    updatedAt: num(v.updatedAt, Date.now()),
  };
  if (str(v.hall)) g.hall = str(v.hall);
  return g;
}

function toMap(v: unknown): BackupMap | null {
  if (!isObj(v) || !str(v.dayId) || !str(v.eventId) || !/^data:image\/[a-z+.-]+;base64,/i.test(str(v.dataUrl))) return null;
  return {
    dayId: str(v.dayId),
    eventId: str(v.eventId),
    name: str(v.name),
    width: nonNeg(v.width, 1) || 1,
    height: nonNeg(v.height, 1) || 1,
    dataUrl: str(v.dataUrl),
  };
}

function toCatalog(v: unknown): CatalogRec | null {
  if (!isObj(v) || !str(v.id) || !str(v.eventId) || !str(v.dayId)) return null;
  return {
    id: str(v.id),
    eventId: str(v.eventId),
    dayId: str(v.dayId),
    hall: str(v.hall),
    block: str(v.block),
    number: str(v.number),
    name: str(v.name),
    penName: str(v.penName),
    tags: str(v.tags),
    homeUrl: /^https?:\/\//i.test(str(v.homeUrl)) ? str(v.homeUrl) : '',
    xHandle: toXHandle(str(v.xHandle)) ?? '',
  };
}

function toDay(v: unknown): DayRec | null {
  if (!isObj(v) || !str(v.id) || !str(v.eventId)) return null;
  const date = str(v.date);
  const day: DayRec = {
    id: str(v.id),
    eventId: str(v.eventId),
    label: str(v.label),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    order: num(v.order, 0),
  };
  if (isObj(v.route)) {
    day.route = { start: str(v.route.start) || 'auto', mustFirst: v.route.mustFirst !== false, updatedAt: num(v.route.updatedAt, 0) };
  }
  return day;
}

function toCircle(v: unknown): CircleRec | null {
  if (!isObj(v) || !str(v.id) || !str(v.dayId)) return null;
  const c: CircleRec = {
    id: str(v.id),
    dayId: str(v.dayId),
    name: str(v.name),
    hall: str(v.hall),
    block: str(v.block),
    number: str(v.number),
    priority: oneOf(v.priority, PRIORITIES, 'must'),
    order: num(v.order, 0),
    memo: str(v.memo),
  };
  if (str(v.penName)) c.penName = str(v.penName);
  const handle = toXHandle(str(v.xHandle));
  if (handle) c.xHandle = handle;
  if (typeof v.x === 'number' && typeof v.y === 'number') {
    c.x = v.x;
    c.y = v.y;
    if (str(v.sheet)) c.sheet = str(v.sheet);
  }
  return c;
}

function toItem(v: unknown): ItemRec | null {
  if (!isObj(v) || !str(v.id) || !str(v.circleId)) return null;
  return {
    id: str(v.id),
    circleId: str(v.circleId),
    dayId: str(v.dayId),
    name: str(v.name),
    price: nonNeg(v.price),
    qty: Math.max(1, nonNeg(v.qty, 1)),
    status: oneOf(v.status, STATUSES, 'todo'),
    order: num(v.order, 0),
  };
}
