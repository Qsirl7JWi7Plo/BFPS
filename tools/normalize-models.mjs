/**
 * normalize-models.mjs
 *
 * Industry-standard model pipeline:
 * Reads character GLBs, measures bounding box, bakes a uniform scale into
 * every mesh's vertex positions so the exported model is exactly the target
 * height. This follows the glTF specification convention of 1 unit = 1 meter.
 *
 * After running this tool, game code can use `scale(1,1,1)` — no magic numbers.
 *
 * Usage:  node tools/normalize-models.mjs
 */

import { NodeIO } from '@gltf-transform/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHAR_DIR = path.resolve(__dirname, '../wwwroot/assets/models/characters');

const TARGET_HEIGHT = 1.8; // metres — standard human height

/**
 * Measure the Y-extent of every mesh in the document, returning { minY, maxY }.
 * Accounts for node translations so we get the world-space bounding box.
 */
function measureHeight(doc) {
  let minY = Infinity,
    maxY = -Infinity;

  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    const t = node.getTranslation(); // [x, y, z]
    const s = node.getScale(); // [sx, sy, sz]

    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const arr = posAcc.getArray();
      for (let i = 1; i < arr.length; i += 3) {
        const y = arr[i] * (s ? s[1] : 1) + (t ? t[1] : 0);
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minY, maxY, height: maxY - minY };
}

/**
 * Bake a uniform scale into all mesh vertex positions and adjust node
 * translations accordingly.  After this the document's geometry is at
 * real-world metric scale.
 */
function bakeScale(doc, scaleFactor) {
  // Scale every accessor tagged as POSITION
  const seen = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;

    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc || seen.has(posAcc)) continue;
      seen.add(posAcc);

      const arr = posAcc.getArray();
      for (let i = 0; i < arr.length; i++) {
        arr[i] *= scaleFactor;
      }
      posAcc.setArray(arr);

      // Update min/max
      posAcc.setNormalized(false);
    }

    // Scale the node's own translation
    const t = node.getTranslation();
    if (t) {
      node.setTranslation([
        t[0] * scaleFactor,
        t[1] * scaleFactor,
        t[2] * scaleFactor,
      ]);
    }
  }

  // Also scale skin inverse bind matrices if present
  for (const skin of doc.getRoot().listSkins()) {
    const ibm = skin.getInverseBindMatrices();
    if (!ibm) continue;
    const arr = ibm.getArray();
    // Each IBM is a 4x4 matrix; columns 12,13,14 are translation
    for (let m = 0; m < arr.length; m += 16) {
      arr[m + 12] *= scaleFactor;
      arr[m + 13] *= scaleFactor;
      arr[m + 14] *= scaleFactor;
    }
    ibm.setArray(arr);
  }

  // Scale animation translation tracks
  for (const anim of doc.getRoot().listAnimations()) {
    for (const ch of anim.listChannels()) {
      if (ch.getTargetPath() !== 'translation') continue;
      const sampler = ch.getSampler();
      if (!sampler) continue;
      const output = sampler.getOutput();
      if (!output) continue;
      const arr = output.getArray();
      for (let i = 0; i < arr.length; i++) {
        arr[i] *= scaleFactor;
      }
      output.setArray(arr);
    }
  }
}

async function main() {
  const io = new NodeIO();

  // If source/Player.glb exists, copy it to the root characters/ folder first
  const sourcePlayer = path.join(CHAR_DIR, 'source', 'Player.glb');
  const destPlayer = path.join(CHAR_DIR, 'player.glb');
  if (fs.existsSync(sourcePlayer)) {
    fs.copyFileSync(sourcePlayer, destPlayer);
    console.log('Copied source/Player.glb → player.glb');
  }

  const models = [
    { file: 'player.glb', label: 'Player (SynthContact)' },
    // enemy.glb is NOT normalized here — skinned meshes break when you
    // bake scale into vertices.  Runtime scaling via .scale.set() is used
    // in GameView._spawnEnemies() instead.
    // { file: 'enemy.glb',  label: 'Enemy' },
  ];

  for (const { file, label } of models) {
    const filePath = path.join(CHAR_DIR, file);
    if (!fs.existsSync(filePath)) {
      console.warn(`  ⚠ Skipping ${file} (not found)`);
      continue;
    }

    const doc = await io.read(filePath);
    const before = measureHeight(doc);
    console.log(`\n${label}  (${file})`);
    console.log(`  Native height: ${before.height.toFixed(3)} units`);

    if (Math.abs(before.height - TARGET_HEIGHT) < 0.01) {
      console.log(`  Already at target ${TARGET_HEIGHT}m — skipping.`);
      continue;
    }

    const scaleFactor = TARGET_HEIGHT / before.height;
    console.log(`  Scale factor:  ${scaleFactor.toFixed(6)}`);
    bakeScale(doc, scaleFactor);

    // Verify
    const after = measureHeight(doc);
    console.log(
      `  New height:    ${after.height.toFixed(3)}m  (min Y: ${after.minY.toFixed(3)}, max Y: ${after.maxY.toFixed(3)})`,
    );

    // Write back
    const glb = await io.writeBinary(doc);
    fs.writeFileSync(filePath, glb);
    const sizeKB = (glb.byteLength / 1024).toFixed(1);
    console.log(`  ✔ Saved ${file}  (${sizeKB} KB)`);
  }

  console.log(
    '\nDone! All character models normalized to ' + TARGET_HEIGHT + 'm.',
  );
}

main().catch((err) => {
  console.error('Normalization failed:', err);
  process.exit(1);
});
