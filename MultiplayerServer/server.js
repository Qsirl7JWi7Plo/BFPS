/**
 * server.js — BFPS Multiplayer Server
 * Node.js + Socket.io backend handling rooms, player sync,
 * movement validation, and server-authoritative hit detection.
 */

const { Server } = require('socket.io');
const http = require('http');
const { Room } = require('./room.js');
const { isBlocked, raycastPlayers } = require('./collision.js');

const PORT = process.env.PORT || 8080;

// Create HTTP server for Socket.io and health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'BFPS server running' }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  }
});

const io = new Server(httpServer, {
  cors: { origin: 'https://bfpstest.netlify.app' },
});

httpServer.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
});

/** @type {Map<string, Room>} roomId → Room */
const rooms = new Map();

/** @type {Map<string, string>} socketId → roomId */
const playerRooms = new Map();

/** @type {Map<string, string>} socketId → playerName */
const playerNames = new Map();

/** Weapon configs — damage values */
const WEAPON_DAMAGE = {
  rifle: 25,
  shotgun: 15, // per pellet (×5 pellets)
  pistol: 20,
};
const WEAPON_RANGE = {
  rifle: 60,
  shotgun: 25,
  pistol: 45,
};
const WEAPON_PELLETS = {
  rifle: 1,
  shotgun: 5,
  pistol: 1,
};

/** Scoring constants */
const SCORE_PLAYER_KILL = 10;
const SCORE_BOSS_KILL = 50;

console.log(`BFPS Multiplayer Server starting on port ${PORT}...`);

