/**
 * fix-weapons-final.mjs
 *
 * Properly bakes ALL node transforms (translation + rotation + scale)
 * into vertex data for each weapon, then:
 *   - Ensures barrel along −Z, sights along +Y
 *   - Centres grip at origin
 *   - Scales to target metric size
 *   - Ensures 'Metal' material exists
 *
 * Usage:  node tools/fix-weapons-final.mjs
 */

import { NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEAPONS_DIR = path.resolve(__dirname, '../wwwroot/assets/models/weapons');

/* ================================================================== */
/*  Config per weapon                                                  */
/* ================================================================== */

const WEAPONS = {
  rifle: { targetLength: 0.55, gripZ: 0.45, gripY: 0.25 },
  shotgun: { targetLength: 0.5, gripZ: 0.45, gripY: 0.25 },
  pistol: { targetLength: 0.22, gripZ: 0.55, gripY: 0.3 },
};

/* ================================================================== */
/*  Quaternion / Matrix helpers                                        */
/* ================================================================== */

function quatToMat3(q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

function mulMat3(a, b) {
  const r = new Array(9);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      r[row * 3 + col] =
        a[row * 3] * b[col] +
        a[row * 3 + 1] * b[3 + col] +
        a[row * 3 + 2] * b[6 + col];
    }
  }
  return r;
}

function scaleMat3(s) {
  return [s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]];
}

function applyMat3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Build a 3×3 rotation+scale matrix and translation from a node's TRS.
 * Returns { mat3, t } where t is the translation vector.
 */
function nodeTransform(node) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  const rotM = quatToMat3(r);
  const scaleM = scaleMat3(s);
  const mat3 = mulMat3(rotM, scaleM); // rotation * scale
  return { mat3, t };
}

/**
 * Compose parent transform with child transform.
 * parent: { mat3, t }, child: { mat3, t }
 * Result: combined { mat3, t } so that v_world = parentMat3 * (childMat3 * v + childT) + parentT
 */
function composeTransforms(parent, child) {
  return {
    mat3: mulMat3(parent.mat3, child.mat3),
    t: [
      parent.mat3[0] * child.t[0] +
        parent.mat3[1] * child.t[1] +
        parent.mat3[2] * child.t[2] +
        parent.t[0],
      parent.mat3[3] * child.t[0] +
        parent.mat3[4] * child.t[1] +
        parent.mat3[5] * child.t[2] +
        parent.t[1],
      parent.mat3[6] * child.t[0] +
        parent.mat3[7] * child.t[1] +
        parent.mat3[8] * child.t[2] +
        parent.t[2],
    ],
  };
}

/**
 * Walk the scene hierarchy and collect { node, worldTransform } for each mesh node.
 */
function collectMeshTransforms(sceneNode) {
  const identity = { mat3: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  const results = [];

  function walk(node, parentXform) {
    const localXform = nodeTransform(node);
    const worldXform = composeTransforms(parentXform, localXform);

    if (node.getMesh()) {
      results.push({ node, worldXform });
    }

    for (const child of node.listChildren()) {
      walk(child, worldXform);
    }
  }

  for (const child of sceneNode.listChildren()) {
    walk(child, identity);
  }

  return results;
}

/* ================================================================== */
/*  Geometry helpers                                                   */
/* ================================================================== */

function measureBBox(positions) {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      if (positions[i + a] < mn[a]) mn[a] = positions[i + a];
      if (positions[i + a] > mx[a]) mx[a] = positions[i + a];
    }
  }
  return {
    min: mn,
    max: mx,
    size: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]],
  };
}

/* ================================================================== */
/*  Main pipeline                                                      */
/* ================================================================== */

