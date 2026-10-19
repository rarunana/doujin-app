// サークルの一括登録: テキストの貼り付け / CSVファイルの読み込み。
// 読み取り結果を確認してから、まとめて追加する。

import { decodeText, fromColumns, fromComiketChecklist, guessColumns, isComiketChecklist, parseCsv } from '../csv.js';
import type { ColumnMap } from '../csv.js';
import { dayName, resolveDay } from '../dayResolve.js';
import { parseLines, spaceKey } from '../parseSpace.js';
import type { LineError, ParsedLine } from '../parseSpace.js';
import { addCircles, circlesOfEvent, currentEvent, selectDay, state } from '../store.js';
import type { CircleRec, DayRec, Priority } from '../types.js';
import { esc, spaceLabel, uid } from '../util.js';
import { closeDialog, openDialog, toast } from './dialog.js';

type Mode = 'text' | 'csv';

interface Planned {
  row: ParsedLine;
  day: DayRec;
  dayGuessed: boolean; // 日の指定が読めず、既定の日にした
  duplicate: boolean;
}

export async function openBulkDialog(mode: Mode): Promise<void> {
  const ev = currentEvent();
  if (!ev || state.days.length === 0) return;
  const existing = new Set((await circlesOfEvent()).map((c) => `${c.dayId}#${spaceKey(c)}`));

  const dayOptions = state.days
    .map((d, i) => `<option value="${esc(d.id)}"${d.id === state.dayId ? ' selected' : ''}>${esc(dayName(d, i))}</option>`)
    .join('');

  const input =
    mode === 'text'
      ? `<label class="field">1行に1サークル。配置番号とサークル名を書きます
           <textarea name="text" rows="6" placeholder="1日目 東ア-01a サークル名&#10;でらせるふ 5組16 @アカウント名&#10;たかはる 5組03,04"></textarea>
         </label>`
      : `<p class="note">コミケWebカタログのお気に入り(CSV)をそのまま読み込めます。<br>ほかのCSVは、どの列が何かを指定して読み込めます。</p>
         <label class="btn file-btn">CSVファイルを選ぶ
           <input type="file" accept=".csv,text/csv,text/plain" data-act="csv" hidden>
         </label>
         <div data-columns></div>`;

  openDialog(
    `
    <div class="sheet">
      <h2>${mode === 'text' ? 'テキストから一括登録' : 'CSVから一括登録'}</h2>
      ${input}
      <div class="field-row">
        <label class="field">日の指定がない行<select name="defaultDay">${dayOptions}</select></label>
        <label class="field">優先度<select name="priority"><option value="must">必須</option><option value="want">できれば</option></select></label>
      </div>
      <div data-result></div>
      <p class="error" data-error hidden></p>
      <div class="actions">
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="cancel">キャンセル</button>
        <button type="button" class="btn primary" data-act="add" disabled>追加</button>
      </div>
    </div>`,
    (root) => {
      const sheet = root.querySelector<HTMLElement>('.sheet')!;
      const resultEl = sheet.querySelector<HTMLElement>('[data-result]')!;
      const addBtn = sheet.querySelector<HTMLButtonElement>('[data-act=add]')!;
      const errorEl = sheet.querySelector<HTMLElement>('[data-error]')!;
      let parsed: { rows: ParsedLine[]; errors: LineError[] } = { rows: [], errors: [] };
      let plan: Planned[] = [];

      const refresh = (): void => {
        const fallback = state.days.find((d) => d.id === val('defaultDay')) ?? state.days[0];
        plan = buildPlan(parsed.rows, fallback, existing);
        resultEl.innerHTML = renderResult(plan, parsed.errors);
        const n = plan.filter((p) => !p.duplicate).length;
        addBtn.disabled = n === 0;
        addBtn.textContent = n ? `${n}件を追加` : '追加';
      };
      const val = (name: string): string =>
        sheet.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[name=${name}]`)?.value ?? '';
      const showError = (msg: string): void => {
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
      };

      // ---- テキスト ----
      const textarea = sheet.querySelector<HTMLTextAreaElement>('[name=text]');
      textarea?.addEventListener('input', () => {
        parsed = parseLines(textarea.value);
        refresh();
      });
      textarea?.focus();

      // ---- CSV ----
      let csvRows: string[][] = [];
      const columnsEl = sheet.querySelector<HTMLElement>('[data-columns]');
      const readColumns = (): ColumnMap => ({
        name: Number(val('colName')),
        space: Number(val('colSpace')),
        day: Number(val('colDay')),
        memo: Number(val('colMemo')),
        x: Number(val('colX')),
        pen: Number(val('colPen')),
        header: sheet.querySelector<HTMLInputElement>('[name=colHeader]')?.checked ?? false,
      });
      sheet.querySelector<HTMLInputElement>('[data-act=csv]')?.addEventListener('change', async (e) => {
        const inputEl = e.target as HTMLInputElement;
        const file = inputEl.files?.[0];
        inputEl.value = '';
        showError('');
        if (!file || !columnsEl) return;
        csvRows = parseCsv(decodeText(await file.arrayBuffer()));
        if (csvRows.length === 0) {
          showError('CSVに行がありません。');
          return;
        }
        if (isComiketChecklist(csvRows)) {
          columnsEl.innerHTML = `<p class="note small">${esc(file.name)}・コミケのお気に入り形式として読み込みました</p>`;
          parsed = fromComiketChecklist(csvRows);
        } else {
          columnsEl.innerHTML = renderColumnPicker(file.name, csvRows, guessColumns(csvRows));
          parsed = fromColumns(csvRows, readColumns());
        }
        refresh();
      });
      columnsEl?.addEventListener('change', () => {
        parsed = fromColumns(csvRows, readColumns());
        refresh();
      });

      sheet.querySelector('[name=defaultDay]')!.addEventListener('change', refresh);

      sheet.addEventListener('click', async (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
        if (!btn) return;
        if (btn.dataset.act === 'cancel') closeDialog();
        if (btn.dataset.act !== 'add') return;
        const targets = plan.filter((p) => !p.duplicate);
        if (targets.length === 0) return;
        const priority = val('priority') as Priority;
        const nextOrder = new Map<string, number>();
        const circles: CircleRec[] = targets.map((p) => {
          const order = (nextOrder.get(p.day.id) ?? 0) + 1;
          nextOrder.set(p.day.id, order);
          return {
            id: uid(),
            dayId: p.day.id,
            name: p.row.name,
            hall: p.row.hall,
            block: p.row.block,
            number: p.row.number,
            priority,
            order: 1000 + order, // 手で追加したものより後ろ(回る順番は動線機能で決める)
            memo: p.row.memo,
            ...(p.row.xHandle ? { xHandle: p.row.xHandle } : {}),
            ...(p.row.penName ? { penName: p.row.penName } : {}),
          };
        });
        try {
          await addCircles(circles);
          // 1日分だけなら、その日を表示する
          const days = new Set(circles.map((c) => c.dayId));
          if (days.size === 1 && !days.has(state.dayId ?? '')) await selectDay([...days][0]);
          closeDialog();
          toast(`${circles.length}件のサークルを追加しました`);
        } catch (err) {
          showError(`保存に失敗しました: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    },
  );
}

