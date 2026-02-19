/**
 * maze.js — Server-side port of MazeGenerator.js (CommonJS).
 * Produces a 2D grid where each cell stores which walls are open.
 * Grid coordinates: row (r) = Z axis, col (c) = X axis.
 */

const DIRS = [
  { name: 'north', dr: -1, dc: 0, opposite: 'south' },
  { name: 'south', dr: 1, dc: 0, opposite: 'north' },
  { name: 'east', dr: 0, dc: 1, opposite: 'west' },
  { name: 'west', dr: 0, dc: -1, opposite: 'east' },
];

/**
 * Generate a perfect maze using iterative back-tracker (depth-first).
 * @param {number} rows
 * @param {number} cols
 * @returns {{ grid: object[][], rows: number, cols: number }}
 */
function generateMaze(rows, cols) {
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

  // Iterative back-tracker
  const stack = [];
  grid[0][0].visited = true;
  stack.push({ r: 0, c: 0 });

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
      stack.pop();
      continue;
    }

    // Pick a random unvisited neighbour
    const { dir, nr, nc } =
      neighbours[Math.floor(Math.random() * neighbours.length)];

    // Knock down walls
    grid[r][c][dir.name] = true;
    grid[nr][nc][dir.opposite] = true;
    grid[nr][nc].visited = true;
    stack.push({ r: nr, c: nc });
  }

  // Strip visited flags for serialization
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      delete grid[r][c].visited;
    }
  }

  return { grid, rows, cols };
}

module.exports = { generateMaze, DIRS };
