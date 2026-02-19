import { generateMaze } from './MazeGenerator.js';

/**
 * GameModel — owns all game state (MVC: Model layer).
 * No rendering or input logic lives here.
 */
export class GameModel {
  /**
   * @param {import('./Settings.js').Settings} settings
   */
  constructor(settings) {
    this.settings = settings;

    /** @type {THREE.Object3D[]} living enemy root objects */
    this.enemies = [];

    /** Player state */
    this.player = {
      x: 0,
      y: 2, // eye height
      z: 0,
      yaw: 0,
      pitch: 0,
      speed: 0.15,
      baseSpeed: 0.15,
      sprintMultiplier: 1.8,
      sprinting: false,
    };

    /** Movement intent flags (set by controller) */
    this.movement = {
      forward: false,
      backward: false,
      left: false,
      right: false,
    };

    /** Score tracking */
    this.score = 0;
    this.totalEnemies = 10;

    /** Whether the current level has a boss */
    this.bossLevel = false;
    /** The boss enemy object (if any) */
    this.bossEnemy = null;

    /** Auto-heal: timestamp (ms) of the last time the player took damage */
    this.lastDamageTime = 0;
    /** Auto-heal starts after this many ms of no damage */
    this.autoHealDelay = 3000;
    /** Auto-heal rate in HP per second */
    this.autoHealRate = 10;

    /** Aiming-down-sights state */
    this.aiming = false;

    /* ── Multiplayer state ────────────────────────────────── */
    /** @type {Map<string, object>|null} Remote player states */
    this.networkPlayers = null;
    /** Local player health (multiplayer) */
    this.player.health = 100;
    /** Whether local player is alive (multiplayer) */
    this.player.alive = true;
    /** Death count (multiplayer) */
    this.player.deaths = 0;
    /** Whether we're in a multiplayer game */
    this.multiplayer = false;

    /* ── Maze / level state ──────────────────────────────── */
    /** Size of one maze cell in world units */
    this.cellSize = 6;
    /** Wall height in world units */
    this.wallHeight = 4;
    /** Radius around player that gets revealed on the minimap (in cells) */
    this.fogRadius = 2;

    /** Level definitions — fixed maze size, more enemies each level */
    this.levels = [
      { rows: 6, cols: 6, enemies: 3 },
      { rows: 6, cols: 6, enemies: 5 },
      { rows: 6, cols: 6, enemies: 8 },
      { rows: 6, cols: 6, enemies: 12 },
      { rows: 6, cols: 6, enemies: 16 },
    ];
    this.currentLevel = 0;
    this.gameWon = false;

    /** Maze data — set by loadLevel() */
    this.maze = null; // { grid, rows, cols }
    /** Fog-of-war: Set of "r,c" strings the player has revealed */
    this.discovered = new Set();
    /** Exit gate cell { r, c } */
    this.exitCell = null;
    /** Player start cell { r, c } */
    this.startCell = null;

    // Load first level
    this.loadLevel(0);
  }

  /* ================================================================== */
  /*  Level management                                                   */
  /* ================================================================== */

  /**
   * Generate a maze for the given level index and reset player position.
   * @param {number} levelIndex
   */
  loadLevel(levelIndex) {
    this.currentLevel = levelIndex;

    if (levelIndex >= this.levels.length) {
      this.gameWon = true;
      return;
    }

    const def = this.levels[levelIndex];
    this.maze = generateMaze(def.rows, def.cols);
    this.totalEnemies = def.enemies;

    // Clear old enemies
    this.enemies = [];
    this.score = 0;

    // Player starts in top-left cell (0, 0)
    this.startCell = { r: 0, c: 0 };
    // Exit gate in bottom-right cell
    this.exitCell = { r: def.rows - 1, c: def.cols - 1 };

    // Place player in starting cell centre
    const start = this.cellToWorld(this.startCell.r, this.startCell.c);
    this.player.x = start.x;
    this.player.z = start.z;

    // Face the first open passage (south = +Z or east = +X)
    const startGrid = this.maze.grid[0][0];
    if (startGrid.south && startGrid.east) {
      // Both open — face diagonally south-east
      this.player.yaw = -Math.PI / 4;
    } else if (startGrid.south) {
      // South open (+Z) → yaw = π (face +Z)
      this.player.yaw = Math.PI;
    } else if (startGrid.east) {
      // East open (+X) → yaw = -π/2 (face +X)
      this.player.yaw = -Math.PI / 2;
    } else {
      this.player.yaw = 0;
    }
    this.player.pitch = 0;

    // Reset fog
    this.discovered = new Set();
    this.revealAround(this.startCell.r, this.startCell.c);
  }

