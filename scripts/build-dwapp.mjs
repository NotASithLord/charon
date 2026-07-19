#!/usr/bin/env node
// scripts/build-dwapp.mjs — package Charon's pages as peerd dwapps.
//
// A peerd dwapp is a map of TEXT files with one entry HTML; peerd's engine
// composes it into a SINGLE document and document.write()s it into a
// sandboxed iframe with an OPAQUE origin (peerd: extension/peerd-engine/
// app-compose.js + engine-tabs/app-tab/runner.html). That runtime has:
//   - NO server and NO origin: relative fetches and relative ES-module
//     imports resolve against nothing and fail;
//   - inlining for <script src> / <link rel=stylesheet> that reference
//     bundled files (module scripts keep their type attribute);
//   - a CSP that allows inline scripts, eval, blob: workers, pointer lock.
//
// So a compatible app is: one entry HTML + ONE self-contained script with
// zero imports, and every binary asset carried as a data: URI. This script
// produces exactly that, per page, into dist/dwapp/<target>/:
//   index.html   — the page's own HTML with its module script pointed at
//                  bundle.js (still type="module": esbuild's esm output has
//                  no imports left, and an inline module script with no
//                  imports runs fine in the sandbox — this also keeps
//                  top-level await working, which the fused page uses)
//   bundle.js    — the whole module graph bundled flat; for the game, a
//                  generated prelude maps the rifle textures to data: URIs
//                  through THREE.DefaultLoadingManager.setURLModifier, so
//                  no game code changes and dev serving still works.
//
// peerd caps (extension/peerd-distributed/apps/loader.js): 256 files,
// 50,000,000 chars per app — printed against actuals at the end.

import { build } from 'esbuild';
import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'dwapp');
const TMP = join(ROOT, 'dist', '.dwapp-tmp');

const TARGETS = [
  { name: 'game', dir: 'game', assets: 'game/assets', title: 'HALO CHARON // GAME' },
  { name: 'sim', dir: 'sim', title: 'Halo Charon — Sim Harness' },
  { name: 'fused', dir: 'fused', title: 'Halo Charon — Fused' },
];

const dataUri = (bytes) => `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;

const buildTarget = async (t) => {
  const pageDir = join(ROOT, t.dir);
  const html = await readFile(join(pageDir, 'index.html'), 'utf8');

  // --- optional prelude: bake binary assets into the bundle and reroute
  // three.js loads to them. Keyed by the exact relative URLs the page uses
  // at runtime ('./assets/rifle/<name>.png' → 'assets/rifle/<name>.png').
  const entryLines = [];
  if (t.assets) {
    const assetDir = join(ROOT, t.assets);
    const names = (await readdir(assetDir, { recursive: true }))
      .map((n) => n.split('\\').join('/'))
      .filter((n) => n.endsWith('.png'));
    const map = {};
    for (const n of names) {
      map[`${t.assets.replace(`${t.dir}/`, '')}/${n}`] = dataUri(await readFile(join(assetDir, n)));
    }
    const prelude = [
      `import * as THREE from ${JSON.stringify(join(pageDir, 'vendor/three.module.js'))};`,
      `const ASSETS = ${JSON.stringify(map)};`,
      `const norm = (u) => String(u).replace(/^\\.\\//, '');`,
      `THREE.DefaultLoadingManager.setURLModifier((u) => ASSETS[norm(u)] ?? u);`,
    ].join('\n');
    const preludePath = join(TMP, `prelude-${t.name}.mjs`);
    await writeFile(preludePath, prelude);
    entryLines.push(`import ${JSON.stringify(preludePath)};`);
  }
  entryLines.push(`import ${JSON.stringify(join(pageDir, 'main.js'))};`);
  const entryPath = join(TMP, `entry-${t.name}.mjs`);
  await writeFile(entryPath, entryLines.join('\n'));

  const outDir = join(OUT, t.name);
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [entryPath],
    bundle: true,
    format: 'esm',       // no imports remain; inline module scripts need none
    charset: 'utf8',
    outfile: join(outDir, 'bundle.js'),
    logLevel: 'silent',
  });

  // --- entry HTML: same page, module script now points at the bundle ---
  const patched = html.replace(
    /<script\s+type="module"\s+src="\.\/main\.js"><\/script>/,
    '<script type="module" src="./bundle.js"></script>',
  );
  if (patched === html) throw new Error(`${t.name}: module script tag not found in index.html`);
  await writeFile(join(outDir, 'index.html'), patched);

  const bundle = await readFile(join(outDir, 'bundle.js'), 'utf8');
  const total = bundle.length + patched.length;
  console.log(`${t.name.padEnd(6)} 2 files, ${(total / 1e6).toFixed(2)}M chars` +
    ` (peerd caps: 256 files / 50M chars${total > 2_000_000 ? '; over the 2M agent-authoring cap — install via dweb/import' : ''})`);
  return { name: t.name, files: { 'index.html': patched, 'bundle.js': bundle } };
};

await rm(OUT, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
const results = [];
for (const t of TARGETS) results.push(await buildTarget(t));
await rm(TMP, { recursive: true, force: true });
console.log(`\nwrote ${results.length} dwapps under dist/dwapp/ — each folder is a complete app:`);
console.log('paste the two files into a peerd app (entry: index.html), or publish over the dweb.');