/* ================================================================== */
/*  Connection handler                                                 */
/* ================================================================== */

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  /* ── Set player name ────────────────────────────────────── */
  socket.on('setName', (name) => {
    playerNames.set(socket.id, (name || 'Player').substring(0, 20));
  });

  /* ── List rooms ─────────────────────────────────────────── */
  socket.on('listRooms', () => {
    const list = [];
    for (const room of rooms.values()) {
      list.push(room.getInfo());
    }
    socket.emit('roomList', list);
  });

  /* ── Create room ────────────────────────────────────────── */
  socket.on('createRoom', ({ name, maxPlayers, arena }) => {
    // Leave current room if in one
    _leaveCurrentRoom(socket);

    const room = new Room(
      (name || 'Game Room').substring(0, 30),
      Math.min(maxPlayers || 8, 16),
      socket.id,
    );

    // Optional arena flag: create an open flat arena instead of a maze
    room.flatArena = !!arena;

    rooms.set(room.id, room);

    const playerName = playerNames.get(socket.id) || 'Player';
    room.addPlayer(socket.id, playerName, 'rifle');
    playerRooms.set(socket.id, room.id);
    socket.join(`room:${room.id}`);

    socket.emit('roomJoined', {
      roomId: room.id,
      room: room.getInfo(),
      players: room.getGameState().players,
      isCreator: true,
    });

    // If game already started, send this player their persisted level/maze/enemies
    if (room.state === 'playing') {
      const p = room.players.get(socket.id);
      const level = p.level || 0;
      const perPlayerEnemies =
        (room.playerEnemies && room.playerEnemies.get(socket.id)) || new Map();
      const enemies = perPlayerEnemies.get(level) || [];
      socket.emit('playerLevelAdvanced', {
        maze: room.maze,
        startCell: room.startCell,
        exitCell: room.exitCell,
        level,
        enemies,
      });
    }

    // Broadcast updated room list to everyone
    _broadcastRoomList();
  });

  /* ── Join room ──────────────────────────────────────────── */
  socket.on('joinRoom', (roomId) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    if (room.players.size >= room.maxPlayers) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    if (room.state === 'playing') {
      socket.emit('error', { message: 'Game already in progress' });
      return;
    }

    // Leave current room if in one
    _leaveCurrentRoom(socket);

    const playerName = playerNames.get(socket.id) || 'Player';
    room.addPlayer(socket.id, playerName, 'rifle');
    playerRooms.set(socket.id, room.id);
    socket.join(`room:${room.id}`);

    socket.emit('roomJoined', {
      roomId: room.id,
      room: room.getInfo(),
      players: room.getGameState().players,
      isCreator: room.creatorId === socket.id,
    });

    // Notify other players in the room
    socket.to(`room:${room.id}`).emit('playerJoined', {
      id: socket.id,
      name: playerName,
    });

    _broadcastRoomList();
  });

  /* ── Leave room ─────────────────────────────────────────── */
  socket.on('leaveRoom', () => {
    _leaveCurrentRoom(socket);
    _broadcastRoomList();
  });

  /* ── Player reached exit (per-player progression in multiplayer) ── */
  socket.on('playerReachedExit', () => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player) return;

    // Advance this player's personal level counter
    player.level = (player.level || 0) + 1;
    const level = player.level;

    // Create a new maze for the player's personal progression (same size as room base)
    const base = LEVELS[Math.min(level, LEVELS.length - 1)] || LEVELS[0];
    const rows = base.rows;
    const cols = base.cols;
    const maze = room.flatArena
      ? {
          grid: Array.from({ length: rows }, () =>
            Array.from({ length: cols }, () => ({
              north: true,
              south: true,
              east: true,
              west: true,
            })),
          ),
          rows,
          cols,
        }
      : generateMaze(rows, cols);
    const startCell = { r: 0, c: 0 };
    const exitCell = { r: rows - 1, c: cols - 1 };

    // Persist enemy placements for this player's new level
    const count = base.enemies || 5;
    const enemyPositions = room._generateEnemyPositions(rows, cols, count);
    const map = room.playerEnemies.get(socket.id) || new Map();
    map.set(level, enemyPositions);
    room.playerEnemies.set(socket.id, map);

    // Send the new personal maze + enemy list to the owning player only
    socket.emit('playerLevelAdvanced', {
      maze,
      startCell,
      exitCell,
      level,
      enemies: enemyPositions,
    });
  });

  /* ── Update weapon (in lobby) ───────────────────────────── */
  socket.on('updateWeapon', (weapon) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (player) player.weapon = weapon;
  });

  /* ── Start game ─────────────────────────────────────────── */
  socket.on('startGame', () => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.creatorId !== socket.id) {
      socket.emit('error', {
        message: 'Only the room creator can start the game',
      });
      return;
    }
    if (room.state === 'playing') return;

    room.startGame();

    io.to(`room:${room.id}`).emit('gameStarted', room.getStartPayload());

    // Send each player their persisted level/maze/enemies so they can be on different levels
    for (const [id, p] of room.players.entries()) {
      const level = p.level || 0;
      const perPlayerEnemies =
        (room.playerEnemies && room.playerEnemies.get(id)) || new Map();
      const enemies = perPlayerEnemies.get(level) || [];
      const sock = io.sockets.sockets.get(id);
      if (sock) {
        sock.emit('playerLevelAdvanced', {
          maze: room.maze,
          startCell: room.startCell,
          exitCell: room.exitCell,
          level,
          enemies,
        });
      }
    }

    _broadcastRoomList();
  });

  /* ── Player movement ────────────────────────────────────── */
  socket.on('move', (data) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    // Validate position — reject if blocked
    const newX = Number(data.x) || 0;
    const newZ = Number(data.z) || 0;

    // Anti-teleport: check distance moved (max ~1 unit per tick at 20Hz)
    const dx = newX - player.x;
    const dz = newZ - player.z;
    const distSq = dx * dx + dz * dz;
    const maxMoveDist = 3.0; // generous limit (sprint + frame variance)
    if (distSq > maxMoveDist * maxMoveDist) {
      // Teleport detected — reject silently
      socket.emit('positionCorrection', {
        x: player.x,
        y: player.y,
        z: player.z,
      });
      return;
    }

    // Check wall collision on server
    if (!isBlocked(room.maze, newX, newZ, 0.4)) {
      player.x = newX;
      player.z = newZ;
    } else {
      // Send correction to client
      socket.emit('positionCorrection', {
        x: player.x,
        y: player.y,
        z: player.z,
      });
      return;
    }

    player.y = Number(data.y) || 2;
    player.yaw = Number(data.yaw) || 0;
    player.pitch = Number(data.pitch) || 0;
    player.sprinting = !!data.sprinting;

    // Detect exit crossing server-side to avoid client race
    if (room._isExitPos(player.x, player.z)) {
      console.log(
        `[Server] player ${socket.id} hit exit at`,
        player.x.toFixed(2),
        player.z.toFixed(2),
      );
      // Advance only once per crossing; store flag on player object temporarily
      if (!player._exitTriggered) {
        player._exitTriggered = true;
        room.advancePlayerLevel(socket.id, (pid, payload) => {
          io.to(pid).emit('playerLevelAdvanced', payload);
        });
      }
    } else {
      player._exitTriggered = false;
    }

    // Broadcast to other players in the room
    socket.to(`room:${room.id}`).emit('playerMoved', {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      sprinting: player.sprinting,
    });
  });

  /* ── Shooting (server-authoritative hit detection) ──────── */
  socket.on('shoot', (data) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;
    const shooter = room.players.get(socket.id);
    if (!shooter || !shooter.alive) return;

    const origin = {
      x: data.origin?.x != null ? Number(data.origin.x) : shooter.x,
      y: data.origin?.y != null ? Number(data.origin.y) : shooter.y,
      z: data.origin?.z != null ? Number(data.origin.z) : shooter.z,
    };
    const direction = {
      x: data.direction?.x != null ? Number(data.direction.x) : 0,
      y: data.direction?.y != null ? Number(data.direction.y) : 0,
      z: data.direction?.z != null ? Number(data.direction.z) : -1,
    };
    // Normalise direction
    const len = Math.sqrt(
      direction.x ** 2 + direction.y ** 2 + direction.z ** 2,
    );
    if (len > 0) {
      direction.x /= len;
      direction.y /= len;
      direction.z /= len;
    }

    const weapon = data.weapon || shooter.weapon || 'rifle';
    const maxRange = WEAPON_RANGE[weapon] || 60;
    const damage = WEAPON_DAMAGE[weapon] || 25;
    const pellets = WEAPON_PELLETS[weapon] || 1;
    const spread = weapon === 'shotgun' ? 0.08 : 0;

    // Broadcast the shot visually to all other players
    socket.to(`room:${room.id}`).emit('playerShot', {
      id: socket.id,
      origin,
      direction,
      weapon,
    });

    // Debug: log shoot info
    const otherPlayers = [...room.players].filter(
      ([id]) => id !== socket.id && room.players.get(id).alive,
    );
    console.log(
      `[Shoot] ${shooter.name} at (${origin.x.toFixed(1)},${origin.y.toFixed(1)},${origin.z.toFixed(1)}) dir (${direction.x.toFixed(2)},${direction.y.toFixed(2)},${direction.z.toFixed(2)}) weapon=${weapon} targets=${otherPlayers.length}`,
    );

    // Server-side hit detection for each pellet
    for (let p = 0; p < pellets; p++) {
      const dir = { ...direction };
      if (spread > 0) {
        dir.x += (Math.random() - 0.5) * spread;
        dir.y += (Math.random() - 0.5) * spread;
        dir.z += (Math.random() - 0.5) * spread;
        const l = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2);
        if (l > 0) {
          dir.x /= l;
          dir.y /= l;
          dir.z /= l;
        }
      }

      const hit = raycastPlayers(
        origin,
        dir,
        maxRange,
        room.players,
        socket.id,
        room.maze,
      );
      if (hit) {
        console.log(
          `[Hit] ${shooter.name} hit ${room.players.get(hit.targetId)?.name} at dist=${hit.distance.toFixed(1)} dmg=${damage}`,
        );
        const target = room.players.get(hit.targetId);
        if (target && target.alive) {
          target.health -= damage;

          if (target.health <= 0) {
            target.health = 0;
            target.alive = false;
            target.deaths++;
            shooter.score += SCORE_PLAYER_KILL;

            io.to(`room:${room.id}`).emit('playerKilled', {
              killerId: socket.id,
              killerName: shooter.name,
              targetId: hit.targetId,
              targetName: target.name,
              killerScore: shooter.score,
            });

            // Queue respawn
            room.queueRespawn(hit.targetId, 3000);
          } else {
            // Notify the hit player of damage
            io.to(hit.targetId).emit('playerDamaged', {
              health: target.health,
              attackerId: socket.id,
            });
            // Notify shooter of hit confirmation
            socket.emit('hitConfirmed', {
              targetId: hit.targetId,
              damage,
              targetHealth: target.health,
            });
          }
        }
      }
    }
  });

  /* ── NPC kill (client-side hit, server tracks score) ──── */
  socket.on('npcKill', () => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;
    const player = room.players.get(socket.id);
    if (player) {
      player.score += 3; // NPC kill = 3 pts
    }
  });

  /* ── Boss kill (triggers win state for the room) ──────── */
  socket.on('bossKill', () => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room || room.state !== 'playing') return;
    const killer = room.players.get(socket.id);
    if (!killer) return;

    killer.score += SCORE_BOSS_KILL;

    // Determine winner (highest score)
    let winner = null;
    let highScore = -1;
    for (const [, p] of room.players) {
      if (p.score > highScore) {
        highScore = p.score;
        winner = p;
      }
    }

    // Broadcast game over to everyone in the room
    const scoreboard = {};
    for (const [id, p] of room.players) {
      scoreboard[id] = { name: p.name, score: p.score, deaths: p.deaths };
    }

    io.to(`room:${room.id}`).emit('gameWon', {
      bossKillerId: socket.id,
      bossKillerName: killer.name,
      winnerId: winner ? winner.id : socket.id,
      winnerName: winner ? winner.name : killer.name,
      winnerScore: highScore,
      scoreboard,
    });

    // Reset room to waiting state
    room.state = 'waiting';
    room.maze = null;
    for (const [, p] of room.players) {
      p.score = 0;
      p.deaths = 0;
      p.health = 100;
      p.alive = true;
    }
    _broadcastRoomList();
  });

  /* ── Disconnect ─────────────────────────────────────────── */
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    _leaveCurrentRoom(socket);
    playerNames.delete(socket.id);
    _broadcastRoomList();
  });
});

