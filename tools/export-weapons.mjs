/**
 * export-weapons.mjs
 *
 * Generates GLB files for each weapon type (rifle, shotgun, pistol)
 * using @gltf-transform/core — the industry-standard Node.js glTF library.
 *
 * Usage:  node tools/export-weapons.mjs
 * Output: wwwroot/assets/models/weapons/{rifle,shotgun,pistol}.glb
 */

import { Document, NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../wwwroot/assets/models/weapons');

/* ================================================================== */
/*  Geometry helpers                                                   */
/* ================================================================== */

/**
 * Box mesh — 6 faces, 24 vertices with normals.
 */
function boxGeometry(w, h, d) {
  const hw = w / 2,
    hh = h / 2,
    hd = d / 2;

  // prettier-ignore
  const positions = new Float32Array([
    // +X face
     hw, -hh, -hd,   hw,  hh, -hd,   hw,  hh,  hd,   hw, -hh,  hd,
    // -X face
    -hw, -hh,  hd,  -hw,  hh,  hd,  -hw,  hh, -hd,  -hw, -hh, -hd,
    // +Y face
    -hw,  hh,  hd,   hw,  hh,  hd,   hw,  hh, -hd,  -hw,  hh, -hd,
    // -Y face
    -hw, -hh, -hd,   hw, -hh, -hd,   hw, -hh,  hd,  -hw, -hh,  hd,
    // +Z face
    -hw, -hh,  hd,   hw, -hh,  hd,   hw,  hh,  hd,  -hw,  hh,  hd,
    // -Z face
     hw, -hh, -hd,  -hw, -hh, -hd,  -hw,  hh, -hd,   hw,  hh, -hd,
  ]);

  // prettier-ignore
  const normals = new Float32Array([
     1, 0, 0,   1, 0, 0,   1, 0, 0,   1, 0, 0,
    -1, 0, 0,  -1, 0, 0,  -1, 0, 0,  -1, 0, 0,
     0, 1, 0,   0, 1, 0,   0, 1, 0,   0, 1, 0,
     0,-1, 0,   0,-1, 0,   0,-1, 0,   0,-1, 0,
     0, 0, 1,   0, 0, 1,   0, 0, 1,   0, 0, 1,
     0, 0,-1,   0, 0,-1,   0, 0,-1,   0, 0,-1,
  ]);

  // prettier-ignore
  const indices = new Uint16Array([
     0, 1, 2,   0, 2, 3,
     4, 5, 6,   4, 6, 7,
     8, 9,10,   8,10,11,
    12,13,14,  12,14,15,
    16,17,18,  16,18,19,
    20,21,22,  20,22,23,
  ]);

  return { positions, normals, indices };
}

/**
 * Cylinder mesh — N-sided, along Y axis.
 */
function cylinderGeometry(radiusTop, radiusBottom, height, segments) {
  const hh = height / 2;
  const posArr = [];
  const normArr = [];
  const idxArr = [];
  let vi = 0;

  // Side quads
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0),
      s0 = Math.sin(a0);
    const c1 = Math.cos(a1),
      s1 = Math.sin(a1);

    posArr.push(
      c0 * radiusBottom,
      -hh,
      s0 * radiusBottom,
      c1 * radiusBottom,
      -hh,
      s1 * radiusBottom,
      c1 * radiusTop,
      hh,
      s1 * radiusTop,
      c0 * radiusTop,
      hh,
      s0 * radiusTop,
    );
    normArr.push(c0, 0, s0, c1, 0, s1, c1, 0, s1, c0, 0, s0);
    idxArr.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
    vi += 4;
  }

  // Top cap
  const topC = vi;
  posArr.push(0, hh, 0);
  normArr.push(0, 1, 0);
  vi++;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    posArr.push(Math.cos(a) * radiusTop, hh, Math.sin(a) * radiusTop);
    normArr.push(0, 1, 0);
    vi++;
  }
  for (let i = 0; i < segments; i++) {
    idxArr.push(topC, topC + 1 + i, topC + 1 + ((i + 1) % segments));
  }

  // Bottom cap
  const botC = vi;
  posArr.push(0, -hh, 0);
  normArr.push(0, -1, 0);
  vi++;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    posArr.push(Math.cos(a) * radiusBottom, -hh, Math.sin(a) * radiusBottom);
    normArr.push(0, -1, 0);
    vi++;
  }
  for (let i = 0; i < segments; i++) {
    idxArr.push(botC, botC + 1 + ((i + 1) % segments), botC + 1 + i);
  }

  return {
    positions: new Float32Array(posArr),
    normals: new Float32Array(normArr),
    indices: new Uint16Array(idxArr),
  };
}

