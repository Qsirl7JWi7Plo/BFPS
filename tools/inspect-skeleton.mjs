/**
 * inspect-skeleton.mjs
 *
 * Loads the player GLB and prints the full bone hierarchy with
 * world-space positions, so we can see exactly where the right
 * hand bone sits relative to the model root.
 *
 * Usage:  node tools/inspect-skeleton.mjs
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(
  __dirname,
  '../wwwroot/assets/models/characters/player.glb',
);

// GLTFLoader needs fetch — polyfill for Node
const data = fs.readFileSync(MODEL_PATH);
const arrayBuffer = data.buffer.slice(
  data.byteOffset,
  data.byteOffset + data.byteLength,
);

const loader = new GLTFLoader();
loader.parse(
  arrayBuffer,
  '',
  (gltf) => {
    const scene = gltf.scene;

    // Force a world-matrix update
    scene.updateMatrixWorld(true);

    console.log('\n=== FULL SCENE HIERARCHY ===\n');

    function printNode(node, depth = 0) {
      const indent = '  '.repeat(depth);
      const type = node.isBone ? '[BONE]' : node.isMesh ? '[MESH]' : '[NODE]';
      const wp = new THREE.Vector3();
      node.getWorldPosition(wp);
      const lp = node.position;

      let info = `${indent}${type} "${node.name}"`;
      info += `  local(${lp.x.toFixed(4)}, ${lp.y.toFixed(4)}, ${lp.z.toFixed(4)})`;
      info += `  world(${wp.x.toFixed(4)}, ${wp.y.toFixed(4)}, ${wp.z.toFixed(4)})`;

      if (node.isBone) {
        const ls = node.scale;
        const lr = node.rotation;
        info += `  rot(${lr.x.toFixed(3)}, ${lr.y.toFixed(3)}, ${lr.z.toFixed(3)})`;
        info += `  scale(${ls.x.toFixed(3)}, ${ls.y.toFixed(3)}, ${ls.z.toFixed(3)})`;
      }

      console.log(info);
      for (const child of node.children) {
        printNode(child, depth + 1);
      }
    }

    printNode(scene);

    // Also specifically search for hand-related bones
    console.log('\n=== HAND-RELATED BONES ===\n');
    scene.traverse((child) => {
      if (!child.isBone) return;
      const n = child.name.toLowerCase();
      if (
        n.includes('hand') ||
        n.includes('arm') ||
        n.includes('shoulder') ||
        n.includes('wrist')
      ) {
        const wp = new THREE.Vector3();
        child.getWorldPosition(wp);
        console.log(
          `  "${child.name}"  world(${wp.x.toFixed(4)}, ${wp.y.toFixed(4)}, ${wp.z.toFixed(4)})`,
        );
        console.log(`    parent: "${child.parent?.name}"`);
        console.log(
          `    children: [${child.children.map((c) => `"${c.name}"`).join(', ')}]`,
        );
      }
    });
  },
  (err) => {
    console.error('Failed to load:', err);
  },
);
