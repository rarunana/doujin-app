"""東京流通センター(TRC)のマス目会場データを作る。2つ作る:

  public/venues/trc-gsf.csv       東京流通センター(GSF/SSF基準)。基礎になる配置(1組〜13組・ARENA[A]〜[F])
  public/venues/gsf04-ssf11.csv   GSF04/SSF11。GSF04 の配置図に合わせた配置(1組〜11組・ARENA[ア]〜[カ])

どちらも、アプリから書き出して手直しした CSV(2026-10)の配置を元にし、次の決まりで形をそろえる。
1マス = 1スペース番号。UTF-8 BOM付き(Excelでそのまま開ける)。

決まり:
  ・島先(島の端の4席)は、島から1マス空ける(間はサークルの席 ■ = 通れない)
  ・島先のある島と無い島(7組・11組など)は、両端をそろえて同じ長さにする
    (2組・8〜10組の下の島・ARENA[オ]は番号が少ないので例外。中央の通路側にそろえる)
  ・島と島の間の細い道は 2マス(左右も、上下の島の間も)
  ・壁際の道(壁際のサークルと島の間)は 3マス
  ・壁際のサークルは、後ろ(壁側)に ■ を置き、壁から1マス出っ張った形にする

記号: 空欄=通路 / #=壁・柱 / ■=机の内側・サークルの席 / 数字=スペース番号 / 【名前】=ブロック名のラベル
      !名前=施設(通れない) / *名前=出入口などの目印(通れる)
島の左半分と右半分で組が違うときは、中央の通路の左右にラベルを並べる(例: 【11組】【ARENA[ア]】)。

使い方: python tools/make-trc.py [出力先のフォルダ]
"""
import csv, os, sys

WALL_AISLE = 3   # 壁際の道
GAP = 2          # 島と島の間(左右)
MID = 2          # 上の島と下の島の間
END_GAP = 1      # 島先と島の間

def seq(a, b):
    return list(range(a, b + 1)) if a <= b else list(range(a, b - 1, -1))

def n2(x):
    return f'{x:02d}'

# ---- 島の形 ----------------------------------------------------------------
# top / bottom: 島先の4席(左から順。無ければ空)。left / right: 左右の列の番号(上から順)
def island(left, right, top=(), bottom=()):
    return {'left': list(left), 'right': list(right), 'top': list(top), 'bottom': list(bottom)}

def height(isl):
    h = len(isl['left'])
    if isl['top']: h += 1 + END_GAP
    if isl['bottom']: h += 1 + END_GAP
    return h

STD_U = island(seq(22, 15), seq(27, 34), [23, 24, 25, 26], [14, 13, 36, 35])
STD_D = island(seq(10, 3), seq(39, 46), [11, 12, 37, 38], [2, 1, 48, 47])
T44_U = island(seq(20, 13), seq(25, 32), [21, 22, 23, 24], [12, 11, 34, 33])
T44_D = island(seq(8, 3), seq(37, 42), [9, 10, 35, 36], [2, 1, 44, 43])
TALL_U = island(seq(24, 13), seq(25, 36))   # 7組など: 島先なし
TALL_D = island(seq(12, 1), seq(37, 48))
K11_U = island(seq(24, 13), seq(1, 12))     # GSF04: 左=11組 / 右=ARENA[ア]
K11_D = island(seq(12, 1), seq(13, 24))
S2_U = island(seq(14, 11), seq(19, 22), [15, 16, 17, 18], [10, 9, 24, 23])   # 2組
S2_D = island(seq(6, 3), seq(27, 30), [7, 8, 25, 26], [2, 1, 32, 31])
O_U = island(seq(20, 11), seq(21, 30))      # GSF04: ARENA[オ]
O_D = island(seq(10, 1), seq(31, 40))


