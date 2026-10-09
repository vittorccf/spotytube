// Validação estática sem dependências: sintaxe, manifest, referências e imports.
// Uso: node tools/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');
const errors = [];
const fail = (m) => errors.push(m);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'keys', 'fixtures', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(root);
const jsFiles = files.filter((f) => /\.(m?js)$/.test(f));

// 1. sintaxe
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    fail(`sintaxe: ${rel(f)}: ${String(e.stderr).split('\n').slice(0, 4).join(' ')}`);
  }
}

// 2. manifest
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
} catch (e) {
  fail('manifest.json inválido: ' + e.message);
}
if (manifest) {
  const refs = [
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    manifest.background?.service_worker,
    ...(manifest.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ].filter(Boolean);
  for (const r of refs) if (!fs.existsSync(path.join(root, r))) fail(`manifest referencia arquivo inexistente: ${r}`);
  for (const [size, p] of Object.entries(manifest.icons || {})) {
    const buf = fs.readFileSync(path.join(root, p));
    const w = buf.readUInt32BE(16);
    if (buf.toString('ascii', 1, 4) !== 'PNG' || String(w) !== size) fail(`ícone ${p} não é PNG ${size}x${size}`);
  }
}

// 3. content script sem import / SW sem import()
for (const cs of (manifest?.content_scripts || []).flatMap((c) => c.js || [])) {
  const src = fs.readFileSync(path.join(root, cs), 'utf8');
  if (/^\s*(import|export)\s/m.test(src) || /\bimport\s*\(/.test(src)) fail(`content script usa import/export: ${cs}`);
}
for (const f of jsFiles.filter((x) => rel(x).startsWith('src/background/'))) {
  // ignora tipos JSDoc ({import('./x.js').T}) e comentários
  const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/(^|[^{\w.])import\s*\(/m.test(code)) fail(`import() dinâmico no SW: ${rel(f)}`);
}

// 4. imports relativos resolvem e os nomes importados existem
const exportsCache = new Map();
function exportsOf(file) {
  if (exportsCache.has(file)) return exportsCache.get(file);
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.add(n);
    }
  }
  exportsCache.set(file, names);
  return names;
}
for (const f of jsFiles.filter((x) => rel(x).startsWith('src/'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(f), m[2]);
    if (!fs.existsSync(target)) { fail(`${rel(f)}: import não resolve: ${m[2]}`); continue; }
    const spec = m[1].trim();
    const named = /\{([\s\S]*)\}/.exec(spec);
    if (!named) continue;
    const exp = exportsOf(target);
    for (const part of named[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0].trim();
      if (n && !exp.has(n)) fail(`${rel(f)}: '${n}' não é exportado por ${m[2]}`);
    }
  }
}

// 5. HTML: scripts e css existem
for (const f of files.filter((x) => x.endsWith('.html') && rel(x).startsWith('src/'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(?:src|href)="([^"#:]+\.(?:js|css))"/g)) {
    if (!fs.existsSync(path.resolve(path.dirname(f), m[1]))) fail(`${rel(f)}: referência quebrada ${m[1]}`);
  }
}

if (errors.length) {
  console.error(errors.map((e) => 'ERRO: ' + e).join('\n'));
  process.exit(1);
}
console.log(`ok: ${jsFiles.length} arquivos JS com sintaxe válida; manifest e referências ok`);
