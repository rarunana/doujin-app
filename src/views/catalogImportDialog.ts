// カタログ(全サークル一覧)の取り込み画面。
// 保存したWebページ(.html)、ブラウザでコピーした表、CSV のどれからでも読める。

import { convertRows, diffWithCatalog, guessColumns, NO_COLUMNS } from '../catalog.js';
import type { CatalogColumns } from '../catalog.js';
import { decodeText } from '../csv.js';
import { dayName, resolveDay } from '../dayResolve.js';
import { circlesOfEvent, currentEvent, saveCatalog, state } from '../store.js';
import { largestTable, tableFromText, tablesFromHtml } from '../tableParse.js';
import type { Table } from '../tableParse.js';
import type { CatalogRec } from '../types.js';
import { esc, spaceLabel, uid } from '../util.js';
import { closeDialog, openDialog, toast } from './dialog.js';

const FIELDS: { key: keyof CatalogColumns; label: string; required?: boolean }[] = [
  { key: 'block', label: '組・ブロック' },
  { key: 'space', label: '番号・配置', required: true },
  { key: 'name', label: 'サークル名', required: true },
  { key: 'pen', label: 'ペンネーム' },
  { key: 'tags', label: '作品・キャラ' },
  { key: 'x', label: 'X(Twitter)' },
  { key: 'home', label: 'HOME' },
  { key: 'day', label: '日' },
];

export function openCatalogImport(onDone?: () => void): void {
  const ev = currentEvent();
  if (!ev || state.days.length === 0) return;
  const multiDay = state.days.length > 1;
  const current = state.catalog.length;

  openDialog(
    `
    <div class="sheet">
      <h2>サークル一覧を取り込む</h2>
      <p class="note">イベント公式サイトのサークル一覧などを取り込みます。PCでの操作がおすすめです。</p>
      <ol class="steps note">
        <li>一覧のページをブラウザで開き、Ctrl+S(Macは⌘+S)で保存して、その .html ファイルを選ぶ</li>
        <li>または、ページ上の表を選択してコピーし、下の枠に貼り付ける</li>
      </ol>
      <label class="btn file-btn">ファイルを選ぶ(.html / .csv)
        <input type="file" accept=".html,.htm,.csv,.txt,text/html,text/csv,text/plain" data-act="file" hidden>
      </label>
      <textarea class="paste-box" rows="2" placeholder="ここに表を貼り付け(Ctrl+V)" data-act="paste"></textarea>
      <div data-mapping></div>
      <p class="error" data-error hidden></p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="cancel">キャンセル</button>
        <button type="button" class="btn primary" data-act="save" disabled>保存</button>
      </div>
    </div>`,
    (root) => {
      const sheet = root.querySelector<HTMLElement>('.sheet')!;
      const mappingEl = sheet.querySelector<HTMLElement>('[data-mapping]')!;
      const saveBtn = sheet.querySelector<HTMLButtonElement>('[data-act=save]')!;
      const errorEl = sheet.querySelector<HTMLElement>('[data-error]')!;
      let table: Table = [];
      let source = '';
      let entries: CatalogRec[] = [];

      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
      };

      const load = (t: Table | null, src: string): void => {
        showError('');
        if (!t || t.length === 0) {
          showError('表が見つかりませんでした。サークル一覧のページか、表の部分をコピーしたものを使ってください。');
          return;
        }
        table = t;
        source = src;
        const { columns, headerRow } = guessColumns(table);
        mappingEl.innerHTML = renderMapping(table, columns, headerRow, multiDay);
        refresh();
      };

      const readColumns = (): CatalogColumns => {
        const cols = { ...NO_COLUMNS };
        for (const f of FIELDS) {
          const v = mappingEl.querySelector<HTMLSelectElement>(`[name=col-${f.key}]`)?.value;
          cols[f.key] = v === undefined ? -1 : Number(v);
        }
        return cols;
      };

      const refresh = (): void => {
        const cols = readColumns();
        const fallback = mappingEl.querySelector<HTMLSelectElement>('[name=defaultDay]')?.value ?? state.days[0].id;
        const result = convertRows(table, cols, {
          eventId: ev.id,
          dayFor: (hint) => resolveDay(hint, state.days)?.id ?? fallback,
          newId: uid,
        });
        entries = result.entries;
        const preview = mappingEl.querySelector<HTMLElement>('[data-preview]')!;
        preview.innerHTML = renderPreview(entries, result.skipped, current);
        saveBtn.disabled = entries.length === 0;
        saveBtn.textContent = entries.length ? `${entries.length}件を保存` : '保存';
      };

      sheet.querySelector<HTMLInputElement>('[data-act=file]')!.addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const text = decodeText(await file.arrayBuffer());
        const isHtml = /\.html?$/i.test(file.name) || /<table[\s>]/i.test(text);
        load(isHtml ? largestTable(tablesFromHtml(text)) : tableFromText(text), file.name);
      });

      // 貼り付け: コピーした表はHTMLとしても入っているので、リンク(X・HOME)まで読める
      const pasteBox = sheet.querySelector<HTMLTextAreaElement>('[data-act=paste]')!;
      pasteBox.addEventListener('paste', (e) => {
        const html = e.clipboardData?.getData('text/html') ?? '';
        const plain = e.clipboardData?.getData('text/plain') ?? '';
        e.preventDefault();
        const fromHtml = html ? largestTable(tablesFromHtml(html)) : null;
        load(fromHtml ?? tableFromText(plain), '貼り付けた表');
        pasteBox.value = '';
        pasteBox.placeholder = table.length ? `貼り付けた表を読み取りました(${table.length}行)` : 'ここに表を貼り付け(Ctrl+V)';
      });

      mappingEl.addEventListener('change', refresh);

      sheet.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'cancel') closeDialog();
        if (btn.dataset.act !== 'save' || entries.length === 0) return;
        try {
          // 取り込んだ日の分だけ入れ替える(単日イベントなら全体)
          const dayIds = multiDay ? [...new Set(entries.map((x) => x.dayId))] : state.days.map((d) => d.id);
          await saveCatalog(entries, dayIds, source);
          const diffs = diffWithCatalog(await circlesOfEvent(), state.catalog);
          closeDialog();
          toast(
            diffs.length
              ? `${entries.length}件を保存しました。一覧と違うサークルが${diffs.length}件あります(「データ」で確認)`
              : `${entries.length}件を保存しました`,
          );
          onDone?.();
        } catch (err) {
          showError(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    },
  );
}

