// データは「イベント > 開催日 > サークル > 頒布物」の4階層。
// それとは別に、イベントごとの全サークル一覧(カタログ)を持てる。

export type Venue = 'bigsight' | 'trc' | 'other';

export interface EventRec {
  id: string;
  name: string; // 例: C107
  venue: Venue;
  budget: number; // 円。イベント全体(全日程)の予算
  createdAt: number;
  catalogInfo?: CatalogInfo; // カタログ(全サークル一覧)を取り込んだ記録
}

export interface CatalogInfo {
  importedAt: number;
  source: string; // 取り込んだファイル名など
}

/** 会場図: 開催日ごとに1枚。画像は端末内に保存する(書き出しファイルには任意で同梱) */
export interface MapRec {
  dayId: string;
  eventId: string;
  blob: Blob;
  width: number; // 画像の大きさ(px)。ピンの位置は 0〜1 の割合で持つので、画像を差し替えても大きくはずれない
  height: number;
  name: string; // 元のファイル名
  updatedAt: number;
}

/**
 * 会場データ(マス目)の1枚(シート)。CSV のマスの中身をそのまま持つ(書き方は venueGrid.ts)。
 * 1日に何枚も持てる(コミケの東1〜3・東7・西・南のように、ホールごとに分けるため)。
 * これがある日は、会場図の画像の代わりにマス目を表示し、配置番号からピンの位置を決める。
 */
export interface GridRec {
  id: string;
  dayId: string;
  eventId: string;
  name: string; // シートの名前(例: 東京流通センター(GSF/SSF基準)、東1〜3ホール)
  hall?: string; // ホール(例: 東)。あれば、ホールの違うサークルはこのシートで探さない
  tokens: string[][];
  order: number; // 1日の中のシートの並び
  updatedAt: number;
}

/**
 * 島(L1): 会場図の上に描いた長方形と、各辺に並ぶスペース番号。
 * 位置・大きさは会場図に対する割合(0〜1)。番号は印刷どおりに入力する
 * (上辺・下辺は左から右、左辺・右辺は上から下。「23-26」「22-15」「14,13,36,35」のように書ける)。
 */
export interface IslandRec {
  id: string;
  eventId: string;
  dayId: string;
  block: string; // 例: 3組 / 東ア / ア
  x: number;
  y: number;
  w: number;
  h: number;
  top: string;
  right: string;
  bottom: string;
  left: string;
}

/** カタログ: イベントの全サークル一覧の1件。買い物リスト(CircleRec)とは別に持つ */
export interface CatalogRec {
  id: string;
  eventId: string;
  dayId: string;
  hall: string;
  block: string;
  number: string;
  name: string;
  penName: string;
  tags: string; // 作品・キャラなど(GSFなら「プロデュースアイドル」)
  homeUrl: string;
  xHandle: string;
}

export interface DayRec {
  id: string;
  eventId: string;
  label: string; // 例: 1日目
  date: string; // YYYY-MM-DD(空でも可)
  order: number;
  route?: RouteMeta; // 動線: 回る順番を計算したときの設定(順番そのものは各サークルの order)
}

/** 動線の設定 */
export interface RouteMeta {
  start: string; // スタート地点: 'auto' / 'marker:入口' / 'circle:<id>'
  mustFirst: boolean; // 必須を先に回る
  updatedAt: number; // 計算した日時
}

export type Priority = 'must' | 'want';

export interface CircleRec {
  id: string;
  dayId: string;
  name: string;
  penName?: string; // ペンネーム(作家名)
  hall: string; // 例: 東
  block: string; // 例: ア
  number: string; // 例: 01a
  priority: Priority;
  order: number; // 回る順番(動線機能で使用)
  memo: string;
  xHandle?: string; // X(Twitter)のアカウント名(@なし)。リンクは表示時に作る
  x?: number; // 会場図上の位置。画像の幅・高さに対する割合(0〜1)
  y?: number;
  sheet?: string; // 手で置いたピンのシート(会場データが何枚もある日)。無ければ最初のシート
}

export type ItemStatus = 'todo' | 'bought' | 'soldout' | 'skip';

export interface ItemRec {
  id: string;
  circleId: string;
  dayId: string; // 日単位でまとめて読むために持たせる
  name: string;
  price: number; // 円
  qty: number;
  status: ItemStatus;
  order?: number; // サークル内での並び順(入力した順)。古いデータには無い
}

export const VENUE_LABEL: Record<Venue, string> = {
  bigsight: '東京ビッグサイト',
  trc: '東京流通センター',
  other: 'その他',
};

export const STATUS_LABEL: Record<ItemStatus, string> = {
  todo: '未購入',
  bought: '購入済み',
  soldout: '売り切れ',
  skip: '見送り',
};
