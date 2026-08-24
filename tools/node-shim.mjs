// Подключает fflate в globalThis, чтобы модули из src/ работали в Node так же, как в браузере.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'vendor', 'fflate.umd.js'), 'utf8');
const mod = { exports: {} };
new Function('module', 'exports', src)(mod, mod.exports);
globalThis.fflate = mod.exports;
export const REG = process.env.REG || path.join(here, 'testdata', 'registry.xlsx');
export const TPL = process.env.TPL || path.join(here, 'testdata', 'template.xlsx');
export const bytes = (p) => new Uint8Array(readFileSync(p));
