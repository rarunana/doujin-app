// 動線の計算(WebAssembly 用の C++)。
//
// 会場をマス目(通れる/通れない)として受け取り、
//   1. 通路に沿った距離(8方向。縦横=10、斜め=14。角のすり抜けは不可)をダイクストラ法で測る
//   2. 回る順番を決める(必須を先に回る制約つき。近い順 → 2-opt → Or-opt で短くする)
//   3. 決まった順番で、サークル間の道のり(通るマス)を求める
// 70サークル規模なら一瞬で終わる。
//
// JavaScript とのやりとり: 標準ライブラリ(malloc など)を使わず、固定の大きさの配列を
// 用意して、その場所(ポインタ)を JS に渡す。JS がそこに入力を書き込み、solve() を呼び、
// 結果の配列を読む。同じ処理を JS でも書いてあり(src/route/routeJs.ts)、結果は一致する。
//
// ビルド: npm run build:wasm(scripts/build-wasm.mjs。clang か Emscripten を使う)

typedef unsigned char u8;
typedef int i32;

#ifndef __EMSCRIPTEN__
// 標準ライブラリなしでビルドするとき、コンパイラが配列の初期化に使う関数を自前で用意する
extern "C" void *memset(void *dst, int v, unsigned long n) {
  volatile u8 *d = (volatile u8 *)dst;
  for (unsigned long i = 0; i < n; i++) d[i] = (u8)v;
  return dst;
}
extern "C" void *memcpy(void *dst, const void *src, unsigned long n) {
  volatile u8 *d = (volatile u8 *)dst;
  const volatile u8 *s = (const volatile u8 *)src;
  for (unsigned long i = 0; i < n; i++) d[i] = s[i];
  return dst;
}
#endif

#define EXPORT(name) extern "C" __attribute__((export_name(#name), used))

// ---- 大きさの上限 ----
const i32 MAX_CELLS = 256 * 256;     // マスの数
const i32 MAX_T = 400;               // 目的地(サークル)の数
const i32 MAX_ACC = 16384;           // 目的地の「立つ場所」のマスの合計
const i32 MAX_PATH = 262144;         // 道のりのマスの合計
const i32 MAX_HEAP = MAX_CELLS * 8;  // ダイクストラ法の待ち行列
const i32 INF = 1000000000;
const i32 STRAIGHT = 10;
const i32 DIAG = 14;

// ---- 入力(JS が書き込む) ----
static u8 inPassable[MAX_CELLS];     // 1 = 通れる
static i32 inAcc[MAX_ACC];           // 目的地ごとの立つ場所(マスの番号 = 行 * 列数 + 列)
static i32 inAccStart[MAX_T + 2];    // 目的地 k の立つ場所は inAcc[inAccStart[k] .. inAccStart[k+1])。k = n はスタート地点
static i32 inPrio[MAX_T];            // 0 = 必須、1 = できれば
static i32 inOrder[MAX_T];           // 順番を決めずに道のりだけ求めるときの順番

// ---- 出力(JS が読む) ----
static i32 outOrder[MAX_T];          // 回る順番(目的地の番号)
static i32 outLegCost[MAX_T];        // 1つ前(またはスタート)から、その目的地までの距離。届かないときは -1
static i32 outLegStart[MAX_T + 1];   // 区間 i の道のりは outPath[outLegStart[i] .. outLegStart[i+1])
static i32 outPath[MAX_PATH];

// ---- 作業用 ----
static i32 cols, rows, nCells;
static i32 dist[MAX_CELLS];
static i32 parent[MAX_CELLS];
static i32 goalMark[MAX_CELLS];      // 目的地の立つ場所の印(stamp と同じ値なら印あり)
static i32 stamp = 0;
static i32 heapKey[MAX_HEAP];
static i32 heapCell[MAX_HEAP];
static i32 heapSize;
static i32 D[(MAX_T + 1) * (MAX_T + 1)]; // 目的地どうしの距離
static i32 nodeCount;                // 目的地の数 + (スタートがあれば1)

// ================================================================ 待ち行列(二分ヒープ)
// 距離が同じときはマスの番号が小さい方を先に出す(JS 版と結果をそろえるため)

