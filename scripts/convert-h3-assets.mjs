#!/usr/bin/env node
// scripts/convert-h3-assets.mjs — convert Halo 2/3 character source art
// (H3EK `data/` trees: ASCII JMS render meshes + TIF/DDS bitmaps) into the
// game's own formats: game/characters-data.js (indexed triangle groups,
// y-up, +X-forward, feet at y=0, scaled to meters) and
// game/assets/characters/*.png (diffuse textures, downscaled).
//
// Source: the Blackandfan H3EK-Tags repository (git), which carries the
// source art under Microsoft's Game Content Usage Rules for non-commercial
// fan projects — see game/assets/NOTICE.txt. Run with:
//   ASSET_SRC=/path/to/H3EK-Tags node scripts/convert-h3-assets.mjs
//
// JMS 8197-8213 layout (ASCII, ';'-comments): sections fenced by
// ';### NAME ###'. We read MATERIALS (name + scene string carrying the
// "(idx) [LOD] permutation region" tag), VERTICES (pos, normal, N node
// influences, M uv sets, vertex color) and TRIANGLES (material idx + 3
// vertex indices). A render JMS carries EVERY permutation overlaid
// (seven heads, dress uniform, wounded body…), so each model here picks
// ONE coherent permutation set by scene-tag substring match.

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import sharp from 'sharp';
import parseDDS from 'parse-dds';
import decodeDXT from 'decode-dxt';

const SRC = process.env.ASSET_SRC
  ?? '/tmp/claude-0/-home-user-charon/cd334a03-2a3d-52a1-bce5-b40f41cb13d9/scratchpad/h3ek-tags';
const BF = join(SRC, 'data/blackandfan');
const OUT_TEX = 'game/assets/characters';
const OUT_JS = 'game/characters-data.js';
const TEX_SIZE = 512;

// --- model recipes -----------------------------------------------------------
// keep(matName, scene) picks the permutation set; tex(matName) names the
// diffuse each kept material samples (one png per distinct name).
const MODELS = {
  // full-kit H2 marine: smith head, standard helmet + body, field packs
  marine: {
    jms: 'h2/marine/render/marine.JMS',
    height: 1.83,
    keep: (m, s) => (s.includes('standard body') && m.startsWith('marine_standard'))
      || (s.includes('on helmet') && m.startsWith('helmet_standard'))
      || (s.includes('smith head') && m.startsWith('head_'))
      || s.includes('on packs') || s.includes('on comm_pack'),
    tex: (m) => m.startsWith('comm_pack') ? 'comm_pack'
      : m.startsWith('packs') ? 'packs'
      : m.startsWith('helmet_standard') ? 'helmet_standard'
      : m.startsWith('head_') ? 'head_smith' : 'marine_standard',
  },
  // armed crew: female marine, bare head, no packs — reads as ship's crew
  crew_armed: {
    jms: 'h2/marine/marine_female/render/marine_female.JMS',
    height: 1.72,
    keep: (m, s) => (m.startsWith('marine_standard') && s.startsWith('(')) // female body/arms/legs
      || (s.includes('michelle head') && m.startsWith('head_female')),
    tex: (m) => m.startsWith('head_female') ? 'head_female' : 'marine_standard',
  },
  // unarmed civilians: male marine body without helmet or packs, morgan head
  civilian: {
    jms: 'h2/marine/render/marine.JMS',
    height: 1.78,
    keep: (m, s) => (s.includes('standard body') && m.startsWith('marine_standard'))
      || (s.includes('morgan head') && m.startsWith('head_')),
    tex: (m) => m.startsWith('head_') ? 'head_morgan' : 'marine_standard',
  },
  // H3 flood combat form, civilian host (the default risen form)
  combat_civ: {
    jms: 'characters/floodcombat_civilian/render/H3_FloodCombatCivilian.JMS',
    height: 1.95,
    keep: (m, s) => s.includes('base ') && m.startsWith('floodcombat_civilian'),
    tex: () => 'floodcombat_civilian',
  },
  // H3 flood combat form, ODST host (forms risen from armed hosts)
  combat_odst: {
    jms: 'characters/floodcombat_odst/render/H3_FloodCombatODST.JMS',
    height: 1.95,
    keep: (m, s) => (s.includes('base ') && m.startsWith('floodcombat_odst'))
      || (s.includes('base head') && m === 'odst_helmet'),
    tex: () => 'floodcombat_odst',
  },
  // H2 infection form (the solid body; the alpha membrane material is dropped)
  infection: {
    jms: 'h2/flood_infection/render/flood_infection.JMS',
    height: 0.75,
    keep: (m) => m === 'flood_infection',
    tex: () => 'flood_infection',
  },
};

