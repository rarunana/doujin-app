// public/ を dist/ にコピーし、オフライン用の Service Worker(dist/sw.js)を生成する。
// tsc が dist/js/ に出力した後に実行する(npm run build)。
import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

cpSync(join(root, 'public'), dist, { recursive: true });

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const files = walk(dist)
  .filter((p) => !p.endsWith(`${sep}sw.js`))
  .sort();

// 中身が1バイトでも変われば版が変わり、スマホ側のキャッシュが更新される
const hash = createHash('sha256');
for (const f of files) hash.update(readFileSync(f));
const version = hash.digest('hex').slice(0, 12);

const assets = ['./', ...files.map((f) => './' + relative(dist, f).split(sep).join('/'))];
const template = readFileSync(join(root, 'scripts', 'sw.template.js'), 'utf8');
const sw = template
  .replace('__VERSION__', version)
  .replace('__ASSETS__', JSON.stringify(assets, null, 2));

writeFileSync(join(dist, 'sw.js'), sw);
console.log(`dist/ を生成しました(${assets.length} ファイル, 版 ${version})`);