static bool heapLess(i32 a, i32 b) {
  return heapKey[a] < heapKey[b] || (heapKey[a] == heapKey[b] && heapCell[a] < heapCell[b]);
}
static void heapSwap(i32 a, i32 b) {
  i32 k = heapKey[a]; heapKey[a] = heapKey[b]; heapKey[b] = k;
  i32 c = heapCell[a]; heapCell[a] = heapCell[b]; heapCell[b] = c;
}
static void heapPush(i32 key, i32 cell) {
  if (heapSize >= MAX_HEAP) return;
  i32 i = heapSize++;
  heapKey[i] = key;
  heapCell[i] = cell;
  while (i > 0) {
    i32 p = (i - 1) / 2;
    if (!heapLess(i, p)) break;
    heapSwap(i, p);
    i = p;
  }
}
static void heapPop() {
  heapSize--;
  heapKey[0] = heapKey[heapSize];
  heapCell[0] = heapCell[heapSize];
  i32 i = 0;
  for (;;) {
    i32 l = i * 2 + 1, r = l + 1, m = i;
    if (l < heapSize && heapLess(l, m)) m = l;
    if (r < heapSize && heapLess(r, m)) m = r;
    if (m == i) break;
    heapSwap(i, m);
    i = m;
  }
}

// ================================================================ 距離(ダイクストラ法)

static const i32 DR[8] = {-1, 1, 0, 0, -1, -1, 1, 1};
static const i32 DC[8] = {0, 0, -1, 1, -1, 1, -1, 1};

/**
 * sources のマスから、全部のマスへの距離を dist に入れる。
 * stopAtGoal: goalMark に印のあるマスに着いたら、そこで止めてそのマスを返す(道のりを求めるとき)
 */
static i32 dijkstra(const i32 *sources, i32 count, bool stopAtGoal) {
  for (i32 i = 0; i < nCells; i++) { dist[i] = INF; parent[i] = -1; }
  heapSize = 0;
  for (i32 i = 0; i < count; i++) {
    i32 s = sources[i];
    if (s < 0 || s >= nCells || !inPassable[s] || dist[s] == 0) continue;
    dist[s] = 0;
    heapPush(0, s);
  }
  while (heapSize > 0) {
    i32 d = heapKey[0], cell = heapCell[0];
    heapPop();
    if (d != dist[cell]) continue; // 古い情報
    if (stopAtGoal && goalMark[cell] == stamp) return cell;
    i32 r = cell / cols, c = cell % cols;
    for (i32 k = 0; k < 8; k++) {
      i32 nr = r + DR[k], nc = c + DC[k];
      if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
      i32 next = nr * cols + nc;
      if (!inPassable[next]) continue;
      if (k >= 4 && (!inPassable[r * cols + nc] || !inPassable[nr * cols + c])) continue; // 角はすり抜けない
      i32 nd = d + (k >= 4 ? DIAG : STRAIGHT);
      if (nd < dist[next]) {
        dist[next] = nd;
        parent[next] = cell;
        heapPush(nd, next);
      }
    }
  }
  return -1;
}

static i32 accCount(i32 node) { return inAccStart[node + 1] - inAccStart[node]; }
static const i32 *accOf(i32 node) { return inAcc + inAccStart[node]; }

/** 目的地どうし(とスタート)の距離の表を作る */
static void buildMatrix() {
  for (i32 i = 0; i < nodeCount; i++) {
    dijkstra(accOf(i), accCount(i), false);
    for (i32 j = 0; j < nodeCount; j++) {
      i32 best = INF;
      const i32 *a = accOf(j);
      for (i32 k = 0; k < accCount(j); k++) {
        i32 cell = a[k];
        if (cell >= 0 && cell < nCells && dist[cell] < best) best = dist[cell];
      }
      D[i * nodeCount + j] = i == j ? 0 : best;
    }
  }
}

static i32 dd(i32 a, i32 b) { return a < 0 ? 0 : D[a * nodeCount + b]; } // a < 0: スタートなし(どこからでも 0)

// ================================================================ 順番(巡回の最適化)

static i32 work[MAX_T];
static i32 cand[MAX_T];

/** prev から seq を順に回る距離(届かない区間は大きな値として足す) */
static long long pathCost(i32 prev, const i32 *seq, i32 m) {
  long long sum = 0;
  i32 p = prev;
  for (i32 i = 0; i < m; i++) {
    i32 d = dd(p, seq[i]);
    sum += d >= INF ? (long long)INF : d;
    p = seq[i];
  }
  return sum;
}

