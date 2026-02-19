import { NodeIO } from '@gltf-transform/core';
import { readFileSync } from 'fs';
import { join } from 'path';

const io = new NodeIO();
const base = 'wwwroot/assets/models';

// ── 1. Inspect Player.glb ──────────────────────────────────────────
console.log('\n═══ PLAYER MODEL (source/Player.glb) ═══');
const playerDoc = await io.read(join(base, 'characters/source/Player.glb'));
const playerRoot = playerDoc.getRoot();

// Textures
const textures = playerRoot.listTextures();
console.log(`\nTextures: ${textures.length}`);
for (const tex of textures) {
  const img = tex.getImage();
  console.log(
    `  name="${tex.getName()}" mime=${tex.getMimeType()} uri=${tex.getURI()} embedded=${img ? img.byteLength + ' bytes' : 'NO'}`,
  );
}

// Materials
const materials = playerRoot.listMaterials();
console.log(`\nMaterials: ${materials.length}`);
for (const mat of materials) {
  const bc = mat.getBaseColorTexture();
  const nr = mat.getNormalTexture();
  const mr = mat.getMetallicRoughnessTexture();
  console.log(
    `  "${mat.getName()}" baseColor=${bc?.getName() || 'none'} normal=${nr?.getName() || 'none'} metalRough=${mr?.getName() || 'none'}`,
  );
}

// Skeleton / Bones
console.log('\nSkeleton bones:');
const playerSkins = playerRoot.listSkins();
for (const skin of playerSkins) {
  const joints = skin.listJoints();
  console.log(`  Skin "${skin.getName()}" — ${joints.length} joints`);
  for (const j of joints) {
    console.log(`    bone: "${j.getName()}"`);
  }
}

// Bounding box (scene nodes with meshes)
const playerScene = playerRoot.listScenes()[0];
let minY = Infinity,
  maxY = -Infinity,
  minX = Infinity,
  maxX = -Infinity,
  minZ = Infinity,
  maxZ = -Infinity;
for (const node of playerRoot.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  for (const prim of mesh.listPrimitives()) {
    const posAcc = prim.getAttribute('POSITION');
    if (!posAcc) continue;
    const arr = posAcc.getArray();
    for (let i = 0; i < arr.length; i += 3) {
      if (arr[i] < minX) minX = arr[i];
      if (arr[i] > maxX) maxX = arr[i];
      if (arr[i + 1] < minY) minY = arr[i + 1];
      if (arr[i + 1] > maxY) maxY = arr[i + 1];
      if (arr[i + 2] < minZ) minZ = arr[i + 2];
      if (arr[i + 2] > maxZ) maxZ = arr[i + 2];
    }
  }
}
console.log(`\nBounding box (vertex data only):`);
console.log(
  `  X: ${minX.toFixed(3)} → ${maxX.toFixed(3)}  (width ${(maxX - minX).toFixed(3)})`,
);
console.log(
  `  Y: ${minY.toFixed(3)} → ${maxY.toFixed(3)}  (height ${(maxY - minY).toFixed(3)})`,
);
console.log(
  `  Z: ${minZ.toFixed(3)} → ${maxZ.toFixed(3)}  (depth ${(maxZ - minZ).toFixed(3)})`,
);

// Node transforms
console.log('\nTop-level nodes:');
for (const node of playerScene.listChildren()) {
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  console.log(
    `  "${node.getName()}" pos=[${t.map((v) => v.toFixed(3))}] rot=[${r.map((v) => v.toFixed(3))}] scale=[${s.map((v) => v.toFixed(3))}]`,
  );
}

// Animations
const anims = playerRoot.listAnimations();
console.log(`\nAnimations: ${anims.length}`);
for (const a of anims) {
  console.log(`  "${a.getName()}" channels=${a.listChannels().length}`);
}

// ── 2. Inspect Weapons ──────────────────────────────────────────────
for (const wep of ['rifle', 'shotgun', 'pistol']) {
  console.log(`\n═══ WEAPON: ${wep}.glb ═══`);
  const doc = await io.read(join(base, `weapons/${wep}.glb`));
  const root = doc.getRoot();

  let wMinX = Infinity,
    wMaxX = -Infinity,
    wMinY = Infinity,
    wMaxY = -Infinity,
    wMinZ = Infinity,
    wMaxZ = -Infinity;

  // Materials
  const wMats = root.listMaterials();
  console.log(`Materials: ${wMats.length}`);
  for (const m of wMats) {
    const bc = m.getBaseColorFactor();
    console.log(
      `  "${m.getName()}" color=[${bc.map((v) => v.toFixed(2))}] metallic=${m.getMetallicFactor()} rough=${m.getRoughnessFactor()}`,
    );
  }

  // Meshes & bbox
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const t = node.getTranslation();
    const s = node.getScale();
    console.log(
      `Node "${node.getName()}" pos=[${t.map((v) => v.toFixed(3))}] scale=[${s.map((v) => v.toFixed(3))}]`,
    );
    for (const prim of mesh.listPrimitives()) {
      const posAcc = prim.getAttribute('POSITION');
      if (!posAcc) continue;
      const arr = posAcc.getArray();
      for (let i = 0; i < arr.length; i += 3) {
        if (arr[i] < wMinX) wMinX = arr[i];
        if (arr[i] > wMaxX) wMaxX = arr[i];
        if (arr[i + 1] < wMinY) wMinY = arr[i + 1];
        if (arr[i + 1] > wMaxY) wMaxY = arr[i + 1];
        if (arr[i + 2] < wMinZ) wMinZ = arr[i + 2];
        if (arr[i + 2] > wMaxZ) wMaxZ = arr[i + 2];
      }
    }
  }
  console.log(`Bounding box:`);
  console.log(
    `  X: ${wMinX.toFixed(4)} → ${wMaxX.toFixed(4)}  (${(wMaxX - wMinX).toFixed(4)})`,
  );
  console.log(
    `  Y: ${wMinY.toFixed(4)} → ${wMaxY.toFixed(4)}  (${(wMaxY - wMinY).toFixed(4)})`,
  );
  console.log(
    `  Z: ${wMinZ.toFixed(4)} → ${wMaxZ.toFixed(4)}  (${(wMaxZ - wMinZ).toFixed(4)})`,
  );

  // Top-level nodes
  const wScene = root.listScenes()[0];
  if (wScene) {
    for (const n of wScene.listChildren()) {
      const t = n.getTranslation();
      const r = n.getRotation();
      const s = n.getScale();
      console.log(
        `Scene child "${n.getName()}" pos=[${t.map((v) => v.toFixed(4))}] rot=[${r.map((v) => v.toFixed(4))}] scale=[${s.map((v) => v.toFixed(4))}]`,
      );
    }
  }
}