/* ================================================================== */
/*  Helper functions                                                   */
/* ================================================================== */

function _leaveCurrentRoom(socket) {
  const roomId = playerRooms.get(socket.id);
  if (!roomId) return;

  const room = rooms.get(roomId);
  if (room) {
    room.removePlayer(socket.id);
    socket.leave(`room:${room.id}`);

    // Notify remaining players
    socket.to(`room:${room.id}`).emit('playerLeft', {
      id: socket.id,
    });

    // Delete empty rooms
    if (room.isEmpty) {
      rooms.delete(roomId);
    } else {
      // If creator changed, notify
      socket.to(`room:${room.id}`).emit('roomUpdated', room.getInfo());
    }
  }

  playerRooms.delete(socket.id);
}

function _broadcastRoomList() {
  const list = [];
  for (const room of rooms.values()) {
    list.push(room.getInfo());
  }
  io.emit('roomList', list);
}

/* ================================================================== */
/*  Periodic updates                                                   */
/* ================================================================== */

// Game state broadcast + respawn processing every 50ms (20 Hz)
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;

    // Process respawns
    const respawned = room.processRespawns();
    for (const resp of respawned) {
      io.to(`room:${room.id}`).emit('playerRespawned', {
        id: resp.playerId,
        x: resp.x,
        y: resp.y,
        z: resp.z,
      });
    }

    // Periodic exit check (in case move event wasn't triggered)
    for (const [pid, pl] of room.players.entries()) {
      if (pl.alive && room._isExitPos(pl.x, pl.z)) {
        console.log(`[Server] periodic exit hit for ${pid}`);
        room.advancePlayerLevel(pid, (playerId, payload) => {
          io.to(playerId).emit('playerLevelAdvanced', payload);
        });
      }
    }

    // Broadcast full game state for reconciliation
    io.to(`room:${room.id}`).emit('gameState', room.getGameState());

    // Also persist and periodically send per-player enemy updates if present
    if (room.playerEnemies) {
      for (const [playerId, levelMap] of room.playerEnemies.entries()) {
        const player = room.players.get(playerId);
        if (!player) continue;
        const level = player.level || 0;
        const enemies = levelMap.get(level) || [];
        // Send only to the owning player
        const sock = io.sockets.sockets.get(playerId);
        if (sock) sock.emit('enemyUpdate', { level, enemies });
      }
    }
  }
}, 50);

console.log(`BFPS Multiplayer Server running on port ${PORT}`);