/* ================================================================== */
/*  glTF node builder                                                  */
/* ================================================================== */

/**
 * Euler XYZ → quaternion [x, y, z, w].
 */
function eulerToQuat(rx, ry, rz) {
  const cx = Math.cos(rx / 2),
    sx = Math.sin(rx / 2);
  const cy = Math.cos(ry / 2),
    sy = Math.sin(ry / 2);
  const cz = Math.cos(rz / 2),
    sz = Math.sin(rz / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

function addPart(doc, geo, material, name, pos, rot) {
  const buffer = doc.getRoot().listBuffers()[0];

  const posAcc = doc
    .createAccessor(name + '_pos')
    .setType('VEC3')
    .setArray(geo.positions)
    .setBuffer(buffer);
  const normAcc = doc
    .createAccessor(name + '_norm')
    .setType('VEC3')
    .setArray(geo.normals)
    .setBuffer(buffer);
  const idxAcc = doc
    .createAccessor(name + '_idx')
    .setType('SCALAR')
    .setArray(geo.indices)
    .setBuffer(buffer);

  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', posAcc)
    .setAttribute('NORMAL', normAcc)
    .setIndices(idxAcc)
    .setMaterial(material);

  const mesh = doc.createMesh(name).addPrimitive(prim);

  const node = doc.createNode(name).setMesh(mesh).setTranslation(pos);

  if (rot) node.setRotation(eulerToQuat(...rot));

  return node;
}

/* ================================================================== */
/*  Weapon definitions                                                 */
/* ================================================================== */

function buildWeaponDoc(weaponName, buildFn) {
  const doc = new Document();
  const buffer = doc.createBuffer('data');
  const scene = doc.createScene(weaponName);

  // PBR materials — neutral base colour, tinted at runtime via weaponSkin
  const metal = doc
    .createMaterial('Metal')
    .setBaseColorFactor([0.53, 0.53, 0.53, 1.0])
    .setMetallicFactor(0.8)
    .setRoughnessFactor(0.3);
  const grip = doc
    .createMaterial('Grip')
    .setBaseColorFactor([0.227, 0.227, 0.227, 1.0])
    .setMetallicFactor(0.2)
    .setRoughnessFactor(0.9);
  const accent = doc
    .createMaterial('Accent')
    .setBaseColorFactor([0.533, 0.267, 0.0, 1.0])
    .setMetallicFactor(0.1)
    .setRoughnessFactor(0.8);

  const root = doc.createNode(weaponName);
  scene.addChild(root);

  buildFn(doc, root, metal, grip, accent);
  return doc;
}

/*
 * INDUSTRY STANDARD layout:
 *   - Origin at grip centre (for trivial bone attachment)
 *   - Barrel along −Z (forward in glTF right-hand coords)
 *   - Y-up
 *   - 1 unit = 1 metre  (real-world dimensions)
 *
 * Real-world reference lengths (barrel tip → stock end):
 *   Rifle  ≈ 0.90 m
 *   Shotgun ≈ 1.00 m
 *   Pistol ≈ 0.22 m
 *
 * All positions are relative to grip centre at [0,0,0].
 */

// Grip offset: parts were authored with grip at [0, -0.08, 0.16].
// Shift everything by [0, +0.08, −0.16] so grip lands at origin.
const GRP = [0, 0.08, -0.16]; // negated grip position

function buildRifle(doc, root, metal, grip, accent) {
  const g = GRP;
  root.addChild(
    addPart(doc, boxGeometry(0.06, 0.07, 0.45), metal, 'Receiver', [
      0 + g[0],
      0 + g[1],
      0 + g[2],
    ]),
  );
  root.addChild(
    addPart(
      doc,
      cylinderGeometry(0.012, 0.015, 0.35, 8),
      metal,
      'Barrel',
      [0 + g[0], 0.015 + g[1], -0.38 + g[2]],
      [Math.PI / 2, 0, 0],
    ),
  );
  root.addChild(
    addPart(
      doc,
      cylinderGeometry(0.018, 0.012, 0.06, 8),
      metal,
      'Muzzle',
      [0 + g[0], 0.015 + g[1], -0.58 + g[2]],
      [Math.PI / 2, 0, 0],
    ),
  );
  root.addChild(
    addPart(
      doc,
      boxGeometry(0.04, 0.12, 0.06),
      grip,
      'Magazine',
      [0 + g[0], -0.09 + g[1], 0.05 + g[2]],
      [0.1, 0, 0],
    ),
  );
  root.addChild(
    addPart(
      doc,
      boxGeometry(0.04, 0.1, 0.04),
      grip,
      'Grip',
      [0 + g[0], -0.08 + g[1], 0.16 + g[2]],
      [-0.3, 0, 0],
    ),
  ); // Grip now at origin
  root.addChild(
    addPart(doc, boxGeometry(0.05, 0.06, 0.15), accent, 'Stock', [
      0 + g[0],
      0 + g[1],
      0.28 + g[2],
    ]),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.035, 0.025, 0.01), metal, 'RearSight', [
      0 + g[0],
      0.055 + g[1],
      0.08 + g[2],
    ]),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.01, 0.025, 0.01), metal, 'FrontSight', [
      0 + g[0],
      0.055 + g[1],
      -0.18 + g[2],
    ]),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.055, 0.05, 0.15), accent, 'Handguard', [
      0 + g[0],
      -0.01 + g[1],
      -0.15 + g[2],
    ]),
  );
}

