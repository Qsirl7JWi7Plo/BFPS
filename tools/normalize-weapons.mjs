/**
 * normalize-weapons.mjs
 *
 * Processes downloaded weapon GLBs:
 *  1. Bakes any node scale into vertex positions and normals
 *  2. Rotates geometry so barrel points along −Z (glTF forward)
 *  3. Centers grip at origin
 *  4. Scales to real-world metric size
 *  5. Ensures a 'Metal' material exists for runtime skin colouring
 *
 * Usage:  node tools/normalize-weapons.mjs
 */

import { NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEAPONS_DIR = path.resolve(__dirname, '../wwwroot/assets/models/weapons');

/* ================================================================== */
/*  Weapon-specific config                                             */
/* ================================================================== */

/*
 * targetLength:  desired total length in metres (tip-to-stock).
 * barrelAxis:    which local axis currently points along the barrel.
 * barrelSign:    +1 if barrel points in positive direction, −1 if negative.
 *                After rotation barrel will face −Z.
 * gripFractionZ: how far along the barrel axis (0 = muzzle, 1 = stock)
 *                the grip centre is.  We shift the model so this point
 *                sits at Z = 0 (origin).
 * gripFractionY: vertical fraction (0 = bottom, 1 = top) of the grip.
 *                We shift the model so this point sits at Y = 0.
 */
const WEAPONS = {
  rifle: {
    targetLength: 0.55,
    barrelAxis: 'z', // Z is longest (4.63 m raw)
    barrelSign: -1, // barrel points −Z (glTF standard already)
    gripFractionZ: 0.45, // grip about 45 % from muzzle end
    gripFractionY: 0.25, // bottom quarter of Y range
  },
  shotgun: {
    targetLength: 0.5,
    barrelAxis: 'x', // X is longest at 100× scale (5.78 m)
    barrelSign: +1, // assume barrel at +X
    gripFractionZ: 0.45,
    gripFractionY: 0.25,
  },
  pistol: {
    targetLength: 0.22,
    barrelAxis: 'x', // X is longest at 100× scale (1.82 m)
    barrelSign: +1,
    gripFractionZ: 0.55, // grip more toward stock
    gripFractionY: 0.3,
  },
};

/* ================================================================== */
/*  Helpers                                                            */
/* ================================================================== */

/**
 * Bake a node's scale into vertex positions and normals for all primitives
 * of its mesh.  Also scales the node's translation and resets its scale.
 */
function bakeNodeScale(node) {
  const s = node.getScale();
  if (s[0] === 1 && s[1] === 1 && s[2] === 1) return;

  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (posAcc) {
        const arr = posAcc.getArray();
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] *= s[0];
          arr[i + 1] *= s[1];
          arr[i + 2] *= s[2];
        }
        posAcc.setArray(arr);
      }
      // Normals need inverse scale to stay unit-length (we will normalize)
      const normAcc = prim.getAttribute('NORMAL');
      if (normAcc) {
        const arr = normAcc.getArray();
        const inv = [1 / s[0], 1 / s[1], 1 / s[2]];
        for (let i = 0; i < arr.length; i += 3) {
          let nx = arr[i] * inv[0],
            ny = arr[i + 1] * inv[1],
            nz = arr[i + 2] * inv[2];
          const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          arr[i] = nx / len;
          arr[i + 1] = ny / len;
          arr[i + 2] = nz / len;
        }
        normAcc.setArray(arr);
      }
    }
  }

  // Scale translation, reset scale
  const t = node.getTranslation();
  node.setTranslation([t[0] * s[0], t[1] * s[1], t[2] * s[2]]);
  node.setScale([1, 1, 1]);
}

/**
 * Measure the bounding box across ALL mesh vertices in the document.
 */
function measureBBox(doc) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const arr = posAcc.getArray();
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

/**
 * Apply a 3×3 rotation matrix to all POSITION and NORMAL accessors.
 * Also transform node translations.
 */
function rotateAllGeometry(doc, mat3) {
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    // Rotate translations
    const t = node.getTranslation();
    const nt = applyMat3(mat3, t);
    node.setTranslation(nt);

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

function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Translate all vertex positions and node translations by [dx, dy, dz].
 */
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

/**
 * Scale all vertex positions and node translations uniformly.
 */
function scaleAll(doc, factor) {
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation();
    node.setTranslation([t[0] * factor, t[1] * factor, t[2] * factor]);

    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const acc = prim.getAttribute('POSITION');
      if (!acc || seen.has(acc)) continue;
      seen.add(acc);
      const arr = acc.getArray();
      for (let i = 0; i < arr.length; i++) arr[i] *= factor;
      acc.setArray(arr);
    }
  }
}

/* ================================================================== */
/*  Main pipeline                                                      */
/* ================================================================== */