class Hall:
    """外壁・壁際のサークル・島の並びまでを作る(両方の会場で共通の形)"""

    def __init__(self, columns, cols_after_hall):
        self.columns = columns
        # 列: 0=壁 / 1=壁の線(サークルの後ろは ■) / 2=壁際のサークル / 通路 / 島…
        self.seat_c = 2
        self.x0 = self.seat_c + 1 + WALL_AISLE
        self.pitch = 4 + GAP
        self.hall_right = self.x0 + self.pitch * (len(columns) - 1) + 3
        self.cols = self.hall_right + 1 + cols_after_hall
        # 行: 0=壁 / 1=壁の線 / 2=壁際のサークル / 通路 / 上の島 / 中央の通路 / 下の島 / 通路 / サークル / 壁の線 / 壁
        self.top_seats = 2
        self.up_top = self.top_seats + 1 + WALL_AISLE
        self.up_bottom = self.up_top + max(height(u) for _, u, _ in columns) - 1
        self.mid_row = self.up_bottom + 1
        self.low_top = self.up_bottom + MID + 1
        self.low_bottom = self.low_top + max(height(d) for _, _, d in columns) - 1
        self.bottom_seats = self.low_bottom + WALL_AISLE + 1
        self.rows = self.bottom_seats + 3
        self.g = [['' for _ in range(self.cols)] for _ in range(self.rows)]
        g, R, C = self.g, self.rows, self.cols
        self.rect(0, 1, 0, C - 1, '#')
        self.rect(R - 2, R - 1, 0, C - 1, '#')
        self.rect(0, R - 1, 0, 1, '#')
        self.rect(0, R - 1, C - 1, C - 1, '#')
        for i, (labels, up, down) in enumerate(columns):
            c0 = self.col(i)
            self.draw(up, c0, self.up_bottom - height(up) + 1)
            self.draw(down, c0, self.low_top)
            for k, lab in enumerate(labels):
                self.put(self.mid_row, c0 + 1 + k, f'【{lab}】')
        # 左の壁際: 50〜45 / 44〜33 / 32〜27
        self.seats_v(self.up_top + 1, seq(50, 45))
        self.seats_v(self.up_top + 8, seq(44, 33))
        self.seats_v(self.up_top + 21, seq(32, 27))

    def col(self, i):
        return self.x0 + self.pitch * i

    def put(self, r, c, v):
        if self.g[r][c] not in ('', v):
            raise SystemExit(f'重なり: ({r},{c}) {self.g[r][c]!r} に {v!r}')
        self.g[r][c] = v

    def rect(self, r0, r1, c0, c1, v):
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                self.g[r][c] = v

    def draw(self, isl, c0, top):
        r = top
        if isl['top']:
            for i, v in enumerate(isl['top']): self.put(r, c0 + i, n2(v))
            for k in range(END_GAP): self.rect(r + 1 + k, r + 1 + k, c0, c0 + 3, '■')
            r += 1 + END_GAP
        for i, (a, b) in enumerate(zip(isl['left'], isl['right'])):
            self.put(r + i, c0, n2(a)); self.put(r + i, c0 + 1, '■'); self.put(r + i, c0 + 2, '■'); self.put(r + i, c0 + 3, n2(b))
        r += len(isl['left'])
        if isl['bottom']:
            for k in range(END_GAP): self.rect(r + k, r + k, c0, c0 + 3, '■')
            for i, v in enumerate(isl['bottom']): self.put(r + END_GAP, c0 + i, n2(v))

    def seats_top(self, c0, nums, block='1組', label_c=None):
        """上の壁際のサークル(後ろに ■)とラベル"""
        for i, v in enumerate(nums):
            self.put(self.top_seats, c0 + i, n2(v)); self.g[1][c0 + i] = '■'
        self.put(self.top_seats + 1, c0 if label_c is None else label_c, f'【{block}】')

    def seats_bottom(self, c0, nums, block='1組', label_c=None):
        r = self.bottom_seats
        for i, v in enumerate(nums):
            self.put(r, c0 + i, n2(v)); self.g[r + 1][c0 + i] = '■'
        self.put(r - 1, c0 if label_c is None else label_c, f'【{block}】')

    def seats_v(self, r0, nums):
        for i, v in enumerate(nums):
            self.put(r0 + i, self.seat_c, n2(v)); self.g[r0 + i][1] = '■'
        self.put(r0, self.seat_c + 1, '【1組】')

    def top_1kumi(self, x):
        """上の1組 51〜86(6席ずつ)。宅配搬出受付(2行)は 69〜74 のすぐ右"""
        for k, a in enumerate(range(51, 87, 6)):
            if k == 4:
                self.rect(self.top_seats, self.top_seats + 1, x - 1, x + 6, '!宅配搬出受付'); x += 8
            self.seats_top(x, seq(a, a + 5)); x += 7
        return x

    def bottom_1kumi(self, x):
        """下の1組 26〜17 / 16〜09 / 08〜01(間は通路)"""
        for nums in (seq(26, 17), seq(16, 9), seq(8, 1)):
            self.seats_bottom(x, nums); x += len(nums) + 1
        return x

    def write(self, path, name):
        os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
        with open(path, 'w', encoding='utf-8-sig', newline='') as f:
            w = csv.writer(f, lineterminator='\r\n')
            w.writerow(['#会場', name])
            w.writerows(self.g)
        print('書き出し:', path, f'{self.cols}x{self.rows}')


