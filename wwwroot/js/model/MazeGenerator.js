/**
 * MazeGenerator — recursive back-tracker (depth-first) maze builder.
 *
 * Produces a 2D grid where each cell stores which walls are open.
 * Grid coordinates: row (r) = Z axis, col (c) = X axis.
 *
 * @module MazeGenerator
 */

/**
 * @typedef {Object} MazeCell
 * @property {boolean} north  – wall open to the north (−Z)
 * @property {boolean} south  – wall open to the south (+Z)
 * @property {boolean} east   – wall open to the east  (+X)
 * @property {boolean} west   – wall open to the west  (−X)
 * @property {boolean} visited
 */

const DIRS = [
  { name: 'north', dr: -1, dc: 0, opposite: 'south' },
  { name: 'south', dr: 1, dc: 0, opposite: 'north' },
  { name: 'east', dr: 0, dc: 1, opposite: 'west' },
  { name: 'west', dr: 0, dc: -1, opposite: 'east' },
];

/**
 * Shuffle array in-place (Fisher-Yates).
 */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Generate a perfect maze using recursive back-tracker.
 *
 * @param {number} rows   Number of rows  (Z cells)
 * @param {number} cols   Number of columns (X cells)
 * @returns {{ grid: MazeCell[][], rows: number, cols: number }}
 */
export function generateMaze(rows, cols) {
  // Initialise grid — all walls closed
  const grid = [];
  for (let r = 0; r < rows; r++) {
    grid[r] = [];
    for (let c = 0; c < cols; c++) {
      grid[r][c] = {
        north: false,
        south: false,
        east: false,
        west: false,
        visited: false,
      };
    }
  }

  // Iterative back-tracker (avoids stack overflow on large mazes)
  const stack = [];
  const startR = 0;
  const startC = 0;
  grid[startR][startC].visited = true;
  stack.push({ r: startR, c: startC });

  while (stack.length > 0) {
    const { r, c } = stack[stack.length - 1];

    // Collect unvisited neighbours
    const neighbours = [];
    for (const d of DIRS) {
      const nr = r + d.dr;
      const nc = c + d.dc;
      if (
        nr >= 0 &&
        nr < rows &&
        nc >= 0 &&
        nc < cols &&
        !grid[nr][nc].visited
      ) {
        neighbours.push({ dir: d, nr, nc });
      }
    }

    if (neighbours.length === 0) {
      stack.pop(); // back-track
      continue;
    }

    // Pick a random unvisited neighbour
    const { dir, nr, nc } =
      neighbours[Math.floor(Math.random() * neighbours.length)];

    // Knock down walls between current and neighbour
    grid[r][c][dir.name] = true;
    grid[nr][nc][dir.opposite] = true;
    grid[nr][nc].visited = true;
    stack.push({ r: nr, c: nc });
  }

  return { grid, rows, cols };
}