/** 近い順: from から、まだ回っていない中でいちばん近いものを選び続ける */
static void nearest(i32 from, const i32 *list, i32 m, i32 *out) {
  static u8 used[MAX_T];
  for (i32 i = 0; i < m; i++) used[i] = 0;
  i32 p = from;
  for (i32 k = 0; k < m; k++) {
    i32 best = -1;
    i32 bestD = 0;
    for (i32 i = 0; i < m; i++) {
      if (used[i]) continue;
      i32 d = dd(p, list[i]);
      if (best < 0 || d < bestD) { best = i; bestD = d; }
    }
    used[best] = 1;
    out[k] = list[best];
    p = list[best];
  }
}

/** 2-opt: 途中の一部を逆向きにして短くなるなら入れ替える */
static bool twoOpt(i32 prev, i32 *seq, i32 m) {
  long long base = pathCost(prev, seq, m);
  for (i32 i = 0; i < m - 1; i++) {
    for (i32 j = i + 1; j < m; j++) {
      for (i32 k = 0; k < m; k++) cand[k] = seq[k];
      for (i32 a = i, b = j; a < b; a++, b--) { i32 t = cand[a]; cand[a] = cand[b]; cand[b] = t; }
      long long c = pathCost(prev, cand, m);
      if (c < base) {
        for (i32 k = 0; k < m; k++) seq[k] = cand[k];
        return true;
      }
    }
  }
  return false;
}

/** Or-opt: 1〜3個の連続した目的地を、別の場所へ動かして短くなるなら動かす */
static bool orOpt(i32 prev, i32 *seq, i32 m) {
  long long base = pathCost(prev, seq, m);
  for (i32 len = 1; len <= 3; len++) {
    for (i32 i = 0; i + len <= m; i++) {
      for (i32 pos = 0; pos <= m - len; pos++) {
        if (pos == i) continue;
        // seq から [i, i+len) を抜き出し、残りの pos 番目に差し込む
        i32 n = 0;
        for (i32 k = 0; k < m; k++) if (k < i || k >= i + len) work[n++] = seq[k];
        i32 w = 0;
        for (i32 k = 0; k < pos; k++) cand[w++] = work[k];
        for (i32 k = 0; k < len; k++) cand[w++] = seq[i + k];
        for (i32 k = pos; k < n; k++) cand[w++] = work[k];
        long long c = pathCost(prev, cand, m);
        if (c < base) {
          for (i32 k = 0; k < m; k++) seq[k] = cand[k];
          return true;
        }
      }
    }
  }
  return false;
}

/** 1つのまとまり(必須 / できれば)の順番を決める。結果は seq に入る */
static void solveSegment(i32 prev, const i32 *list, i32 m, i32 *seq) {
  if (m == 0) return;
  if (prev >= 0) {
    nearest(prev, list, m, seq);
  } else {
    // スタートが決まっていない: どれから始めると短いかを全部試す
    static i32 trial[MAX_T];
    long long best = -1;
    for (i32 s = 0; s < m; s++) {
      for (i32 k = 0; k < m; k++) work[k] = list[k];
      work[0] = list[s];
      work[s] = list[0];
      trial[0] = work[0];
      nearest(work[0], work + 1, m - 1, trial + 1);
      long long c = pathCost(-1, trial, m);
      if (best < 0 || c < best) {
        best = c;
        for (i32 k = 0; k < m; k++) seq[k] = trial[k];
      }
    }
  }
  for (i32 guard = 0; guard < 2000; guard++) {
    if (twoOpt(prev, seq, m)) continue;
    if (orOpt(prev, seq, m)) continue;
    break;
  }
}

// ================================================================ 道のり

static i32 arrival; // 前の区間の終わりのマス(-1: まだない)

/** from(目的地の番号。-1 は arrival から)から to までの道のりを outPath に足す。距離を返す(届かない: -1) */
static i32 tracePath(i32 fromNode, i32 to, i32 *pathLen) {
  stamp++;
  const i32 *goal = accOf(to);
  for (i32 k = 0; k < accCount(to); k++) {
    i32 cell = goal[k];
    if (cell >= 0 && cell < nCells) goalMark[cell] = stamp;
  }
  i32 hit;
  if (arrival >= 0) hit = dijkstra(&arrival, 1, true);
  else hit = dijkstra(accOf(fromNode), accCount(fromNode), true);
  if (hit < 0) return -1;
  // 着いたマスから親をたどり、逆順に並べ直す
  i32 n = 0;
  for (i32 c = hit; c >= 0; c = parent[c]) n++;
  if (*pathLen + n > MAX_PATH) return -1;
  i32 i = *pathLen + n - 1;
  for (i32 c = hit; c >= 0; c = parent[c]) outPath[i--] = c;
  *pathLen += n;
  arrival = hit;
  return dist[hit];
}