# ---- 東京流通センター(GSF/SSF基準): 基礎になる配置 -------------------------------
def build_base():
    cols = [
        (['2組'], S2_U, S2_D),
        (['3組'], STD_U, STD_D), (['4組'], STD_U, STD_D), (['5組'], STD_U, STD_D), (['6組'], STD_U, STD_D),
        (['7組'], TALL_U, TALL_D),
        (['8組'], T44_U, T44_D), (['9組'], T44_U, T44_D), (['10組'], T44_U, T44_D),
        (['11組'], TALL_U, TALL_D),
        (['12組'], STD_U, STD_D), (['13組'], STD_U, STD_D),
        (['ARENA[A]'], STD_U, STD_D),
        (['ARENA[B]'], TALL_U, TALL_D),
        (['ARENA[C]'], STD_U, STD_D), (['ARENA[D]'], STD_U, STD_D), (['ARENA[E]'], STD_U, STD_D),
    ]
    # 右側: 通路5マス + 女子更衣室・コスプレ登録(5マス)+ 右の壁
    h = Hall(cols, 5 + 5 + 1)
    g, C, R = h.g, h.cols, h.rows
    fx = h.hall_right + 6                     # 右の施設の列
    h.rect(1, h.up_top, fx, C - 1, '#')       # 右上の角
    h.rect(h.bottom_seats - 1, R - 1, fx, C - 1, '#')   # 右下の角
    h.rect(h.up_top + 1, h.up_top + 20, fx, fx + 4, '!女子更衣室')
    h.rect(h.up_top + 22, h.up_top + 25, fx, fx + 4, '!コスプレ登録')

    x = h.top_1kumi(h.x0 + 2)
    # メロンブックス(2行)。ARENA[F] 上: 01〜06 / 07〜12 / 13〜24
    mx = h.col(10) - 1
    h.rect(h.top_seats, h.top_seats + 1, mx, mx + 4, '!メロンブックス')
    fa = mx + 6
    h.seats_top(fa, seq(1, 6), 'ARENA[F]')
    h.seats_top(fa + 21, seq(7, 12), 'ARENA[F]')
    h.seats_top(fa + 28, seq(13, 24), 'ARENA[F]', fa + 34)

    # 下: 1組、運営本部・運営スペース、入場口・退場口、ARENA[F] 50〜45 / 44〜25
    h.bottom_1kumi(h.x0 + 2)
    bs = h.bottom_seats
    ox = h.col(6) - 4
    h.rect(bs - 1, bs, ox, ox + 8, '!運営本部')
    h.rect(bs - 1, bs, ox + 10, ox + 20, '!運営スペース')
    g[bs + 1][ox + 27] = '*入場口'            # 壁の線に開いた出入口
    h.rect(bs - 1, bs, ox + 30, ox + 39, '!運営スペース')
    fb = ox + 42
    h.seats_bottom(fb, seq(50, 45), 'ARENA[F]')
    g[bs + 1][fb + 8] = '*退場口'
    h.seats_bottom(fb + 10, seq(44, 25), 'ARENA[F]')
    return h


