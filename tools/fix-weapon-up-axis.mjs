/**
 * fix-weapon-up-axis.mjs
 *
 * Fixes shotgun and pistol orientation after barrel normalization.
 * These models had their height along X instead of Y (lying on side).
 * Applies Rz(+90°) to stand them upright, then re-centres grip.
 *
 * Usage:  node tools/fix-weapon-up-axis.mjs
 */

import { NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEAPONS_DIR = path.resolve(__dirname, '../wwwroot/assets/models/weapons');

function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Rotate all geometry + node translations by mat3. */
function rotateAll(doc, mat3) {
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation();
    node.setTranslation(applyMat3(mat3, t));

    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      for (const attrName of ['POSITION', 'NORMAL']) {
        const acc = prim.getAttribute(attrName);
        if (!acc || seen.has(acc)) continue;
        seen.add(acc);
        const arr = acc.getArray();
        for (let i = 0; i < arr.length; i += 3) {
          const v = applyMat3(mat3, [arr[i], arr[i + 1], arr[i + 2]]);
          arr[i] = v[0];
          arr[i + 1] = v[1];
          arr[i + 2] = v[2];
        }
        acc.setArray(arr);
      }
    }
  }
}

/** Translate all vertex positions + node translations. */
function translateAll(doc, offset) {
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation();
    node.setTranslation([t[0] + offset[0], t[1] + offset[1], t[2] + offset[2]]);

    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc || seen.has(acc)) continue;
      seen.add(acc);
      const arr = acc.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] += offset[0];
        arr[i + 1] += offset[1];
        arr[i + 2] += offset[2];
      }
      acc.setArray(arr);
    }
  }
}

/** Measure bounding box. */
function measureBBox(doc) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc) continue;
      const arr = acc.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (arr[i + a] < mn[a]) mn[a] = arr[i + a];
          if (arr[i + a] > mx[a]) mx[a] = arr[i + a];
        }
      }
    }
  }
  return {
    min: mn,
    max: mx,
    size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
  };
}

// Rz(+90°): X → Y, Y → −X, Z unchanged
// Matrix rows: [0, -1, 0,  1, 0, 0,  0, 0, 1]
const Rz90 = [0, -1, 0, 1, 0, 0, 0, 0, 1];

async function main() {
  const io = new NodeIO();

  for (const name of ['shotgun', 'pistol']) {
    const filePath = path.join(WEAPONS_DIR, `${name}.glb`);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ ${name}.glb not found`);
      continue;
    }

    console.log(`━━━ ${name} ━━━`);
    const doc = await io.read(filePath);

    let bb = measureBBox(doc);
    console.log(
      `  Before: X=[${bb.min[0].toFixed(4)},${bb.max[0].toFixed(4)}] Y=[${bb.min[1].toFixed(4)},${bb.max[1].toFixed(4)}] Z=[${bb.min[2].toFixed(4)},${bb.max[2].toFixed(4)}]`,
    );
    console.log(
      `  Size before: X=${bb.size[0].toFixed(4)} Y=${bb.size[1].toFixed(4)} Z=${bb.size[2].toFixed(4)}`,
    );

    // Rotate 90° around Z to fix up-axis
    rotateAll(doc, Rz90);

    bb = measureBBox(doc);
    console.log(
      `  After Rz90: X=[${bb.min[0].toFixed(4)},${bb.max[0].toFixed(4)}] Y=[${bb.min[1].toFixed(4)},${bb.max[1].toFixed(4)}] Z=[${bb.min[2].toFixed(4)},${bb.max[2].toFixed(4)}]`,
    );
    console.log(
      `  Size after: X=${bb.size[0].toFixed(4)} Y=${bb.size[1].toFixed(4)} Z=${bb.size[2].toFixed(4)}`,
    );

    // Re-centre grip: X centred, Y at bottom 30%, Z unchanged
    const gripX = (bb.min[0] + bb.max[0]) / 2;
    const gripY = bb.min[1] + 0.3 * bb.size[1];
    translateAll(doc, [-gripX, -gripY, 0]);

    bb = measureBBox(doc);
    console.log(
      `  Final: X=[${bb.min[0].toFixed(4)},${bb.max[0].toFixed(4)}] Y=[${bb.min[1].toFixed(4)},${bb.max[1].toFixed(4)}] Z=[${bb.min[2].toFixed(4)},${bb.max[2].toFixed(4)}]`,
    );

    const glb = await io.writeBinary(doc);
    fs.writeFileSync(filePath, glb);
    console.log(
      `  ✔ Saved ${name}.glb  (${(glb.byteLength / 1024).toFixed(1)} KB)\n`,
    );
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error('Fix failed:', err);
  process.exit(1);
});
