#!/usr/bin/env node
// Bundles the browser-facing subset of peerd's audited room primitives for
// Charon's standalone web build. The peerd dwapp never loads this path at
// runtime because its trusted parent bridge owns the network.

import { build } from 'esbuild';
import { access, mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PEERD = resolve(process.env.PEERD_SOURCE || join(ROOT, '..', 'peerd'));
const EXTENSION = join(PEERD, 'extension');
const OUT = join(ROOT, 'multiplayer', 'peerd-browser.js');

await access(join(EXTENSION, 'peerd-distributed', 'index.js'));
await mkdir(dirname(OUT), { recursive: true });

await build({
  stdin: {
    contents: [
      "export { generateIdentity } from './peerd-distributed/identity/keypair.js';",
      "export { joinRoom } from './peerd-distributed/transport/rooms.js';",
      "export { createGossip } from './peerd-distributed/gossip/topic.js';",
      "export { createTopicSync, createMemoryTopicStore } from './peerd-distributed/gossip/sync.js';",
      "export { createPresence } from './peerd-distributed/gossip/presence.js';",
      "export { createDirect } from './peerd-distributed/messaging/direct.js';",
    ].join('\n'),
    resolveDir: EXTENSION,
    sourcefile: 'charon-peerd-browser-entry.js',
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  charset: 'utf8',
  outfile: OUT,
  legalComments: 'inline',
  plugins: [{
    name: 'peerd-extension-absolute-paths',
    setup(bundle) {
      bundle.onResolve({ filter: /^\/shared\// }, (args) => ({ path: join(EXTENSION, args.path.slice(1)) }));
    },
  }],
});

// Execute the browser-format module in Node as a no-DOM smoke test. This
// catches UMD/ESM wrapper mistakes that compile successfully but initialize an
// empty codec namespace when the retained-topic transport is imported.
const smoke = await import(`${pathToFileURL(OUT).href}?smoke=${Date.now()}`);
for (const name of [
  'generateIdentity', 'joinRoom', 'createGossip', 'createTopicSync',
  'createMemoryTopicStore', 'createPresence', 'createDirect',
]) {
  if (typeof smoke[name] !== 'function') throw new Error(`vendored browser primitive missing: ${name}`);
}

console.log(`bundled peerd browser primitives → ${OUT}`);
