/**
 * inspect-enemy.mjs — Deep inspection of enemy.glb skeleton + animations
 */
import { NodeIO } from '@gltf-transform/core';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, '../wwwroot/assets/models/characters/enemy.glb');

async function main() {