const TEXTURES = {
  marine_standard: 'h2/marine/bitmaps/marine_standard.tif',
  helmet_standard: 'h2/marine/bitmaps/helmet_standard.tif',
  head_smith: 'h2/marine/bitmaps/head_smith.tif',
  head_morgan: 'h2/marine/bitmaps/head_morgan.tif',
  head_female: 'h2/marine/marine_female/bitmaps/head_female_mr.dds',
  packs: 'h2/marine/bitmaps/packs.tif',
  comm_pack: 'h2/marine/bitmaps/comm_pack.tif',
  floodcombat_civilian: 'characters/floodcombat_civilian/bitmaps/floodcombat_civilian_diffuse.dds',
  floodcombat_odst: 'characters/floodcombat_odst/bitmaps/floodcombat_odst.dds',
  flood_infection: 'h2/flood_infection/bitmaps/flood_infection.tif',
};

// --- JMS parsing -------------------------------------------------------------

const parseJMS = (text) => {
  const sections = {};
  const parts = text.split(/;###\s*([A-Z][A-Z _]*?)\s*###/);
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i].trim();
    const lines = parts[i + 1].split('\n')
      .map((l) => l.replace(/;.*$/, '').trim())
      .filter((l) => l.length);
    if (!(name in sections)) sections[name] = lines; // first VERTICES/TRIANGLES win
  }
  const mats = [];
  {
    const L = sections.MATERIALS;
    const n = parseInt(L[0], 10);
    for (let i = 0; i < n; i++) mats.push({ name: L[1 + i * 2], scene: L[2 + i * 2] });
  }
  const version = parseInt(sections.VERSION[0], 10);
  const verts = [];
  {
    const L = sections.VERTICES;
    let p = 0;
    const n = parseInt(L[p++], 10);
    for (let i = 0; i < n; i++) {
      const pos = L[p++].split(/\s+/).map(Number);
      const norm = L[p++].split(/\s+/).map(Number);
      const ni = parseInt(L[p++], 10);
      p += ni * 2;                               // node influences: index line + weight line each
      const nuv = parseInt(L[p++], 10);
      const uv = nuv > 0 ? L[p].split(/\s+/).map(Number) : [0, 0]; // first uv set
      p += nuv;
      if (version >= 8211) p++;                  // vertex color line
      verts.push({ pos, norm, uv });
    }
  }
  const tris = [];
  {
    const L = sections.TRIANGLES;
    let p = 0;
    const n = parseInt(L[p++], 10);
    for (let i = 0; i < n; i++) {
      const mat = parseInt(L[p++], 10);
      const idx = L[p++].split(/\s+/).map(Number);
      tris.push({ mat, idx });
    }
  }
  return { mats, verts, tris };
};

// z-up +x-forward (JMS) -> y-up +x-forward (three): (x, y, z) -> (x, z, -y)
const toThree = ([x, y, z]) => [x, z, -y];

