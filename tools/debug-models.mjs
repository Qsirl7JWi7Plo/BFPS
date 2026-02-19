import { NodeIO } from '@gltf-transform/core';
import { join } from 'path';

const io = new NodeIO();
const base = 'wwwroot/assets/models';

// ── 1. Player model deep inspection ──────────────────────────────
console.log('\n═══ PLAYER MODEL ═══');
const playerDoc = await io.read(join(base, 'characters/player.glb'));
const playerRoot = playerDoc.getRoot();

// Scene hierarchy
const scene = playerRoot.listScenes()[0];
console.log('Scene children:');
function printTree(node, indent = '  ') {
  const mesh = node.getMesh();
  const t = node.getTranslation();
  const s = node.getScale();
  const childCount = node.listChildren().length;
  const meshInfo = mesh ? ` [MESH: ${mesh.listPrimitives().length} prims]` : '';
  const skinInfo = node.getSkin ? (node.getSkin() ? ' [SKINNED]' : '') : '';
  console.log(
    `${indent}"${node.getName()}" pos=[${t.map((v) => v.toFixed(3))}] scale=[${s.map((v) => v.toFixed(3))}]${meshInfo}${skinInfo} children=${childCount}`,
  );
  // Only print first 2 levels + mesh nodes
  if (indent.length < 12 || mesh) {
    for (const child of node.listChildren()) {
      printTree(child, indent + '  ');
    }
  }
}
for (const child of scene.listChildren()) {
  printTree(child);
}

// Count total meshes and vertices
let totalVerts = 0,
  totalMeshes = 0;
for (const mesh of playerRoot.listMeshes()) {
  totalMeshes++;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (pos) totalVerts += pos.getCount();
  }
}
console.log(`\nTotal meshes: ${totalMeshes}, total vertices: ${totalVerts}`);

// Bounding box per mesh node
console.log('\nMesh bounding boxes:');
for (const node of playerRoot.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  let mnY = Infinity,
    mxY = -Infinity,
    mnX = Infinity,
    mxX = -Infinity,
    mnZ = Infinity,
    mxZ = -Infinity;
  let vertCount = 0;
  for (const prim of mesh.listPrimitives()) {
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) continue;
    const arr = posAcc.getArray();
    vertCount += arr.length / 3;
    for (let i = 0; i < arr.length; i += 3) {
      if (arr[i] < mnX) mnX = arr[i];
      if (arr[i] > mxX) mxX = arr[i];
      if (arr[i + 1] < mnY) mnY = arr[i + 1];
      if (arr[i + 1] > mxY) mxY = arr[i + 1];
      if (arr[i + 2] < mnZ) mnZ = arr[i + 2];
      if (arr[i + 2] > mxZ) mxZ = arr[i + 2];
    }
  }
  const mat = mesh.listPrimitives()[0]?.getMaterial();
  console.log(
    `  "${node.getName()}" mat="${mat?.getName()}" verts=${vertCount}`,
  );
  console.log(
    `    X=[${mnX.toFixed(3)}, ${mxX.toFixed(3)}] Y=[${mnY.toFixed(3)}, ${mxY.toFixed(3)}] Z=[${mnZ.toFixed(3)}, ${mxZ.toFixed(3)}]`,
  );
}

// ── 2. Weapon inspection after normalization ──────────────────────
for (const wep of ['rifle', 'shotgun', 'pistol']) {
  console.log(`\n═══ ${wep.toUpperCase()} (after normalize) ═══`);
  const doc = await io.read(join(base, `weapons/${wep}.glb`));
  const root = doc.getRoot();

  let mnX = Infinity,
    mxX = -Infinity,
    mnY = Infinity,
    mxY = -Infinity,
    mnZ = Infinity,
    mxZ = -Infinity;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const t = node.getTranslation();
    const s = node.getScale();
    console.log(
      `  Node "${node.getName()}" pos=[${t.map((v) => v.toFixed(4))}] scale=[${s.map((v) => v.toFixed(4))}]`,
    );
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const arr = posAcc.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        if (arr[i] < mnX) mnX = arr[i];
        if (arr[i] > mxX) mxX = arr[i];
        if (arr[i + 1] < mnY) mnY = arr[i + 1];
        if (arr[i + 1] > mxY) mxY = arr[i + 1];
        if (arr[i + 2] < mnZ) mnZ = arr[i + 2];
        if (arr[i + 2] > mxZ) mxZ = arr[i + 2];
      }
    }
  }
  console.log(
    `  Bbox: X=[${mnX.toFixed(4)}, ${mxX.toFixed(4)}] Y=[${mnY.toFixed(4)}, ${mxY.toFixed(4)}] Z=[${mnZ.toFixed(4)}, ${mxZ.toFixed(4)}]`,
  );
  console.log(
    `  Size: X=${(mxX - mnX).toFixed(4)} Y=${(mxY - mnY).toFixed(4)} Z=${(mxZ - mnZ).toFixed(4)}`,
  );
  console.log(`  Origin: muzzle should be at most -Z, stock at most +Z`);
  console.log(
    `  Muzzle tip Z = ${mnZ.toFixed(4)}, Stock end Z = ${mxZ.toFixed(4)}`,
  );

  // Materials
  const mats = root.listMaterials();
  for (const m of mats) {
    console.log(
      `  Material "${m.getName()}" color=[${m.getBaseColorFactor().map((v) => v.toFixed(2))}]`,
    );
  }
}
