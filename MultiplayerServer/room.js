/**
 * room.js — Server-side room/lobby management.
 * Each room is an independent game instance with its own maze, players, and state.
 */

const { generateMaze } = require('./maze.js');
const { CELL_SIZE } = require('./collision.js');

/** Level definitions — fixed maze size, increasing enemies */
const LEVELS = [
  { rows: 6, cols: 6, enemies: 3 },
  { rows: 6, cols: 6, enemies: 5 },
  { rows: 6, cols: 6, enemies: 8 },
  { rows: 6, cols: 6, enemies: 12 },
  { rows: 6, cols: 6, enemies: 16 },
];

/**
 * Minimum cells of open space between any two spawn points.
 * Each player gets a 5-cell exclusion zone around their spawn so
 * nobody starts within line-of-sight of another player.
 */
const SPAWN_SPACING = 5;

let nextRoomId = 1;

class Room {
  /**
   * @param {string} name
   * @param {number} maxPlayers
   * @param {string} creatorId - socket id of the room creator
   */
  constructor(name, maxPlayers, creatorId) {
    this.id = String(nextRoomId++);
    this.name = name;
    this.maxPlayers = maxPlayers || 8;
    this.creatorId = creatorId;

    /** @type {Map<string, PlayerState>} */
    this.players = new Map();

    /** 'waiting' | 'playing' */
    this.state = 'waiting';

    /** Current level index */
    this.currentLevel = 0;

    /** Maze data — set when game starts */
    this.maze = null;
    this.startCell = null;
    this.exitCell = null;

    /** Respawn queue: array of { playerId, respawnAt } */
    this._respawnQueue = [];
  }

  /* ── Player management ──────────────────────────────────── */

  /**
   * Add a player to this room.
   * @param {string} id - socket id
   * @param {string} name
   * @param {string} weapon
   * @returns {PlayerState}
   */
  addPlayer(id, name, weapon) {
    const player = {
      id,
      name: name || 'Player',
      x: 0,
      y: 2,
      z: 0,
      yaw: 0,
      pitch: 0,
      health: 100,
      score: 0,
      deaths: 0,
      weapon: weapon || 'rifle',
      sprinting: false,
      alive: true,
    };
    this.players.set(id, player);
    return player;
  }

  /**
   * Remove a player from this room.
   * @param {string} id
   */
  removePlayer(id) {
    this.players.delete(id);
    // If creator left, transfer to next player or mark for deletion
    if (id === this.creatorId) {
      const remaining = [...this.players.keys()];
      this.creatorId = remaining.length > 0 ? remaining[0] : null;
    }
  }

  get isEmpty() {
    return this.players.size === 0;
  }

  get playerCount() {
    return this.players.size;
  }

  /* ── Game management ────────────────────────────────────── */

  /**
   * Calculate maze dimensions that guarantee enough room for all
   * players in this room's maxPlayers setting.
   *
   * Rule: the maze must have at least (maxPlayers × SPAWN_SPACING²) cells
   * so every player can be placed with SPAWN_SPACING cells of clearance.
   * We always size for maxPlayers (not current count) so the map stays
   * consistent regardless of late-joiners.
   *
   * @returns {{ rows: number, cols: number }}
   */
  _scaledMazeSize() {
    const base = LEVELS[this.currentLevel] || LEVELS[0];
    // Area needed: each player needs a SPAWN_SPACING × SPAWN_SPACING zone
    const neededCells = this.maxPlayers * SPAWN_SPACING * SPAWN_SPACING;
    const baseCells = base.rows * base.cols;
    if (baseCells >= neededCells) return { rows: base.rows, cols: base.cols };

    // Scale up symmetrically
    const scale = Math.ceil(Math.sqrt(neededCells / baseCells));
    return {
      rows: base.rows * scale,
      cols: base.cols * scale,
    };
  }

