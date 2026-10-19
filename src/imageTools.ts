// 会場図の画像の下ごしらえ。大きすぎる画像はスマホで重くなる(落ちる)ので縮小する。

// iPhone の Safari はキャンバスの面積に上限がある(約1600万画素)。長辺も 4096px までにそろえる
const MAX_SIDE = 4096;
const MAX_AREA = 16_000_000;

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  resized: boolean;
}

export async function prepareMapImage(file: Blob): Promise<PreparedImage> {
  const img = await loadImage(file);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) throw new Error('画像を読み込めませんでした。');
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h), Math.sqrt(MAX_AREA / (w * h)));
  if (scale >= 1) return { blob: file, width: w, height: h, resized: false };

  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('画像を縮小できませんでした。');
  ctx.fillStyle = '#fff'; // 透明部分は白に(JPEGは透明を持てないため)
  ctx.fillRect(0, 0, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, cw, ch);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
  if (!blob) throw new Error('画像を縮小できませんでした。');
  return { blob, width: cw, height: ch, resized: true };
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('この画像は読み込めません。PNG・JPEG などの画像を選んでください。'));
    };
    img.src = url;
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('画像データが壊れています。');
  const type = m[1] || 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(m[3])], { type });
  const bin = atob(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