const buildModel = (jms, recipe) => {
  const kept = new Map(); // material index -> texture key
  jms.mats.forEach((m, i) => {
    // strip the shader-flag suffix symbols H3EK packs into material names
    const clean = m.name.replace(/[%#?!@*$^=)(]+$/g, '');
    if (recipe.keep(clean, m.scene)) kept.set(i, recipe.tex(clean));
  });
  if (!kept.size) throw new Error('recipe kept no materials');

  // bbox over used vertices only (in three space)
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const used = new Set();
  for (const t of jms.tris) if (kept.has(t.mat)) for (const v of t.idx) used.add(v);
  for (const vi of used) {
    const [x, y, z] = toThree(jms.verts[vi].pos);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  const s = recipe.height / (maxY - minY);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;

  // group triangles by texture, reindex per group
  const groups = new Map();
  for (const t of jms.tris) {
    const tex = kept.get(t.mat);
    if (!tex) continue;
    let g = groups.get(tex);
    if (!g) groups.set(tex, (g = { remap: new Map(), pos: [], norm: [], uv: [], idx: [] }));
    for (const vi of t.idx) {
      let ri = g.remap.get(vi);
      if (ri === undefined) {
        ri = g.remap.size;
        g.remap.set(vi, ri);
        const v = jms.verts[vi];
        const [x, y, z] = toThree(v.pos);
        const [nx, ny, nz] = toThree(v.norm);
        g.pos.push(+(((x - cx) * s).toFixed(3)), +(((y - minY) * s).toFixed(3)), +(((z - cz) * s).toFixed(3)));
        g.norm.push(+nx.toFixed(2), +ny.toFixed(2), +nz.toFixed(2));
        g.uv.push(+v.uv[0].toFixed(4), +v.uv[1].toFixed(4));
      }
      g.idx.push(ri);
    }
  }
  return [...groups.entries()].map(([tex, g]) => ({ tex, pos: g.pos, norm: g.norm, uv: g.uv, idx: g.idx }));
};

// --- textures ----------------------------------------------------------------

const convertTexture = async (srcPath, outPath) => {
  if (srcPath.toLowerCase().endsWith('.dds')) {
    const buf = await readFile(srcPath);
    let rgba, w, h;
    const pfFlags = buf.readUInt32LE(80);
    if (pfFlags & 0x4) {
      // FourCC-compressed (DXT1/3/5)
      const dds = parseDDS(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const img = dds.images[0];
      [w, h] = img.shape;
      rgba = decodeDXT(new DataView(buf.buffer, buf.byteOffset + img.offset, img.length), w, h, dds.format);
    } else {
      // uncompressed masked RGB(A) — data starts right after the 128-byte header
      h = buf.readUInt32LE(12); w = buf.readUInt32LE(16);
      const bpp = buf.readUInt32LE(88) / 8;
      const masks = [buf.readUInt32LE(92), buf.readUInt32LE(96), buf.readUInt32LE(100), buf.readUInt32LE(104)];
      const shift = masks.map((m) => (m ? Math.log2(m & -m) : 0));
      rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const px = buf.readUIntLE(128 + i * bpp, bpp);
        for (let c = 0; c < 4; c++) {
          rgba[i * 4 + c] = masks[c] ? ((px & masks[c]) >>> shift[c]) & 0xff : 255;
        }
      }
    }
    await sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } })
      .removeAlpha().resize(TEX_SIZE, TEX_SIZE, { fit: 'inside' }).png({ palette: false }).toFile(outPath);
  } else {
    // the alpha channel is a spec/change-color mask, NOT coverage — strip it
    // without compositing (flattening through it washes the diffuse out)
    await sharp(srcPath).removeAlpha().resize(TEX_SIZE, TEX_SIZE, { fit: 'inside' })
      .png({ palette: false }).toFile(outPath);
  }
};

// --- main --------------------------------------------------------------------

await mkdir(OUT_TEX, { recursive: true });
const out = {};
for (const [name, recipe] of Object.entries(MODELS)) {
  const jms = parseJMS(await readFile(join(BF, recipe.jms), 'utf8'));
  const groups = buildModel(jms, recipe);
  const tris = groups.reduce((n, g) => n + g.idx.length / 3, 0);
  const vertsN = groups.reduce((n, g) => n + g.pos.length / 3, 0);
  out[name] = { height: recipe.height, groups };
  console.log(`${name.padEnd(12)} ${String(vertsN).padStart(6)} verts ${String(tris).padStart(6)} tris  groups: ${groups.map((g) => g.tex).join(', ')}`);
}
for (const [key, rel] of Object.entries(TEXTURES)) {
  await convertTexture(join(BF, rel), join(OUT_TEX, `${key}.png`));
}
const js = '// GENERATED by scripts/convert-h3-assets.mjs — do not edit.\n'
  + '// Halo 2 / Halo 3 character meshes converted from H3EK source art\n'
  + '// (JMS render models), carried under Microsoft\'s Game Content Usage\n'
  + '// Rules for non-commercial fan projects — see assets/NOTICE.txt.\n'
  + '// Units: meters; y-up; +X-forward; feet at y=0; indexed triangles.\n'
  + `export const CHARACTERS = ${JSON.stringify(out)};\n`;
await writeFile(OUT_JS, js);
console.log(`wrote ${OUT_JS} (${(js.length / 1e6).toFixed(2)}M chars) + ${Object.keys(TEXTURES).length} textures in ${OUT_TEX}/`);