function buildPlan(rows: ParsedLine[], fallback: DayRec, existing: Set<string>): Planned[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const found = resolveDay(row.day, state.days);
    const day = found ?? fallback;
    const key = `${day.id}#${spaceKey(row)}`;
    const duplicate = existing.has(key) || seen.has(key);
    seen.add(key);
    return { row, day, dayGuessed: row.day !== null && !found, duplicate };
  });
}

function renderResult(plan: Planned[], errors: LineError[]): string {
  if (plan.length === 0 && errors.length === 0) return '';
  const idx = new Map(state.days.map((d, i) => [d.id, i]));
  const multiDay = state.days.length > 1;
  const rows = plan
    .map(
      (p) => `
      <li class="bk-row${p.duplicate ? ' dup' : ''}">
        ${multiDay ? `<span class="bk-day">${esc(dayName(p.day, idx.get(p.day.id) ?? 0))}</span>` : ''}
        <span class="space">${esc(spaceLabel(p.row))}</span>
        <span class="bk-name">${esc(p.row.name || '(名前なし)')}${p.row.xHandle ? ` <small class="bk-x">@${esc(p.row.xHandle)}</small>` : ''}</span>
        ${p.duplicate ? '<span class="badge">登録済み</span>' : ''}
        ${p.dayGuessed ? '<span class="badge warn">日が見つからない</span>' : ''}
      </li>`,
    )
    .join('');
  const dup = plan.filter((p) => p.duplicate).length;
  const guessed = plan.filter((p) => p.dayGuessed).length;
  return `
    <div class="bk-result">
      <p class="note">
        読み取り ${plan.length}件${dup ? `(うち登録済み ${dup}件は追加しません)` : ''}
        ${guessed ? `<br><span class="warn-text">日の指定が開催日と合わない行 ${guessed}件は「日の指定がない行」の日に追加します。</span>` : ''}
      </p>
      ${plan.length ? `<ul class="bk-list">${rows}</ul>` : ''}
      ${
        errors.length
          ? `<details class="bk-errors"><summary>読み取れなかった行 ${errors.length}件</summary>
               <ul>${errors.map((e) => `<li><small>${e.line}行目: ${esc(e.error)}</small>${esc(e.source)}</li>`).join('')}</ul>
             </details>`
          : ''
      }
    </div>`;
}

function renderColumnPicker(fileName: string, rows: string[][], map: ColumnMap): string {
  const head = rows[0] ?? [];
  const width = Math.max(...rows.slice(0, 20).map((r) => r.length));
  const label = (i: number): string => {
    const h = (head[i] ?? '').trim();
    return `${i + 1}列目${h ? `: ${h.length > 12 ? h.slice(0, 12) + '…' : h}` : ''}`;
  };
  const select = (name: string, current: number, required: boolean): string => {
    const opts = Array.from({ length: width }, (_, i) => `<option value="${i}"${i === current ? ' selected' : ''}>${esc(label(i))}</option>`);
    if (!required) opts.unshift(`<option value="-1"${current < 0 ? ' selected' : ''}>なし</option>`);
    return `<select name="${name}">${opts.join('')}</select>`;
  };
  return `
    <p class="note small">${esc(fileName)}・どの列が何かを指定してください</p>
    <div class="col-grid">
      <label class="field">配置番号${select('colSpace', Math.max(0, map.space), true)}</label>
      <label class="field">サークル名${select('colName', map.name, false)}</label>
      <label class="field">日${select('colDay', map.day, false)}</label>
      <label class="field">メモ${select('colMemo', map.memo, false)}</label>
      <label class="field">X(Twitter)${select('colX', map.x, false)}</label>
      <label class="field">ペンネーム${select('colPen', map.pen, false)}</label>
    </div>
    <label class="check-line"><input type="checkbox" name="colHeader"${map.header ? ' checked' : ''}>1行目は見出し(読み込まない)</label>`;
}