  /* ================================================================== */
  /*  Coordinate helpers                                                 */
  /* ================================================================== */

  /**
   * Convert grid (row, col) to world-space centre of that cell.
   * @returns {{ x: number, z: number }}
   */
  cellToWorld(r, c) {
    return {
      x: c * this.cellSize + this.cellSize / 2,
      z: r * this.cellSize + this.cellSize / 2,
    };
  }

  /**
   * Convert world-space position to grid (row, col).
   * @returns {{ r: number, c: number }}
   */
  worldToCell(x, z) {
    return {
      r: Math.floor(z / this.cellSize),
      c: Math.floor(x / this.cellSize),
    };
  }

  /* ================================================================== */
  /*  Fog-of-war                                                         */
  /* ================================================================== */

  /**
   * Reveal cells within fogRadius of (r, c).
   */
  revealAround(r, c) {
    const rad = this.fogRadius;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < this.maze.rows && nc >= 0 && nc < this.maze.cols) {
          this.discovered.add(`${nr},${nc}`);
        }
      }
    }
  }

  /**
   * Update fog based on current player world position.
   */
  updateFog() {
    const cell = this.worldToCell(this.player.x, this.player.z);
    this.revealAround(cell.r, cell.c);
  }

  /* ================================================================== */
  /*  Collision detection (axis-aligned wall checks)                      */
  /* ================================================================== */

  /**
   * Check if a world-space position collides with a wall.
   * Returns true if the position is blocked.
   * @param {number} x
   * @param {number} z
   * @param {number} radius  – player collision radius
   * @returns {boolean}
   */
  isBlocked(x, z, radius = 0.4) {
    if (!this.maze) return false;
    const { grid, rows, cols } = this.maze;
    const cs = this.cellSize;

    // Check all cells the player's bounding circle touches
    const minC = Math.floor((x - radius) / cs);
    const maxC = Math.floor((x + radius) / cs);
    const minR = Math.floor((z - radius) / cs);
    const maxR = Math.floor((z + radius) / cs);

    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        // Outside maze bounds = wall
        if (r < 0 || r >= rows || c < 0 || c >= cols) return true;

        const cell = grid[r][c];
        const cellLeft = c * cs;
        const cellRight = (c + 1) * cs;
        const cellTop = r * cs; // north edge (−Z world sense)
        const cellBottom = (r + 1) * cs; // south edge

        // North wall
        if (
          !cell.north &&
          z - radius < cellTop &&
          z + radius > cellTop - 0.15 &&
          x + radius > cellLeft &&
          x - radius < cellRight
        )
          return true;
        // South wall
        if (
          !cell.south &&
          z + radius > cellBottom &&
          z - radius < cellBottom + 0.15 &&
          x + radius > cellLeft &&
          x - radius < cellRight
        )
          return true;
        // West wall
        if (
          !cell.west &&
          x - radius < cellLeft &&
          x + radius > cellLeft - 0.15 &&
          z + radius > cellTop &&
          z - radius < cellBottom
        )
          return true;
        // East wall
        if (
          !cell.east &&
          x + radius > cellRight &&
          x - radius < cellRight + 0.15 &&
          z + radius > cellTop &&
          z - radius < cellBottom
        )
          return true;
      }
    }
    return false;
  }

  /* ================================================================== */
  /*  Exit / level completion                                            */
  /* ================================================================== */

  /**
   * Check if the player is standing in the exit cell.
   * @returns {boolean}
   */
  isAtExit() {
    if (!this.exitCell || !this.maze) return false;
    const cell = this.worldToCell(this.player.x, this.player.z);
    return cell.r === this.exitCell.r && cell.c === this.exitCell.c;
  }

  /**
   * Advance to the next level.
   * @returns {boolean} true if there is a next level, false if game won
   */
  nextLevel() {
    this.loadLevel(this.currentLevel + 1);
    return !this.gameWon;
  }

  /**
   * Reset the game back to level 0 for a fresh play-through.
   */
  resetGame() {
    this.score = 0;
    this.gameWon = false;
    this.enemies = [];
    this.player.health = 100;
    this.player.alive = true;
    this.player.deaths = 0;
    this.loadLevel(0);
  }

  /* ================================================================== */
  /*  Multiplayer                                                        */
  /* ================================================================== */

  /**
   * Apply maze data received from the multiplayer server.
   * @param {{ grid: object[][], rows: number, cols: number }} mazeData
   * @param {{ r: number, c: number }} startCell
   * @param {{ r: number, c: number }} exitCell
   * @param {number} level
   */
  applyServerMaze(mazeData, startCell, exitCell, level) {
    this.currentLevel = level || 0;
    this.maze = mazeData;
    this.startCell = startCell;
    this.exitCell = exitCell;
    this.enemies = [];
    this.score = 0;
    this.gameWon = false;
    this.player.health = 100;
    this.player.alive = true;

    // Calculate totalEnemies from level definition
    if (level < this.levels.length) {
      this.totalEnemies = this.levels[level].enemies;
    }

    // Reset fog — reveal around the player's actual spawn cell, not just startCell
    this.discovered = new Set();
    const spawnCell = this.worldToCell(this.player.x, this.player.z);
    this.revealAround(spawnCell.r, spawnCell.c);
  }

  /* ================================================================== */
  /*  Auto-heal                                                          */
  /* ================================================================== */

  /**
   * Record that the player just took damage (resets auto-heal timer).
   */
  recordDamage() {
    this.lastDamageTime = performance.now();
  }

  /**
   * Tick auto-heal: if enough time has passed since last damage, regenerate HP.
   * @param {number} dt – seconds since last frame
   */
  updateAutoHeal(dt) {
    if (this.player.health >= 100 || !this.player.alive) return;
    const elapsed = performance.now() - this.lastDamageTime;
    if (elapsed >= this.autoHealDelay) {
      this.player.health = Math.min(
        100,
        this.player.health + this.autoHealRate * dt,
      );
    }
  }

  /* ================================================================== */
  /*  Enemy helpers                                                      */
  /* ================================================================== */

  /**
   * Get valid enemy spawn positions (random cells that aren't start or exit).
   * @returns {{ x: number, z: number }[]}
   */
  getEnemySpawnPositions() {
    const positions = [];
    if (!this.maze) return positions;
    const { rows, cols } = this.maze;
    const candidates = [];

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        // Don't spawn at start or exit
        if (r === this.startCell.r && c === this.startCell.c) continue;
        if (r === this.exitCell.r && c === this.exitCell.c) continue;
        // Don't spawn too close to start
        const dist =
          Math.abs(r - this.startCell.r) + Math.abs(c - this.startCell.c);
        if (dist < 3) continue;
        candidates.push({ r, c });
      }
    }

    // Shuffle and pick totalEnemies positions
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const count = Math.min(this.totalEnemies, candidates.length);
    for (let i = 0; i < count; i++) {
      positions.push(this.cellToWorld(candidates[i].r, candidates[i].c));
    }
    return positions;
  }

  /**
   * Get a boss spawn position — the cell furthest from the player.
   * @returns {{ x: number, z: number }}
   */
  getBossSpawnPosition() {
    if (!this.maze) return { x: 3, z: 3 };
    const { rows, cols } = this.maze;
    const pCell = this.worldToCell(this.player.x, this.player.z);
    let best = null;
    let bestDist = -1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const dist = Math.abs(r - pCell.r) + Math.abs(c - pCell.c);
        if (dist > bestDist) {
          bestDist = dist;
          best = { r, c };
        }
      }
    }
    return this.cellToWorld(best.r, best.c);
  }

  /**
   * Register an enemy root object.
   * @param {THREE.Object3D} obj
   */
  addEnemy(obj) {
    this.enemies.push(obj);
  }

  /** Points awarded per enemy type */
  static SCORE_NPC = 3;
  static SCORE_BOSS = 50;

  /**
   * Remove a specific enemy root object.
   * @param {THREE.Object3D} obj
   * @param {boolean} [isBoss=false]
   * @returns {boolean} true if found and removed
   */
  removeEnemy(obj, isBoss = false) {
    const idx = this.enemies.indexOf(obj);
    if (idx !== -1) {
      this.enemies.splice(idx, 1);
      this.score += isBoss ? GameModel.SCORE_BOSS : GameModel.SCORE_NPC;
      return true;
    }
    return false;
  }

  /**
   * Given a hit mesh (possibly a child), walk up to find the enemy root.
   * @param {THREE.Object3D} hitObject
   * @returns {THREE.Object3D|null}
   */
  findEnemyRoot(hitObject) {
    let current = hitObject;
    while (current) {
      if (this.enemies.includes(current)) return current;
      current = current.parent;
    }
    return null;
  }
}