async function main() {
  const io = new NodeIO();
  console.log('Normalizing weapon GLBs...\n');

  for (const [name, cfg] of Object.entries(WEAPONS)) {
    const filePath = path.join(WEAPONS_DIR, `${name}.glb`);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ ${name}.glb not found — skipping`);
      continue;
    }

    console.log(`━━━ ${name} ━━━`);
    const doc = await io.read(filePath);

    // 1. Bake any node scales
    for (const node of doc.getRoot().listNodes()) {
      bakeNodeScale(node);
    }
    let bb = measureBBox(doc);
    console.log(
      `  After scale bake: [${bb.size.map((v) => v.toFixed(4)).join(', ')}]`,
    );

    // 2. Rotate so barrel → −Z
    const axIdx = { x: 0, y: 1, z: 2 }[cfg.barrelAxis];
    if (cfg.barrelAxis !== 'z') {
      // Rotation matrix: barrel axis → −Z
      // If barrelAxis = 'x' and barrelSign = +1: +X → −Z
      //   This is a +90° rotation around Y
      //   Ry(+90°): [ cos90  0  sin90 ] = [ 0  0  1 ]
      //             [   0    1    0   ]   [ 0  1  0 ]
      //             [-sin90  0  cos90 ] = [-1  0  0 ]
      // If barrelSign = -1: −X → −Z
      //   This is a -90° rotation around Y
      let mat3;
      if (cfg.barrelSign > 0) {
        // +X → −Z:  Ry(+90°)
        mat3 = [0, 0, 1, 0, 1, 0, -1, 0, 0];
      } else {
        // −X → −Z:  Ry(−90°)
        mat3 = [0, 0, -1, 0, 1, 0, 1, 0, 0];
      }
      rotateAllGeometry(doc, mat3);
      console.log(
        `  Rotated ${cfg.barrelAxis.toUpperCase()}${cfg.barrelSign > 0 ? '+' : '−'} → −Z`,
      );
    } else if (cfg.barrelSign > 0) {
      // +Z → −Z: rotate 180° around Y
      rotateAllGeometry(doc, [-1, 0, 0, 0, 1, 0, 0, 0, -1]);
      console.log(`  Rotated +Z → −Z (180° Y)`);
    } else {
      console.log(`  Already −Z barrel — no rotation`);
    }

    // 3. Measure again after rotation
    bb = measureBBox(doc);
    console.log(
      `  After rotation: X=[${bb.min[0].toFixed(4)},${bb.max[0].toFixed(4)}] Y=[${bb.min[1].toFixed(4)},${bb.max[1].toFixed(4)}] Z=[${bb.min[2].toFixed(4)},${bb.max[2].toFixed(4)}]`,
    );

    // 4. Centre grip at origin
    //    gripFractionZ: 0 = muzzle (most −Z), 1 = stock (most +Z)
    const gripZ = bb.min[2] + cfg.gripFractionZ * bb.size[2];
    const gripY = bb.min[1] + cfg.gripFractionY * bb.size[1];
    const gripX = (bb.min[0] + bb.max[0]) / 2; // centred L-R
    translateAll(doc, [-gripX, -gripY, -gripZ]);
    console.log(
      `  Centred grip at origin (shifted [${(-gripX).toFixed(4)}, ${(-gripY).toFixed(4)}, ${(-gripZ).toFixed(4)}])`,
    );

    // 5. Scale to target length
    //    After rotation, Z is barrel axis; bb.size[2] is the barrel length
    const currentLength = bb.size[2]; // Z extent after rotation
    const scaleFactor = cfg.targetLength / currentLength;
    scaleAll(doc, scaleFactor);
    console.log(
      `  Scaled ${currentLength.toFixed(4)} → ${cfg.targetLength} m  (factor ${scaleFactor.toFixed(6)})`,
    );

    // 6. Verify final bbox
    const finalBB = measureBBox(doc);
    console.log(
      `  Final bbox: X=[${finalBB.min[0].toFixed(4)},${finalBB.max[0].toFixed(4)}] Y=[${finalBB.min[1].toFixed(4)},${finalBB.max[1].toFixed(4)}] Z=[${finalBB.min[2].toFixed(4)},${finalBB.max[2].toFixed(4)}]`,
    );
    console.log(`  Final size: ${finalBB.size.map((v) => v.toFixed(4))}`);

    // 7. Ensure a 'Metal' material exists for runtime skin colouring
    const materials = doc.getRoot().listMaterials();
    const hasMetal = materials.some((m) => m.getName() === 'Metal');
    if (!hasMetal) {
      // Pick the most appropriate material to rename
      // For the rifle: "Gray_AssaultRIfle_01" is the metallic grey body
      const candidates = ['Gray', 'Silver', 'Metal', 'DarkMetal', 'Body'];
      let best = null;
      for (const mat of materials) {
        const n = mat.getName().toLowerCase();
        for (const c of candidates) {
          if (n.includes(c.toLowerCase())) {
            best = mat;
            break;
          }
        }
        if (best) break;
      }
      if (!best) best = materials[0]; // fallback: first material
      if (best) {
        console.log(`  Renamed material "${best.getName()}" → "Metal"`);
        best.setName('Metal');
      }
    } else {
      console.log(`  'Metal' material already present`);
    }

    // 8. Write back
    const glb = await io.writeBinary(doc);
    fs.writeFileSync(filePath, glb);
    console.log(
      `  ✔ Saved ${name}.glb  (${(glb.byteLength / 1024).toFixed(1)} KB)\n`,
    );
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error('Normalization failed:', err);
  process.exit(1);
});
