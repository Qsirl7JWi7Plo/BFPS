/**
 * collision.js — Server-side port of GameModel.isBlocked().
 * Checks if a world-space position collides with maze walls.
 */

const CELL_SIZE = 6;
const WALL_THICKNESS = 0.15;

/**
 * Check if a world-space position collides with a wall.
 * @param {object} maze  – { grid, rows, cols }
 * @param {number} x
 * @param {number} z
 * @param {number} [radius=0.4]
 * @returns {boolean}
 */
function isBlocked(maze, x, z, radius = 0.4) {
  if (!maze) return false;
  const { grid, rows, cols } = maze;
  const cs = CELL_SIZE;

  const minC = Math.floor((x - radius) / cs);
  const maxC = Math.floor((x + radius) / cs);
  const minR = Math.floor((z - radius) / cs);
  const maxR = Math.floor((z + radius) / cs);

  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (r < 0 || r >= rows || c < 0 || c >= cols) return true;

      const cell = grid[r][c];
      const cellLeft = c * cs;
      const cellRight = (c + 1) * cs;
      const cellTop = r * cs;
      const cellBottom = (r + 1) * cs;

      // North wall
      if (
        !cell.north &&
        z - radius < cellTop &&
        z + radius > cellTop - WALL_THICKNESS &&
        x + radius > cellLeft &&
        x - radius < cellRight
      )
        return true;
      // South wall
      if (
        !cell.south &&
        z + radius > cellBottom &&
        z - radius < cellBottom + WALL_THICKNESS &&
        x + radius > cellLeft &&
        x - radius < cellRight
      )
        return true;
      // West wall
      if (
        !cell.west &&
        x - radius < cellLeft &&
        x + radius > cellLeft - WALL_THICKNESS &&
        z + radius > cellTop &&
        z - radius < cellBottom
      )
        return true;
      // East wall
      if (
        !cell.east &&
        x + radius > cellRight &&
        x - radius < cellRight + WALL_THICKNESS &&
        z + radius > cellTop &&
        z - radius < cellBottom
      )
        return true;
    }
  }
  return false;
}

/**
 * Server-side raycast against maze walls.
 * Steps along a ray and returns the distance at which a wall is hit, or -1.
 * @param {object} maze
 * @param {object} origin  – { x, y, z }
 * @param {object} direction  – { x, y, z } (normalised)
 * @param {number} maxRange
 * @param {number} [step=0.5]
 * @returns {number} distance to wall hit, or -1
 */
function raycastWall(maze, origin, direction, maxRange, step = 0.5) {
  let dist = 0;
  while (dist < maxRange) {
    const px = origin.x + direction.x * dist;
    const pz = origin.z + direction.z * dist;
    if (isBlocked(maze, px, pz, 0.05)) return dist;
    dist += step;
  }
  return -1;
}

/**
 * Server-side raycast against player positions.
 * Returns the id of the first player hit, or null.
 * @param {object} origin  – { x, y, z }
 * @param {object} direction  – { x, y, z } (normalised)
 * @param {number} maxRange
 * @param {Map} players  – Map<id, { x, y, z, ... }>
 * @param {string} shooterId  – exclude the shooter
 * @param {object} maze  – for wall occlusion check
 * @param {number} [step=0.5]
 * @param {number} [hitRadius=0.8]
 * @returns {{ targetId: string, distance: number } | null}
 */
function raycastPlayers(
  origin,
  direction,
  maxRange,
  players,
  shooterId,
  maze,
  step = 0.3,
  hitRadius = 0.8,
) {
  let dist = 0;
  const hitRadiusSq = hitRadius * hitRadius;

  while (dist < maxRange) {
    const px = origin.x + direction.x * dist;
    const py = origin.y + direction.y * dist;
    const pz = origin.z + direction.z * dist;

    // Wall occlusion check
    if (isBlocked(maze, px, pz, 0.05)) return null;

    // Check against all players
    for (const [id, player] of players) {
      if (id === shooterId) continue;
      if (!player.alive) continue;

      const dx = px - player.x;
      const dy = py - player.y; // y at centre mass (eye height ~2, so body from 1 to 3)
      const dz = pz - player.z;

      // Cylinder hit check: horizontal distance + vertical bounds
      const horizDistSq = dx * dx + dz * dz;
      if (
        horizDistSq < hitRadiusSq &&
        py > player.y - 1.5 &&
        py < player.y + 0.5
      ) {
        return { targetId: id, distance: dist };
      }
    }

    dist += step;
  }
  return null;
}

module.exports = { isBlocked, raycastWall, raycastPlayers, CELL_SIZE };