  /**
   * Pick spawn cells that are at least SPAWN_SPACING apart (Manhattan distance).
   * Falls back to best-effort if the maze is somehow too small.
   *
   * @param {number} count  – number of spawn points needed
   * @param {number} rows
   * @param {number} cols
   * @returns {{ r: number, c: number }[]}
   */
  _pickSpacedSpawns(count, rows, cols) {
    // Build & shuffle all cells
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ r, c });
      }
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    const chosen = [];
    for (const cell of cells) {
      const tooClose = chosen.some(
        (s) => Math.abs(s.r - cell.r) + Math.abs(s.c - cell.c) < SPAWN_SPACING,
      );
      if (!tooClose) {
        chosen.push(cell);
        if (chosen.length >= count) break;
      }
    }

    // Fallback: if not enough spaced cells, fill remaining from shuffled list
    if (chosen.length < count) {
      for (const cell of cells) {
        if (!chosen.some((s) => s.r === cell.r && s.c === cell.c)) {
          chosen.push(cell);
          if (chosen.length >= count) break;
        }
      }
    }

    return chosen;
  }

  /**
   * Start the game — generate a maze scaled for maxPlayers,
   * then assign each player a spawn with SPAWN_SPACING clearance.
   */
  startGame() {
    const { rows, cols } = this._scaledMazeSize();
    this.maze = generateMaze(rows, cols);
    this.startCell = { r: 0, c: 0 };
    this.exitCell = { r: rows - 1, c: cols - 1 };
    this.state = 'playing';

    // Pre-calculate spaced spawns for ALL maxPlayers slots
    const spawns = this._pickSpacedSpawns(this.maxPlayers, rows, cols);

    let i = 0;
    for (const [, player] of this.players) {
      const cell = spawns[i % spawns.length];
      const pos = this._cellToWorld(cell.r, cell.c);
      player.x = pos.x;
      player.y = 2;
      player.z = pos.z;
      player.yaw = 0;
      player.pitch = 0;
      player.health = 100;
      player.alive = true;
      i++;
    }
  }

  /**
   * Get a respawn position that is at least SPAWN_SPACING away from
   * every other living player.  Falls back to a random cell if no
   * valid position exists.
   * @returns {{ x: number, z: number }}
   */
  getStartSpawn() {
    if (!this.maze) return { x: 3, z: 3 };
    const { rows, cols } = this.maze;

    // Collect living player cell positions
    const occupied = [];
    for (const [, p] of this.players) {
      if (p.alive) {
        occupied.push({
          r: Math.floor(p.z / CELL_SIZE),
          c: Math.floor(p.x / CELL_SIZE),
        });
      }
    }

    // Build shuffled candidate list
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({ r, c });
      }
    }
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }

    // Prefer a cell that is SPAWN_SPACING away from all living players
    for (const cell of cells) {
      const tooClose = occupied.some(
        (o) => Math.abs(o.r - cell.r) + Math.abs(o.c - cell.c) < SPAWN_SPACING,
      );
      if (!tooClose) return this._cellToWorld(cell.r, cell.c);
    }

    // Fallback: just pick a random cell
    const cell = cells[0];
    return this._cellToWorld(cell.r, cell.c);
  }

  /**
   * Process respawn queue — call this periodically.
   * Players respawn near the start (a level back feel).
   * @returns {Array<{ playerId: string, x: number, y: number, z: number }>}
   */
  processRespawns() {
    const now = Date.now();
    const respawned = [];

    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      const entry = this._respawnQueue[i];
      if (now >= entry.respawnAt) {
        const player = this.players.get(entry.playerId);
        if (player) {
          const pos = this.getStartSpawn();
          player.x = pos.x;
          player.y = 2;
          player.z = pos.z;
          player.health = 100;
          player.alive = true;
          respawned.push({
            playerId: entry.playerId,
            x: pos.x,
            y: 2,
            z: pos.z,
          });
        }
        this._respawnQueue.splice(i, 1);
      }
    }

    return respawned;
  }

  /**
   * Queue a player for respawn after a delay.
   * @param {string} playerId
   * @param {number} [delayMs=7000]
   */
  queueRespawn(playerId, delayMs = 7000) {
    this._respawnQueue.push({
      playerId,
      respawnAt: Date.now() + delayMs,
    });
  }

  /**
   * Get serializable room info for the lobby listing.
   */
  getInfo() {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
      state: this.state,
      creatorId: this.creatorId,
    };
  }

  /**
   * Get full game state for sync.
   */
  getGameState() {
    const players = {};
    for (const [id, p] of this.players) {
      players[id] = {
        id: p.id,
        name: p.name,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: p.yaw,
        pitch: p.pitch,
        health: p.health,
        score: p.score,
        deaths: p.deaths,
        weapon: p.weapon,
        alive: p.alive,
      };
    }
    return { players };
  }

  /**
   * Get serializable start-game payload.
   */
  getStartPayload() {
    return {
      maze: this.maze,
      startCell: this.startCell,
      exitCell: this.exitCell,
      level: this.currentLevel,
      players: this.getGameState().players,
    };
  }

  /* ── Helpers ────────────────────────────────────────────── */

  _cellToWorld(r, c) {
    return {
      x: c * CELL_SIZE + CELL_SIZE / 2,
      z: r * CELL_SIZE + CELL_SIZE / 2,
    };
  }
}

module.exports = { Room, LEVELS };