async function main() {
  const io = new NodeIO();
  console.log('Final weapon fix — baking all transforms...\n');

  for (const [name, cfg] of Object.entries(WEAPONS)) {
    const filePath = path.join(WEAPONS_DIR, `${name}.glb`);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ ${name}.glb not found`);
      continue;
    }

    console.log(`━━━ ${name} ━━━`);
    const doc = await io.read(filePath);
    const scene = doc.getRoot().listScenes()[0];

    // 1. Collect all mesh nodes with their accumulated world transforms
    const meshInfos = collectMeshTransforms(scene);
    console.log(`  Found ${meshInfos.length} mesh node(s)`);

    // 2. Bake world transform into each mesh's vertices, then reset node TRS
    const allPositions = []; // collect for global bbox
    for (const { node, worldXform } of meshInfos) {
      const mesh = node.getMesh();
      for (const prim of mesh.listPrimitives()) {
        const posAcc = prim.getAttribute('POSITION');
        if (posAcc) {
          const arr = posAcc.getArray();
          for (let i = 0; i < arr.length; i += 3) {
            const v = applyMat3(worldXform.mat3, [
              arr[i],
              arr[i + 1],
              arr[i + 2],
            ]);
            arr[i] = v[0] + worldXform.t[0];
            arr[i + 1] = v[1] + worldXform.t[1];
            arr[i + 2] = v[2] + worldXform.t[2];
          }
          posAcc.setArray(arr);
          allPositions.push(arr);
        }

        const normAcc = prim.getAttribute('NORMAL');
        if (normAcc) {
          const arr = normAcc.getArray();
          for (let i = 0; i < arr.length; i += 3) {
            const v = applyMat3(worldXform.mat3, [
              arr[i],
              arr[i + 1],
              arr[i + 2],
            ]);
            const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1;
            arr[i] = v[0] / len;
            arr[i + 1] = v[1] / len;
            arr[i + 2] = v[2] / len;
          }
          normAcc.setArray(arr);
        }
      }
    }

    // Reset ALL node transforms to identity
    for (const node of doc.getRoot().listNodes()) {
      node.setTranslation([0, 0, 0]);
      node.setRotation([0, 0, 0, 1]);
      node.setScale([1, 1, 1]);
    }

    // 3. Measure the baked bbox
    const combined = new Float32Array(
      allPositions.reduce((s, a) => s + a.length, 0),
    );
    let offset = 0;
    for (const arr of allPositions) {
      combined.set(arr, offset);
      offset += arr.length;
    }
    let bb = measureBBox(combined);
    console.log(
      `  Baked bbox: X=[${bb.min[0].toFixed(4)},${bb.max[0].toFixed(4)}] Y=[${bb.min[1].toFixed(4)},${bb.max[1].toFixed(4)}] Z=[${bb.min[2].toFixed(4)},${bb.max[2].toFixed(4)}]`,
    );
    console.log(
      `  Size: X=${bb.size[0].toFixed(4)} Y=${bb.size[1].toFixed(4)} Z=${bb.size[2].toFixed(4)}`,
    );

    // 4. Determine which axis is the barrel (longest)
    const longestIdx = bb.size.indexOf(Math.max(...bb.size));
    const axisNames = ['X', 'Y', 'Z'];
    console.log(
      `  Longest axis: ${axisNames[longestIdx]} = ${bb.size[longestIdx].toFixed(4)}`,
    );

    // 5. Rotate so barrel → −Z and height → +Y if needed
    // We need: longest axis → Z (barrel), and the "height" → Y
    // For all these weapons, after baking the transforms with the Blender
    // -90° X rotation, the barrel should be identifiable.
    // Strategy: rotate so longest axis aligns with Z, second-longest with Y.
    const sortedAxes = [0, 1, 2].sort((a, b) => bb.size[b] - bb.size[a]);
    const barrelAxis = sortedAxes[0]; // longest
    const heightAxis = sortedAxes[1]; // second longest
    // const widthAxis = sortedAxes[2]; // shortest

    // Build rotation matrix to map barrelAxis→Z, heightAxis→Y, remaining→X
    // This is essentially a permutation + possible sign flips
    let needsRotation = barrelAxis !== 2 || heightAxis !== 1;

    if (needsRotation) {
      // Build permutation: we want axis[barrelAxis] → Z, axis[heightAxis] → Y
      const widthAxis = sortedAxes[2];
      // rotation matrix: new_col[i] = old unit vector[permutation[i]]
      // new X = old widthAxis, new Y = old heightAxis, new Z = old barrelAxis
      const mat3 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
      mat3[0 * 3 + widthAxis] = 1; // new X = old widthAxis
      mat3[1 * 3 + heightAxis] = 1; // new Y = old heightAxis
      mat3[2 * 3 + barrelAxis] = 1; // new Z = old barrelAxis

      // Apply to all vertices
      const seen = new Set();
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const prim of mesh.listPrimitives()) {
          for (const attr of ['POSITION', 'NORMAL']) {
            const acc = prim.getAttribute(attr);
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
      console.log(
        `  Rotated: ${axisNames[widthAxis]}→X, ${axisNames[heightAxis]}→Y, ${axisNames[barrelAxis]}→Z`,
      );
    }

    // 6. Re-measure
    {
      const allPos2 = [];
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const prim of mesh.listPrimitives()) {
          const acc = prim.getAttribute('POSITION');
          if (acc) allPos2.push(acc.getArray());
        }
      }
      const c2 = new Float32Array(allPos2.reduce((s, a) => s + a.length, 0));
      let o2 = 0;
      for (const a of allPos2) {
        c2.set(a, o2);
        o2 += a.length;
      }
      bb = measureBBox(c2);
    }

    // 7. Ensure barrel points −Z (muzzle at most negative Z)
    // If more of the weapon is at −Z already, it's probably correct.
    // We check if the CG of Z is positive (stock-heavy → barrel at −Z) ✓
    // Otherwise flip 180° around Y
    const zCenter = (bb.min[2] + bb.max[2]) / 2;
    // The muzzle end should have more extent in −Z direction
    // If center > 0, most mass is toward +Z → barrel likely at −Z ✓
    // If center < 0, barrel might be at +Z — flip
    // (This heuristic works for these models where grip is roughly centered)

    // Heuristic: decide muzzle side by comparing XY spread at each Z extreme (muzzle is thinner).
    // If the +Z end is the thinner end, flip the entire mesh so muzzle → -Z.
    {
      const positions = [];
      let pMinZ = Infinity,
        pMaxZ = -Infinity;
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const prim of mesh.listPrimitives()) {
          const pAcc = prim.getAttribute('POSITION');
          if (!pAcc) continue;
          const arr = pAcc.getArray();
          for (let i = 0; i < arr.length; i += 3) {
            const x = arr[i],
              y = arr[i + 1],
              z = arr[i + 2];
            positions.push([x, y, z]);
            if (z < pMinZ) pMinZ = z;
            if (z > pMaxZ) pMaxZ = z;
          }
        }
      }

      const tol = Math.max((pMaxZ - pMinZ) * 0.03, 1e-6);
      const boxFor = (check) => {
        let minX = Infinity,
          maxX = -Infinity,
          minY = Infinity,
          maxY = -Infinity,
          count = 0;
        for (const [x, y, z] of positions) {
          if (check(z)) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            count++;
          }
        }
        return { minX, maxX, minY, maxY, count };
      };

      const minSide = boxFor((z) => z <= pMinZ + tol);
      const maxSide = boxFor((z) => z >= pMaxZ - tol);
      if (minSide.count > 0 && maxSide.count > 0) {
        const minArea =
          (minSide.maxX - minSide.minX) * (minSide.maxY - minSide.minY) ||
          Infinity;
        const maxArea =
          (maxSide.maxX - maxSide.minX) * (maxSide.maxY - maxSide.minY) ||
          Infinity;
        if (maxArea < minArea) {
          console.log(
            '  Detected muzzle on +Z (thinner end) — flipping 180° around Y',
          );
          const flipped = new Set();
          for (const node of doc.getRoot().listNodes()) {
            const mesh = node.getMesh();
            if (!mesh) continue;
            for (const prim of mesh.listPrimitives()) {
              for (const attrName of ['POSITION', 'NORMAL']) {
                const acc = prim.getAttribute(attrName);
                if (!acc || flipped.has(acc)) continue;
                flipped.add(acc);
                const arr = acc.getArray();
                for (let i = 0; i < arr.length; i += 3) {
                  arr[i] = -arr[i]; // -X
                  arr[i + 2] = -arr[i + 2]; // -Z
                }
                acc.setArray(arr);
              }
            }
          }
          // Recompute bbox after flip so subsequent operations are correct
          const postPos = [];
          for (const node of doc.getRoot().listNodes()) {
            const mesh = node.getMesh();
            if (!mesh) continue;
            for (const prim of mesh.listPrimitives()) {
              const pAcc = prim.getAttribute('POSITION');
              if (pAcc) postPos.push(pAcc.getArray());
            }
          }
          const combinedPost = new Float32Array(
            postPos.reduce((s, a) => s + a.length, 0),
          );
          let off = 0;
          for (const a of postPos) {
            combinedPost.set(a, off);
            off += a.length;
          }
          bb = measureBBox(combinedPost);
        }
      }
    }

    // 8. Centre grip at origin and scale
    const gripX = (bb.min[0] + bb.max[0]) / 2;
    const gripY = bb.min[1] + cfg.gripY * bb.size[1];
    const gripZ = bb.min[2] + cfg.gripZ * bb.size[2];

    const scaleFactor = cfg.targetLength / bb.size[2]; // Z is barrel axis

    // Apply translate + scale to all vertices
    const seen2 = new Set();
    for (const node of doc.getRoot().listNodes()) {
      const mesh = node.getMesh();
      if (!mesh) continue;
      for (const prim of mesh.listPrimitives()) {
        const acc = prim.getAttribute('POSITION');
        if (!acc || seen2.has(acc)) continue;
        seen2.add(acc);
        const arr = acc.getArray();
        for (let i = 0; i < arr.length; i += 3) {
          arr[i] = (arr[i] - gripX) * scaleFactor;
          arr[i + 1] = (arr[i + 1] - gripY) * scaleFactor;
          arr[i + 2] = (arr[i + 2] - gripZ) * scaleFactor;
        }
        acc.setArray(arr);
      }
    }

    // 9. Final verification
    {
      const allPos3 = [];
      for (const node of doc.getRoot().listNodes()) {
        const mesh = node.getMesh();
        if (!mesh) continue;
        for (const prim of mesh.listPrimitives()) {
          const acc = prim.getAttribute('POSITION');
          if (acc) allPos3.push(acc.getArray());
        }
      }
      const c3 = new Float32Array(allPos3.reduce((s, a) => s + a.length, 0));
      let o3 = 0;
      for (const a of allPos3) {
        c3.set(a, o3);
        o3 += a.length;
      }
      const fbb = measureBBox(c3);
      console.log(
        `  Final: X=[${fbb.min[0].toFixed(4)},${fbb.max[0].toFixed(4)}] Y=[${fbb.min[1].toFixed(4)},${fbb.max[1].toFixed(4)}] Z=[${fbb.min[2].toFixed(4)},${fbb.max[2].toFixed(4)}]`,
      );
      console.log(
        `  Size:  X=${fbb.size[0].toFixed(4)} Y=${fbb.size[1].toFixed(4)} Z=${fbb.size[2].toFixed(4)}`,
      );
    }

    // 10. Ensure 'Metal' material
    const materials = doc.getRoot().listMaterials();
    if (!materials.some((m) => m.getName() === 'Metal')) {
      const candidates = ['Gray', 'Silver', 'Body', 'DarkMetal'];
      let best = null;
      for (const mat of materials) {
        for (const c of candidates) {
          if (mat.getName().toLowerCase().includes(c.toLowerCase())) {
            best = mat;
            break;
          }
        }
        if (best) break;
      }
      if (!best) best = materials[0];
      if (best) {
        console.log(`  Renamed "${best.getName()}" → "Metal"`);
        best.setName('Metal');
      }
    }

    // 11. Save
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
