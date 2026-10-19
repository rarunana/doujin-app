// 会場データ(マス目)のダイアログ: 選ぶ・確認して設定する・ブロック名を変更する・CSVで書き出す。
// 1日に何枚も持てる(シート)。同じ名前のシートを読み込むと、中身を置き換える。

import { decodeText } from '../csv.js';
import { allGrids, saveGrids, state, updateGrids } from '../store.js';
import type { GridRec } from '../types.js';
import { esc } from '../util.js';
import {
  blockColors,
  buildGridIndex,
  errorCount,
  gridFromTokens,
  gridToCsv,
  parseVenueCsv,
  renameBlocks,
  resolveGrid,
  spaceCount,
} from '../venueGrid.js';
import type { ResolvedGrid, VenueGrid } from '../venueGrid.js';
import { closeDialog, download, openDialog, toast } from './dialog.js';

/**
 * アプリに入っている会場(public/venues/index.json)。
 * file: 1枚だけ / files: 何枚かをまとめて(コミケのホールごとのシートなど)
 */
interface BuiltinVenue {
  name: string;
  note?: string;
  files: string[];
  grids: VenueGrid[]; // 読み込んだシート(空のCSVは除く)
  empty: string[]; // まだ空のシートの名前
}

/** アプリに入っている会場の一覧と中身(オフラインでも Service Worker のキャッシュから読める) */
async function builtins(): Promise<BuiltinVenue[]> {
  try {
    const res = await fetch('./venues/index.json');
    if (!res.ok) return [];
    const list: unknown = await res.json();
    if (!Array.isArray(list)) return [];
    const out: BuiltinVenue[] = [];
    for (const v of list) {
      if (typeof v?.name !== 'string') continue;
      const files: string[] = typeof v.file === 'string' ? [v.file] : Array.isArray(v.files) ? v.files.filter((f: unknown) => typeof f === 'string') : [];
      if (!files.length) continue;
      const loaded = await Promise.all(files.map((f) => loadCsv(f, files.length > 1 ? f.replace(/\.[^.]+$/, '') : v.name)));
      out.push({
        name: v.name,
        note: typeof v.note === 'string' ? v.note : undefined,
        files,
        grids: loaded.filter((g): g is VenueGrid => !!g && g.rows > 0 && g.cols > 0),
        empty: loaded.filter((g) => g && (g.rows === 0 || g.cols === 0)).map((g) => g!.name),
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function loadCsv(file: string, fallbackName: string): Promise<VenueGrid | null> {
  try {
    const res = await fetch(`./venues/${encodeURIComponent(file)}`);
    return res.ok ? parseVenueCsv(decodeText(await res.arrayBuffer()), fallbackName) : null;
  } catch {
    return null;
  }
}

const builtinNote = (v: BuiltinVenue): string => {
  const total = v.grids.length + v.empty.length;
  if (total <= 1) return v.empty.length ? '(CSVがまだ空です)' : '';
  return v.empty.length ? `${total}枚のうち ${v.grids.length}枚に中身があります(空: ${v.empty.join('、')})` : `${total}枚のシート`;
};

/** 他の日・他のイベントで使った会場データ(同じ内容は1つにまとめる) */
async function reusable(): Promise<GridRec[]> {
  const seen = new Set<string>();
  return (await allGrids()).filter((g) => {
    if (g.dayId === state.dayId) return false;
    const key = `${g.name}|${JSON.stringify(g.tokens)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------- 選ぶ

export async function openGridPicker(): Promise<void> {
  const [list, reuse] = await Promise.all([builtins(), reusable()]);
  const evName = (id: string): string => state.events.find((e) => e.id === id)?.name ?? '削除したイベント';
  openDialog(
    `
    <div class="sheet">
      <h2>会場データ(マス目)を追加</h2>
      <p class="note">マス目の会場データを使うと、サークルの配置番号からピンの位置が自動で決まります。1日に何枚でも追加でき、マップの上のタブで切り替えます(ホールごとに分けるときなど)。</p>
      <section class="data-sec">
        <h3>アプリに入っている会場</h3>
        ${
          list.length
            ? `<div class="pv-list">${list
                .map(
                  (v, i) => `
              <button type="button" class="btn wide grid-choice" data-act="builtin" data-i="${i}"${v.grids.length ? '' : ' aria-disabled="true"'}>
                <strong>${esc(v.name)}</strong>${v.note ? `<small>${esc(v.note)}</small>` : ''}${
                  builtinNote(v) ? `<small class="${v.grids.length ? '' : 'warn-text'}">${esc(builtinNote(v))}</small>` : ''
                }
              </button>`,
                )
                .join('')}</div>`
            : '<p class="note small">読み込めませんでした(一度ネットにつないだ状態でアプリを開くと使えるようになります)。</p>'
        }
      </section>
      ${
        reuse.length
          ? `<section class="data-sec">
        <h3>この端末で使った会場データ</h3>
        <div class="pv-list">${reuse
          .map(
            (g, i) => `
          <button type="button" class="btn wide grid-choice" data-act="reuse" data-i="${i}">
            <strong>${esc(g.name || '(名前なし)')}</strong><small>${esc(evName(g.eventId))}で使用${g.hall ? `・${esc(g.hall)}` : ''}</small>
          </button>`,
          )
          .join('')}</div>
      </section>`
          : ''
      }
      <section class="data-sec">
        <h3>CSVファイルから</h3>
        <label class="btn wide file-btn">CSVを選ぶ
          <input type="file" accept=".csv,text/csv" data-act="file" hidden>
        </label>
        <p class="note small">Excelで作ったマス目のCSV。書き方は、設定した会場データを「CSVで書き出す」で出したファイルを見本にしてください。</p>
      </section>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close">閉じる</button>
      </div>
    </div>`,
    (dlg) => {
      const sheet = dlg.querySelector<HTMLElement>('.sheet')!;
      sheet.querySelector<HTMLInputElement>('[data-act=file]')!.addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        try {
          const grid = parseVenueCsv(decodeText(await file.arrayBuffer()), file.name.replace(/\.[^.]+$/, ''));
          if (grid.rows === 0 || grid.cols === 0) throw new Error('CSVが空です(1行目の「#会場」の下にマス目を書いてください)');
          openGridConfirm([grid]);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        }
      });
      sheet.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn || btn.tagName === 'INPUT') return;
        const i = Number(btn.dataset.i);
        try {
          if (btn.dataset.act === 'close') closeDialog();
          if (btn.dataset.act === 'builtin') {
            const v = list[i];
            if (!v.grids.length) toast(`「${v.name}」のCSVはまだ空です。public/venues のCSVにマス目を書いてから使ってください`);
            else openGridConfirm(v.grids, v.empty);
          }
          if (btn.dataset.act === 'reuse') openGridConfirm([gridFromTokens(reuse[i].name, reuse[i].tokens, reuse[i].hall)]);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        }
      });
    },
  );
}

// ---------------------------------------------------------------- 確認して設定する

/** 検査結果(エラー → 注意の順)。Excel のセル番地つき */
export function issuesHtml(res: ResolvedGrid, open = false): string {
  if (!res.issues.length) return '';
  const errors = res.issues.filter((x) => x.level === 'error').length;
  const warns = res.issues.length - errors;
  const head = [errors ? `エラー ${errors}件` : '', warns ? `注意 ${warns}件` : ''].filter(Boolean).join('・');
  return `
    <details class="diff-box grid-issues"${open || errors ? ' open' : ''}>
      <summary>確認が必要な点: ${head}</summary>
      <ul>${res.issues
        .map((x) => `<li class="lv-${x.level}"><span class="badge ${x.level === 'error' ? 'err' : 'warn'}">${x.level === 'error' ? 'エラー' : '注意'}</span> ${esc(x.text)}</li>`)
        .join('')}</ul>
      ${errors ? '<p class="note small">エラーのあるスペースは、ピンの位置が決まらないか、違う場所になります。CSVを直して読み込み直してください(セル番地はExcelの表示と同じです)。</p>' : ''}
    </details>`;
}

/** ブロックの一覧(色つき) */
export function blocksHtml(res: ResolvedGrid): string {
  const colors = blockColors(res);
  return `<p class="grid-blocks">${res.blocks
    .map((b) => {
      const c = colors.get(b.name)!;
      return `<span class="badge blk" style="background:${c.fill};border-color:${c.line};color:#26262b">${esc(b.name)}<small> ${b.count}</small></span>`;
    })
    .join('')}</p>`;
}

/** 買い物リストのうち、この会場データで位置が決まる件数 */
function matchCount(res: ResolvedGrid): number {
  const idx = buildGridIndex(res);
  return state.circles.filter((c) => idx.find(c)).length;
}

function matchText(results: ResolvedGrid[]): string {
  const n = state.circles.length;
  if (!n) return '';
  const idxs = results.map(buildGridIndex);
  const ok = state.circles.filter((c) => idxs.some((idx) => idx.find(c))).length;
  return `<p class="note">この日の買い物リスト ${n}件のうち <strong>${ok}件</strong> の位置が決まります${results.length > 1 ? '(どれかのシートで)' : ''}。${
    ok < n ? '決まらないものは、ブロック名やホールの違い(「3組」と「C」など)か、番号が会場データに無いものです。' : ''
  }</p>`;
}

/** 読み込んだ会場データ(1枚または何枚か)を確認して、開催日に設定する。empty: 中身が空で飛ばしたシートの名前 */
export function openGridConfirm(grids: VenueGrid[], empty: string[] = []): void {
  const results = grids.map(resolveGrid);
  const days = state.days;
  const many = grids.length > 1;
  const sheetHtml = (grid: VenueGrid, res: ResolvedGrid, i: number): string => `
      <section class="data-sec gc-sheet">
        ${many ? `<h3>シート ${i + 1}${state.circles.length ? `<small>・リストの${matchCount(res)}件</small>` : ''}</h3>` : ''}
        <div class="field-row">
          <label class="field">${many ? 'シート名' : '会場名'}<input name="gname" data-i="${i}" value="${esc(grid.name)}" autocomplete="off"></label>
          <label class="field gc-hall">ホール<input name="ghall" data-i="${i}" value="${esc(grid.hall)}" placeholder="例: 東" autocomplete="off"></label>
        </div>
        <p class="note">${grid.cols}×${grid.rows}マス・ブロック ${res.blocks.length}個・スペース ${spaceCount(res)}</p>
        ${blocksHtml(res)}
        ${issuesHtml(res)}
      </section>`;
  openDialog(
    `
    <div class="sheet">
      <h2>会場データの確認</h2>
      ${grids.map((g, i) => sheetHtml(g, results[i], i)).join('')}
      ${empty.length ? `<p class="note warn-text">空のシート(${esc(empty.join('、'))})は追加しません。CSVにマス目を書くと使えるようになります。</p>` : ''}
      ${matchText(results)}
      <p class="note small">「ホール」に「東」などを入れると、ホールの違うサークル(西あ と 東ア など)をこのシートで探しません。空なら全部のサークルを探します。</p>
      ${
        days.length > 1
          ? `<div class="field">使う日
          ${days
            .map(
              (d) => `<label class="check-line"><input type="checkbox" name="day" value="${esc(d.id)}"${
                d.id === state.dayId ? ' checked' : ''
              }>${esc(d.label || d.date || '(日付なし)')}</label>`,
            )
            .join('')}
        </div>`
          : ''
      }
      <p class="note small">その日に同じ名前のシートがあれば中身を置き換え、無ければシートとして追加します。会場図の画像は消えません。</p>
      <div class="actions">
        <button type="button" class="btn" data-act="back">戻る</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-act="use">${many ? `${grids.length}枚を追加する` : 'この会場データを使う'}</button>
      </div>
    </div>`,
    (dlg) => {
      const sheet = dlg.querySelector<HTMLElement>('.sheet')!;
      sheet.addEventListener('click', async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'back') void openGridPicker();
        if (act !== 'use') return;
        const dayIds =
          days.length > 1
            ? [...sheet.querySelectorAll<HTMLInputElement>('[name=day]:checked')].map((x) => x.value)
            : state.dayId
              ? [state.dayId]
              : [];
        if (!dayIds.length) {
          toast('使う日を選んでください');
          return;
        }
        const val = (name: string, i: number): string =>
          sheet.querySelector<HTMLInputElement>(`[name=${name}][data-i="${i}"]`)?.value.trim() ?? '';
        const named = grids.map((g, i) => ({ ...g, name: val('gname', i) || g.name, hall: val('ghall', i) }));
        if (new Set(named.map((g) => g.name)).size < named.length) {
          toast('シート名が重なっています。別々の名前にしてください');
          return;
        }
        await saveGrids(dayIds, named);
        closeDialog();
        toast(many ? `会場データを${named.length}枚設定しました(${dayIds.length}日分)` : `会場データを設定しました(${dayIds.length}日分)`);
      });
    },
  );
}

// ---------------------------------------------------------------- ブロック名の変更

/** このイベントの他の日で、同じ会場データ(名前と中身が同じ)を使っているシート */
async function sameGridOthers(rec: GridRec): Promise<GridRec[]> {
  const key = JSON.stringify(rec.tokens);
  return (await allGrids()).filter(
    (g) => g.id !== rec.id && g.dayId !== rec.dayId && g.eventId === rec.eventId && g.name === rec.name && JSON.stringify(g.tokens) === key,
  );
}

export async function openBlockRename(rec: GridRec): Promise<void> {
  const grid = gridFromTokens(rec.name, rec.tokens, rec.hall);
  const res = resolveGrid(grid);
  const colors = blockColors(res);
  const others = await sameGridOthers(rec);
  openDialog(
    `
    <div class="sheet">
      <h2>ブロック名を変更</h2>
      <p class="note">買い物リストやカタログの書き方(「3組」「C」「東ア」など)に合わせると、ピンの位置が決まるようになります。</p>
      <div class="field-row grid-replace">
        <label class="field">置き換える文字<input name="from" placeholder="組" autocomplete="off"></label>
        <label class="field">新しい文字<input name="to" placeholder="(空で削除)" autocomplete="off"></label>
        <button type="button" class="btn small" data-act="replace-all">すべてに適用</button>
      </div>
      <table class="block-table">
        <thead><tr><th>今の名前</th><th>数</th><th>新しい名前</th></tr></thead>
        <tbody>${res.blocks
          .map(
            (b) => `<tr><td><span class="swatch" style="background:${colors.get(b.name)!.fill};border-color:${colors.get(b.name)!.line}"></span>${esc(b.name)}</td><td>${b.count}</td><td><input data-old="${esc(b.name)}" value="${esc(b.name)}" autocomplete="off"></td></tr>`,
          )
          .join('')}</tbody>
      </table>
      ${
        others.length
          ? `<label class="check-line"><input type="checkbox" name="all" checked>同じ会場データを使っている他の日(${others.length}日)にも反映</label>`
          : ''
      }
      <div class="actions">
        <button type="button" class="btn" data-act="close">やめる</button>
        <span class="spacer"></span>
        <button type="button" class="btn primary" data-act="save">変更する</button>
      </div>
    </div>`,
    (dlg) => {
      const sheet = dlg.querySelector<HTMLElement>('.sheet')!;
      const inputs = (): HTMLInputElement[] => [...sheet.querySelectorAll<HTMLInputElement>('input[data-old]')];
      sheet.addEventListener('click', async (e) => {
        const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
        if (act === 'close') closeDialog();
        if (act === 'replace-all') {
          const from = sheet.querySelector<HTMLInputElement>('[name=from]')!.value;
          const to = sheet.querySelector<HTMLInputElement>('[name=to]')!.value;
          if (!from) {
            toast('置き換える文字を入れてください');
            return;
          }
          for (const el of inputs()) el.value = el.value.split(from).join(to);
        }
        if (act !== 'save') return;
        const renames = new Map<string, string>();
        for (const el of inputs()) {
          const v = el.value.trim();
          if (v && v !== el.dataset.old) renames.set(el.dataset.old!, v);
        }
        if (!renames.size) {
          closeDialog();
          return;
        }
        const next = renameBlocks(grid, renames);
        const after = resolveGrid(next);
        if (errorCount(after) > errorCount(res) && !confirm('同じ名前のブロックができ、番号が重なる場所があります。このまま変更しますか?')) return;
        const all = sheet.querySelector<HTMLInputElement>('[name=all]')?.checked ?? false;
        await updateGrids(all ? [rec, ...others] : [rec], next);
        closeDialog();
        toast(`ブロック名を${renames.size}件変更しました`);
      });
    },
  );
}

// ---------------------------------------------------------------- 書き出し

export function exportGridCsv(rec: GridRec): void {
  const grid = gridFromTokens(rec.name, rec.tokens, rec.hall);
  const safe = (rec.name || '会場データ').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  download(new File([gridToCsv(grid)], `${safe}.csv`, { type: 'text/csv' }));
}

