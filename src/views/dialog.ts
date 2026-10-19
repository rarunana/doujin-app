// 画面下からせり上がる共通ダイアログ。

const dlg = (): HTMLDialogElement => document.getElementById('dlg') as HTMLDialogElement;

export function openDialog(html: string, onReady: (root: HTMLDialogElement) => void): void {
  const d = dlg();
  d.innerHTML = html;
  if (!d.open) d.showModal();
  onReady(d);
}

export function closeDialog(): void {
  const d = dlg();
  if (d.open) d.close();
  d.innerHTML = '';
}

/** 画面下に短いお知らせを出す */
export function toast(msg: string): void {
  document.querySelectorAll('.toast').forEach((t) => t.remove()); // 前のお知らせは消す
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

/** ファイルを端末に保存する(ダウンロード) */
export function download(file: File): void {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function val(root: ParentNode, selector: string): string {
  const el = root.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector);
  return el ? el.value.trim() : '';
}
