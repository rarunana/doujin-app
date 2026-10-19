// データ画面: JSONファイルへの書き出しと読み込み(バックアップ、PC→スマホ反映)。

import { backupFileName, parseBackup } from '../backup.js';
import type { Backup } from '../backup.js';
import { diffWithCatalog } from '../catalog.js';
import type { CatalogDiff } from '../catalog.js';
import { dayName } from '../dayResolve.js';
import { circlesOfEvent, clearCatalog, currentEvent, exportData, hasMaps, importData, state } from '../store.js';
import type { ImportMode } from '../store.js';
import { esc, spaceLabel } from '../util.js';
import { openBulkDialog } from './bulkDialog.js';
import { openCatalogImport } from './catalogImportDialog.js';
import { openCatalogPicker } from './catalogPickDialog.js';
import { closeDialog, download, openDialog, toast } from './dialog.js';

const LAST_EXPORT_KEY = 'doujin-shopping:lastExport';

export async function openDataDialog(): Promise<void> {
  const ev = currentEvent();
  const diffs = ev && state.catalog.length ? diffWithCatalog(await circlesOfEvent(), state.catalog) : [];
  const anyMaps = state.events.length ? await hasMaps(state.events.map((e) => e.id)) : false;
  const canShare = typeof navigator.share === 'function' && typeof navigator.canShare === 'function';

  const exportPart = state.events.length
    ? `
      <section class="data-sec">
        <h3>書き出し</h3>
        <p class="note">バックアップや、別の端末へデータを移すときに使います。</p>
        <div class="radios stack">
          ${ev ? `<label class="radio"><input type="radio" name="scope" value="current" checked>このイベント(${esc(ev.name)})</label>` : ''}
          <label class="radio"><input type="radio" name="scope" value="all"${ev ? '' : ' checked'}>すべてのイベント(${state.events.length}件)</label>
        </div>
        ${
          anyMaps
            ? `<label class="check-line"><input type="checkbox" name="withMaps" checked>会場図の画像も含める(ファイルが大きくなります)</label>`
            : ''
        }
        <div class="btn-row">
          ${canShare ? '<button type="button" class="btn primary" data-act="share">共有・保存…</button>' : ''}
          <button type="button" class="btn${canShare ? '' : ' primary'}" data-act="download">ダウンロード</button>
        </div>
        <p class="note small">${lastExportText()}</p>
      </section>`
    : '';

  const bulkPart = ev
    ? `
      <section class="data-sec">
        <h3>サークルの一括登録</h3>
        <p class="note">「${esc(ev.name)}」に、配置番号の一覧やカタログのCSVからまとめて追加します。</p>
        <div class="btn-row">
          <button type="button" class="btn" data-act="bulk-text">テキストを貼り付け</button>
          <button type="button" class="btn" data-act="bulk-csv">CSVを読み込む</button>
        </div>
      </section>`
    : '';

  const catalogPart = ev ? renderCatalogPart(diffs) : '';

  openDialog(
    `
    <div class="sheet">
      <h2>データ</h2>
      ${catalogPart}
      ${bulkPart}
      ${exportPart}
      <section class="data-sec">
        <h3>読み込み</h3>
        <p class="note">書き出したファイル(.json)を選ぶと、内容を確認してから取り込みます。</p>
        <label class="btn file-btn">ファイルを選ぶ
          <input type="file" accept=".json,application/json" data-act="file" hidden>
        </label>
        <div data-preview></div>
      </section>
      <p class="error" data-error hidden></p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close">閉じる</button>
      </div>
    </div>`,
    (root) => {
      const sheet = root.querySelector<HTMLElement>('.sheet')!;
      const errorEl = sheet.querySelector<HTMLElement>('[data-error]')!;
      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
      };

      const buildFile = async (): Promise<File> => {
        const scope = sheet.querySelector<HTMLInputElement>('[name=scope]:checked')?.value;
        const withMaps = sheet.querySelector<HTMLInputElement>('[name=withMaps]')?.checked ?? false;
        const data = await exportData(scope === 'current' && ev ? [ev.id] : undefined, withMaps);
        const name = backupFileName(scope === 'current' && ev ? ev.name : 'すべて');
        return new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
      };

      sheet.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        showError('');
        try {
          switch (btn.dataset.act) {
            case 'download': {
              download(await buildFile());
              markExported(sheet);
              break;
            }
            case 'share': {
              const file = await buildFile();
              if (!navigator.canShare({ files: [file] })) {
                download(file); // 共有できない形式なら通常のダウンロードに切り替える
              } else {
                await navigator.share({ files: [file], title: file.name });
              }
              markExported(sheet);
              break;
            }
            case 'import': {
              const pending = previewData;
              if (!pending) return;
              const mode = (sheet.querySelector<HTMLInputElement>('[name=mode]:checked')?.value ?? 'replace') as ImportMode;
              await importData(pending, mode);
              closeDialog();
              toast(`${pending.events.length}件のイベントを読み込みました`);
              break;
            }
            case 'catalog-import':
              openCatalogImport();
              break;
            case 'catalog-pick':
              openCatalogPicker();
              break;
            case 'catalog-clear':
              if (confirm('サークル一覧を削除しますか?(買い物リストはそのまま残ります)')) {
                await clearCatalog();
                closeDialog();
                toast('サークル一覧を削除しました');
              }
              break;
            case 'bulk-text':
              await openBulkDialog('text');
              break;
            case 'bulk-csv':
              await openBulkDialog('csv');
              break;
            case 'close':
              closeDialog();
              break;
          }
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return; // 共有をキャンセルした
          console.error(err);
          showError(`失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      let previewData: Backup | null = null;
      sheet.querySelector<HTMLInputElement>('[data-act=file]')!.addEventListener('change', async (e) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = ''; // 同じファイルを選び直せるように
        previewData = null;
        const preview = sheet.querySelector<HTMLElement>('[data-preview]')!;
        preview.innerHTML = '';
        showError('');
        if (!file) return;
        const result = parseBackup(await file.text());
        if (!result.ok) {
          showError(result.error);
          return;
        }
        previewData = result.data;
        preview.innerHTML = renderPreview(file.name, result.data, result.dropped);
      });
    },
  );
}

/** サークル一覧(カタログ)の欄 */
function renderCatalogPart(diffs: CatalogDiff[]): string {
  const ev = currentEvent()!;
  const n = state.catalog.length;
  if (n === 0) {
    return `
      <section class="data-sec">
        <h3>サークル一覧</h3>
        <p class="note">イベント公式サイトのサークル一覧を取り込むと、名前などで検索してすぐ追加できます。</p>
        <button type="button" class="btn primary wide" data-act="catalog-import">一覧を取り込む</button>
      </section>`;
  }
  const perDay =
    state.days.length > 1
      ? state.days
          .map((d, i) => `${esc(dayName(d, i))} ${state.catalog.filter((c) => c.dayId === d.id).length}件`)
          .join(' / ')
      : `${n}件`;
  const info = ev.catalogInfo;
  const when = info ? new Date(info.importedAt) : null;
  const stamp = when ? `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}` : '';
  return `
    <section class="data-sec">
      <h3>サークル一覧</h3>
      <p class="note">${perDay}${stamp ? `・${stamp}に取り込み` : ''}${info?.source ? `(${esc(info.source)})` : ''}</p>
      ${diffs.length ? renderDiffs(diffs) : ''}
      <button type="button" class="btn primary wide" data-act="catalog-pick">一覧から選んで追加</button>
      <div class="btn-row" style="margin-top:8px">
        <button type="button" class="btn" data-act="catalog-import">取り込み直す</button>
        <button type="button" class="btn danger" data-act="catalog-clear">一覧を削除</button>
      </div>
    </section>`;
}

/** 買い物リストのサークルのうち、一覧と配置が違う・一覧に無いもの(自動では直さない) */
function renderDiffs(diffs: CatalogDiff[]): string {
  const rows = diffs
    .map(
      (d) => `
      <li><span class="space">${esc(spaceLabel(d.circle))}</span> ${esc(d.circle.name || '(名前なし)')}
        <small>${d.kind === 'moved' ? `一覧では ${esc(spaceLabel(d.entry!))}` : '一覧に見つかりません'}</small></li>`,
    )
    .join('');
  return `
    <details class="diff-box"${diffs.length <= 5 ? ' open' : ''}>
      <summary>一覧と違うサークル ${diffs.length}件</summary>
      <ul>${rows}</ul>
      <p class="note small">配置の変更や欠席の可能性があります。必要なら各サークルの編集画面で直してください。</p>
    </details>`;
}

function renderPreview(fileName: string, b: Backup, dropped: number): string {
  const existing = new Set(state.events.map((e) => e.id));
  const overlap = b.events.filter((e) => existing.has(e.id));
  const rows = b.events
    .map((e) => {
      const dayIds = new Set(b.days.filter((d) => d.eventId === e.id).map((d) => d.id));
      const circles = b.circles.filter((c) => dayIds.has(c.dayId)).length;
      const items = b.items.filter((i) => dayIds.has(i.dayId)).length;
      const tag = existing.has(e.id) ? '<span class="badge warn">同じイベントあり</span>' : '<span class="badge new">新規</span>';
      const maps = (b.maps ?? []).filter((m) => m.eventId === e.id).length;
      const cat = (b.catalog ?? []).filter((x) => x.eventId === e.id).length;
      const extra = `${cat ? `・一覧${cat}件` : ''}${maps ? `・会場図${maps}枚` : ''}`;
      return `<li><strong>${esc(e.name)}</strong>${tag}<small>${dayIds.size}日・${circles}サークル・頒布物${items}件${extra}</small></li>`;
    })
    .join('');

  const modeChoice = overlap.length
    ? `
      <div class="radios stack">
        <label class="radio"><input type="radio" name="mode" value="replace" checked>
          <span>置き換える<small>この端末の${overlap.map((e) => `「${esc(e.name)}」`).join('')}を、購入チェックも含めてファイルの内容にします</small></span></label>
        <label class="radio"><input type="radio" name="mode" value="copy">
          <span>別のイベントとして追加<small>今のデータは残し、名前に「(コピー)」を付けて追加します</small></span></label>
      </div>`
    : '<input type="hidden" name="mode" value="replace">';

  return `
    <div class="preview">
      <p class="note small">${esc(fileName)}${b.exportedAt ? `・${esc(formatStamp(b.exportedAt))} に書き出し` : ''}</p>
      <ul class="pv-list">${rows}</ul>
      ${dropped ? `<p class="note small warn-text">壊れていたデータ ${dropped}件は読み込みません。</p>` : ''}
      ${modeChoice}
      <button type="button" class="btn primary wide" data-act="import">読み込む</button>
    </div>`;
}

function markExported(sheet: HTMLElement): void {
  try {
    localStorage.setItem(LAST_EXPORT_KEY, new Date().toISOString());
  } catch {
    /* 記録できなくても書き出し自体は成功している */
  }
  const note = sheet.querySelector('.data-sec .note.small');
  if (note) note.textContent = lastExportText();
}

function lastExportText(): string {
  let iso: string | null = null;
  try {
    iso = localStorage.getItem(LAST_EXPORT_KEY);
  } catch {
    /* 読めなければ未記録扱い */
  }
  return iso ? `この端末での前回の書き出し: ${formatStamp(iso)}` : 'この端末ではまだ書き出していません。';
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