function renderMapping(table: Table, cols: CatalogColumns, headerRow: number, multiDay: boolean): string {
  const width = Math.max(...table.slice(0, 30).map((r) => r.length));
  const head = headerRow >= 0 ? table[headerRow] : [];
  // 見出しが無い列は、1行目のデータを例として出す
  const sampleRow = table.find((_, i) => i > headerRow) ?? [];
  const label = (i: number): string => {
    const h = head[i]?.text || sampleRow[i]?.text || (sampleRow[i]?.hrefs[0] ?? '');
    return `${i + 1}列目${h ? `: ${h.length > 14 ? h.slice(0, 14) + '…' : h}` : ''}`;
  };
  const select = (key: keyof CatalogColumns, required?: boolean): string => {
    const opts = Array.from({ length: width }, (_, i) => `<option value="${i}"${cols[key] === i ? ' selected' : ''}>${esc(label(i))}</option>`);
    if (!required || cols[key] < 0) opts.unshift(`<option value="-1"${cols[key] < 0 ? ' selected' : ''}>なし</option>`);
    return `<select name="col-${key}">${opts.join('')}</select>`;
  };
  const dayOptions = state.days
    .map((d, i) => `<option value="${esc(d.id)}"${d.id === state.dayId ? ' selected' : ''}>${esc(dayName(d, i))}</option>`)
    .join('');
  return `
    <p class="note small">${table.length}行の表を読み取りました。列の割り当てを確認してください。</p>
    <div class="col-grid">
      ${FIELDS.filter((f) => f.key !== 'day' || multiDay)
        .map((f) => `<label class="field"><span>${f.label}${f.required ? '' : '<small>(任意)</small>'}</span>${select(f.key, f.required)}</label>`)
        .join('')}
      ${multiDay ? `<label class="field">日の指定がない行<select name="defaultDay">${dayOptions}</select></label>` : ''}
    </div>
    <div data-preview></div>`;
}

function renderPreview(entries: CatalogRec[], skipped: number, current: number): string {
  if (entries.length === 0) {
    return `<p class="error">配置番号とサークル名を読み取れた行がありません。列の割り当てを確認してください。</p>`;
  }
  const sample = entries.slice(0, 5);
  return `
    <p class="note">
      ${entries.length}件を読み取りました${skipped ? `(見出しなど ${skipped}行は読み込みません)` : ''}
      ${current ? `<br><span class="warn-text">今の一覧(${current}件)は置き換えます。買い物リストはそのままです。</span>` : ''}
    </p>
    <ul class="bk-list">
      ${sample
        .map(
          (e) => `
        <li class="bk-row">
          <span class="space">${esc(spaceLabel(e))}</span>
          <span class="bk-name">${esc(e.name)}${e.penName ? ` <small class="muted">${esc(e.penName)}</small>` : ''}</span>
          ${e.xHandle ? `<small class="bk-x">@${esc(e.xHandle)}</small>` : ''}
        </li>`,
        )
        .join('')}
      ${entries.length > sample.length ? `<li class="bk-row more">ほか ${entries.length - sample.length}件</li>` : ''}
    </ul>`;
}
