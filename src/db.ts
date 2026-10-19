// IndexedDB の薄いラッパー。外部ライブラリなし。

const DB_NAME = 'doujin-shopping';
// 1: イベント・開催日・サークル・頒布物
// 2: カタログ(イベントの全サークル一覧)を追加
// 3: 会場図(開催日ごとの画像)を追加
// 4: 島(会場図の上の長方形と番号の並び)を追加
// 5: 会場データ(マス目)を追加(1日に1つ。dayId がキー)
// 6: 会場データを1日に何枚も持てるように、sheets(id がキー)へ移す。grids は消す
const DB_VERSION = 6;

export type StoreName = 'events' | 'days' | 'circles' | 'items' | 'catalog' | 'maps' | 'islands' | 'sheets';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // 古い版から開いたときは、足りない分だけ作る(既存のデータはそのまま残る)
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore('events', { keyPath: 'id' });
        db.createObjectStore('days', { keyPath: 'id' }).createIndex('eventId', 'eventId');
        db.createObjectStore('circles', { keyPath: 'id' }).createIndex('dayId', 'dayId');
        const items = db.createObjectStore('items', { keyPath: 'id' });
        items.createIndex('dayId', 'dayId');
        items.createIndex('circleId', 'circleId');
      }
      if (e.oldVersion < 2) {
        db.createObjectStore('catalog', { keyPath: 'id' }).createIndex('eventId', 'eventId');
      }
      if (e.oldVersion < 3) {
        db.createObjectStore('maps', { keyPath: 'dayId' }).createIndex('eventId', 'eventId');
      }
      if (e.oldVersion < 4) {
        db.createObjectStore('islands', { keyPath: 'id' }).createIndex('eventId', 'eventId');
      }
      if (e.oldVersion < 6) {
        const sheets = db.createObjectStore('sheets', { keyPath: 'id' });
        sheets.createIndex('dayId', 'dayId');
        sheets.createIndex('eventId', 'eventId');
      }
      if (e.oldVersion === 5) {
        // 版5の会場データ(1日に1つ)を、その日の1枚目のシートとして移す。id は日の id をそのまま使う
        const tx = req.transaction!;
        const old = tx.objectStore('grids').getAll();
        old.onsuccess = () => {
          const sheets = tx.objectStore('sheets');
          for (const g of old.result as { dayId: string }[]) sheets.put({ ...g, id: g.dayId, order: 0 });
          db.deleteObjectStore('grids');
        };
      }
    };
    req.onsuccess = () => {
      // 別のタブで新しい版が開かれたら、この接続を閉じて再読み込みを促す
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('古い版のアプリが別のタブで開いています。そのタブを閉じてから再読み込みしてください。'));
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getAll<T>(store: StoreName, index?: string, key?: IDBValidKey): Promise<T[]> {
  const db = await openDb();
  const os = db.transaction(store).objectStore(store);
  return result(index ? os.index(index).getAll(key) : os.getAll()) as Promise<T[]>;
}

export async function getOne<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

/**
 * 1つのトランザクションでまとめて削除・書き込みする(途中で失敗したら全部取り消し)。
 * 削除を先に行うので、同じIDを削除してから書き直す「上書き」にも使える。
 */
export async function write(ops: {
  put?: Partial<Record<StoreName, object[]>>;
  del?: Partial<Record<StoreName, string[]>>;
}): Promise<void> {
  const stores = [
    ...new Set([...Object.keys(ops.put ?? {}), ...Object.keys(ops.del ?? {})]),
  ] as StoreName[];
  if (stores.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(stores, 'readwrite');
  for (const [store, ids] of Object.entries(ops.del ?? {})) {
    const os = tx.objectStore(store);
    for (const id of ids ?? []) os.delete(id);
  }
  for (const [store, values] of Object.entries(ops.put ?? {})) {
    const os = tx.objectStore(store);
    for (const v of values ?? []) os.put(v);
  }
  await done(tx);
}

/** ブラウザによる自動削除を避けるよう、永続保存を依頼する(拒否されても動作は続ける) */
export async function requestPersist(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {
    /* 未対応ブラウザでは何もしない */
  }
}