# ---- GSF04/SSF11: GSF04 の配置図に合わせた配置 ------------------------------
def build_gsf04():
    cols = [
        (['2組'], S2_U, S2_D),
        (['3組'], STD_U, STD_D), (['4組'], STD_U, STD_D), (['5組'], STD_U, STD_D), (['6組'], STD_U, STD_D),
        (['7組'], TALL_U, TALL_D),
        (['8組'], T44_U, T44_D), (['9組'], T44_U, T44_D), (['10組'], T44_U, T44_D),
        (['11組', 'ARENA[ア]'], K11_U, K11_D),
        (['ARENA[イ]'], STD_U, STD_D), (['ARENA[ウ]'], STD_U, STD_D), (['ARENA[エ]'], STD_U, STD_D),
        (['ARENA[オ]'], O_U, O_D),
    ]
    lobby_w = 25
    # 右側: 通路3マス + 仕切りの壁 + ロビー + 右の壁
    h = Hall(cols, WALL_AISLE + 1 + lobby_w + 1)
    g, C, R = h.g, h.cols, h.rows
    div = h.hall_right + WALL_AISLE + 1

    h.top_1kumi(h.x0 + 2)
    h.bottom_1kumi(h.x0 + 2)
    # ARENA[カ]: 上 01〜06・07〜12、下 30〜13。上の席の左の3マスは壁がへこんでいる(手直し版のとおり)
    ka = h.col(10) + 2
    h.rect(1, 1, ka - 3, ka - 1, '')
    h.seats_top(ka, seq(1, 6), 'ARENA[カ]')
    h.seats_top(ka + 7, seq(7, 12), 'ARENA[カ]', ka + 12)
    h.seats_bottom(ka, seq(30, 13), 'ARENA[カ]', ka + 1)
    # 運営本部・運営スペース(下の壁際、2行)
    fx = h.col(6) - 1
    h.rect(h.bottom_seats - 1, h.bottom_seats, fx, fx + 5, '!運営本部')
    h.rect(h.bottom_seats - 1, h.bottom_seats, fx + 7, fx + 17, '!運営スペース')

    # ホールとロビーの間の壁(出入口つき。手直し版と同じ位置・幅)
    for r in range(R): g[r][div] = '#'
    def opening(r0, r1, name, at):
        for r in range(r0, r1 + 1): g[r][div] = ''
        g[at][div] = f'*{name}'
    opening(h.mid_row - 6, h.mid_row - 2, '入口', h.mid_row - 4)
    opening(h.mid_row + 1, h.mid_row + 5, '出口', h.mid_row + 3)

    # ロビーの左下から外へ出る通路(ロビー側から入って下の壁を抜ける)
    cx = div - 1
    lb = h.bottom_seats
    h.rect(lb - 1, lb - 1, cx - 1, div, '#')
    for r in range(lb, R):
        g[r][cx - 1] = '#'; g[r][cx] = ''
    g[lb][div] = ''

    # ロビー(手直し版の形のまま)
    r_in = C - 2
    h.rect(lb + 1, R - 1, div + 1, C - 1, '#')
    g[lb + 1][r_in - 5] = ''
    h.rect(2, 2, div + 1, C - 1, '#')
    h.rect(3, 5, r_in - 4, r_in, '#')
    h.rect(lb, lb, r_in - 4, r_in, '#')
    h.rect(6, 9, r_in - 2, r_in, '!運営スペース')
    h.rect(11, 14, r_in - 2, r_in, '!メロンブックス')
    h.rect(16, 20, r_in - 2, r_in, '!金沢印刷所')
    h.rect(lb - 4, lb - 1, r_in - 4, r_in - 2, '!入場チケット販売')
    return h


out_dir = sys.argv[1] if len(sys.argv) > 1 else 'public/venues'
build_base().write(os.path.join(out_dir, 'trc-gsf.csv'), '東京流通センター(GSF/SSF基準)')
build_gsf04().write(os.path.join(out_dir, 'gsf04-ssf11.csv'), 'GSF04/SSF11(東京流通センター)')