// ================================================================ JS から呼ぶ関数

EXPORT(in_passable) u8 *in_passable() { return inPassable; }
EXPORT(in_acc) i32 *in_acc() { return inAcc; }
EXPORT(in_acc_start) i32 *in_acc_start() { return inAccStart; }
EXPORT(in_prio) i32 *in_prio() { return inPrio; }
EXPORT(in_order) i32 *in_order() { return inOrder; }
EXPORT(out_order) i32 *out_order() { return outOrder; }
EXPORT(out_leg_cost) i32 *out_leg_cost() { return outLegCost; }
EXPORT(out_leg_start) i32 *out_leg_start() { return outLegStart; }
EXPORT(out_path) i32 *out_path() { return outPath; }
EXPORT(limits) i32 limits(i32 which) {
  return which == 0 ? MAX_CELLS : which == 1 ? MAX_T : which == 2 ? MAX_ACC : MAX_PATH;
}

/**
 * 計算する。
 *   n: 目的地の数。hasStart: 1 ならノード n がスタート地点
 *   mustFirst: 1 なら必須(inPrio=0)を全部回ってから、できれば(1)を回る
 *   optimize: 1 なら順番を決める。0 なら inOrder の順番のまま道のりだけ求める
 * 戻り値: 距離の合計(届かない区間は除く)。大きさの上限を超えたら -1
 */
EXPORT(solve) i32 solve(i32 c, i32 r, i32 n, i32 hasStart, i32 mustFirst, i32 optimize) {
  cols = c;
  rows = r;
  nCells = c * r;
  if (c <= 0 || r <= 0 || nCells > MAX_CELLS || n < 0 || n > MAX_T) return -1;
  if (inAccStart[n + (hasStart ? 1 : 0)] > MAX_ACC) return -1;
  i32 start = hasStart ? n : -1;
  nodeCount = n + (hasStart ? 1 : 0);

  if (optimize) {
    buildMatrix();
    // どこからも届かない目的地は最後に回す
    static i32 groups[2][MAX_T];
    static i32 lost[MAX_T];
    i32 gn[2] = {0, 0}, ln = 0;
    for (i32 t = 0; t < n; t++) {
      bool reach = false;
      for (i32 u = 0; u < nodeCount && !reach; u++) {
        if (u != t && D[u * nodeCount + t] < INF) reach = true;
      }
      if (n == 1 && !hasStart) reach = accCount(t) > 0;
      if (!reach) { lost[ln++] = t; continue; }
      i32 g = mustFirst && inPrio[t] != 0 ? 1 : 0;
      groups[g][gn[g]++] = t;
    }
    i32 w = 0;
    i32 prev = start;
    for (i32 g = 0; g < 2; g++) {
      solveSegment(prev, groups[g], gn[g], outOrder + w);
      w += gn[g];
      if (w > 0) prev = outOrder[w - 1];
    }
    for (i32 k = 0; k < ln; k++) outOrder[w++] = lost[k];
  } else {
    for (i32 k = 0; k < n; k++) outOrder[k] = inOrder[k];
  }

  // 決まった順番で道のりを求める
  i32 pathLen = 0;
  i32 total = 0;
  arrival = -1;
  i32 fromNode = start;
  for (i32 k = 0; k < n; k++) {
    i32 to = outOrder[k];
    outLegStart[k] = pathLen;
    if (arrival < 0 && fromNode < 0) {
      // スタートなしの最初の目的地: ここから始める
      outLegCost[k] = 0;
      if (accCount(to) > 0) fromNode = to;
      continue;
    }
    i32 d = tracePath(fromNode, to, &pathLen); // 着いたら arrival が着いたマスになる
    outLegCost[k] = d;
    if (d >= 0) {
      total += d;
    } else if (accCount(to) > 0) {
      // 届かなかった: 次はこの目的地から探し直す(立つ場所が無ければ今の場所のまま)
      arrival = -1;
      fromNode = to;
    }
  }
  outLegStart[n] = pathLen;
  return total;
}