// Shotgun grip was at [0, -0.08, 0.14] — shift [0, +0.08, −0.14]
const GRPS = [0, 0.08, -0.14];

function buildShotgun(doc, root, metal, grip, accent) {
  const g = GRPS;
  root.addChild(
    addPart(doc, boxGeometry(0.07, 0.08, 0.4), metal, 'Receiver', [
      0 + g[0],
      0 + g[1],
      0 + g[2],
    ]),
  );
  root.addChild(
    addPart(
      doc,
      cylinderGeometry(0.018, 0.022, 0.25, 8),
      metal,
      'Barrel',
      [0 + g[0], 0.015 + g[1], -0.3 + g[2]],
      [Math.PI / 2, 0, 0],
    ),
  );
  root.addChild(
    addPart(
      doc,
      cylinderGeometry(0.025, 0.018, 0.04, 8),
      metal,
      'Muzzle',
      [0 + g[0], 0.015 + g[1], -0.44 + g[2]],
      [Math.PI / 2, 0, 0],
    ),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.06, 0.08, 0.12), grip, 'Forend', [
      0 + g[0],
      -0.06 + g[1],
      -0.08 + g[2],
    ]),
  );
  root.addChild(
    addPart(
      doc,
      boxGeometry(0.04, 0.1, 0.04),
      grip,
      'Grip',
      [0 + g[0], -0.08 + g[1], 0.14 + g[2]],
      [-0.3, 0, 0],
    ),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.06, 0.07, 0.18), accent, 'Stock', [
      0 + g[0],
      0 + g[1],
      0.26 + g[2],
    ]),
  );
}

// Pistol grip was at [0, -0.07, 0.06] — shift [0, +0.07, −0.06]
const GRPP = [0, 0.07, -0.06];

function buildPistol(doc, root, metal, grip, _accent) {
  const g = GRPP;
  root.addChild(
    addPart(doc, boxGeometry(0.05, 0.06, 0.2), metal, 'Slide', [
      0 + g[0],
      0 + g[1],
      0 + g[2],
    ]),
  );
  root.addChild(
    addPart(
      doc,
      cylinderGeometry(0.01, 0.012, 0.15, 8),
      metal,
      'Barrel',
      [0 + g[0], 0.01 + g[1], -0.16 + g[2]],
      [Math.PI / 2, 0, 0],
    ),
  );
  root.addChild(
    addPart(
      doc,
      boxGeometry(0.035, 0.09, 0.04),
      grip,
      'Grip',
      [0 + g[0], -0.07 + g[1], 0.06 + g[2]],
      [-0.2, 0, 0],
    ),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.008, 0.02, 0.008), metal, 'FrontSight', [
      0 + g[0],
      0.05 + g[1],
      -0.06 + g[2],
    ]),
  );
  root.addChild(
    addPart(doc, boxGeometry(0.025, 0.02, 0.008), metal, 'RearSight', [
      0 + g[0],
      0.05 + g[1],
      0.06 + g[2],
    ]),
  );
}

/* ================================================================== */
/*  Main                                                               */
/* ================================================================== */

async function main() {
  console.log('Exporting weapon models to GLB...\n');
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const io = new NodeIO();

  const weapons = [
    { name: 'Rifle', fn: buildRifle, file: 'rifle.glb' },
    { name: 'Shotgun', fn: buildShotgun, file: 'shotgun.glb' },
    { name: 'Pistol', fn: buildPistol, file: 'pistol.glb' },
  ];

  for (const { name, fn, file } of weapons) {
    const doc = buildWeaponDoc(name, fn);
    const glb = await io.writeBinary(doc);
    const outPath = path.join(OUT_DIR, file);
    fs.writeFileSync(outPath, glb);
    const sizeKB = (glb.byteLength / 1024).toFixed(1);
    console.log(`  ✔ ${file}  (${sizeKB} KB)`);
  }

  console.log(`\nDone! Files written to:\n  ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});
