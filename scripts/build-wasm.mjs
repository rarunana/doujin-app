// cpp/route.cpp を WebAssembly(public/route.wasm)にコンパイルする。
// npm run build:wasm で実行。C++ を直したときだけ必要(route.wasm はリポジトリに入れてあるので、
// 普段の npm run build ではコンパイラは要らない)。
//
// 使うコンパイラ(見つかった方):
//   1. clang(wasm32 に対応したもの。Linux / WSL / macOS の clang、Windows の LLVM)
//   2. Emscripten(emcc)
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'cpp', 'route.cpp');
const out = join(root, 'public', 'route.wasm');

const common = ['-O2', '-std=c++17', '-fno-exceptions', '-fno-rtti'];
const candidates = [
  {
    name: 'clang',
    cmd: process.platform === 'win32' ? 'clang++.exe' : 'clang++',
    args: ['--target=wasm32', ...common, '-nostdlib', '-Wl,--no-entry', '-o', out, src],
  },
  {
    name: 'Emscripten',
    cmd: process.platform === 'win32' ? 'emcc.bat' : 'emcc',
    args: [...common, '--no-entry', '-sSTANDALONE_WASM', '-sERROR_ON_UNDEFINED_SYMBOLS=1', '-o', out, src],
  },
];

for (const c of candidates) {
  try {
    execFileSync(c.cmd, c.args, { stdio: 'inherit' });
    console.log(`${c.name} でコンパイルしました: public/route.wasm (${statSync(out).size} バイト)`);
    process.exit(0);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`${c.name} でのコンパイルに失敗しました`);
      process.exit(1);
    }
  }
}
console.error('clang++ も emcc も見つかりません。どちらかを入れてから実行してください(README の「動線の計算(C++)」)。');
process.exit(1);
