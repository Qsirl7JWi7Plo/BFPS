/**
 * NetworkManager — handles all Socket.io communication for multiplayer.
 * Provides a clean API for the rest of the game to interact with the server.
 *
 * @module NetworkManager
 */
export class NetworkManager {
  /**
   * @param {import('../model/GameModel.js').GameModel} model
   * @param {import('../view/GameView.js').GameView} view
   * @param {import('../model/Settings.js').Settings} settings
   */
  constructor(model, view, settings) {
    this.model = model;
    this.view = view;
    this.settings = settings;

    /** @type {any} Socket.io socket instance */
    this.socket = null;

    /** Whether we're connected to the server */
    this.connected = false;

    /** Current room ID (null if not in a room) */
    this.roomId = null;

    /** Whether we are the room creator */
    this.isCreator = false;

    /** Whether a multiplayer game is active */
    this.inGame = false;

    /** Our socket ID (assigned by server) */
    this.localId = null;

    /** Movement send throttle (20 Hz) */
    this._lastMoveSend = 0;
    this._moveSendInterval = 50; // ms

    /* ── Callbacks (set by LobbyView / main.js) ──────────── */
    /** @type {Function|null} */
    this.onRoomList = null;
    /** @type {Function|null} */
    this.onRoomJoined = null;
    /** @type {Function|null} */
    this.onRoomLeft = null;
    /** @type {Function|null} */
    this.onPlayerJoined = null;
    /** @type {Function|null} */
    this.onPlayerLeft = null;
    /** @type {Function|null} */
    this.onGameStarted = null;
    /** @type {Function|null} */
    this.onPlayerKilled = null;
    /** @type {Function|null} */
    this.onPlayerDamaged = null;
    /** @type {Function|null} */
    this.onError = null;
    /** @type {Function|null} */
    this.onConnected = null;
    /** @type {Function|null} */
    this.onDisconnected = null;
    /** @type {Function|null} */
    this.onHitConfirmed = null;
    /** @type {Function|null} */
    this.onGameWon = null;
  }

  /* ================================================================== */
  /*  Connection                                                         */
  /* ================================================================== */

  /**
   * Connect to the multiplayer server.
   * @param {string} [url] - Server URL (defaults to settings.serverUrl)
   */
  connect(url) {
    if (this.socket) this.disconnect();

    const serverUrl = url || this.settings.serverUrl || 'http://localhost:3000';
    console.log(`[Net] Connecting to ${serverUrl}...`);

    // Socket.io is loaded globally via <script> tag
    this.socket = io(serverUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    this._bindEvents();
  }

  /**
   * Disconnect from the server.
   */
  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.roomId = null;
    this.isCreator = false;
    this.inGame = false;
    this.localId = null;
  }

  /* ================================================================== */
  /*  Event binding                                                      */
  /* ================================================================== */

  _bindEvents() {
    const s = this.socket;

    s.on('connect', () => {
      console.log(
        `[Net] Connected as ${s.id}` +
          (this.settings.playerId ? ` (pid=${this.settings.playerId})` : ''),
      );
      this.connected = true;
      this.localId = s.id;

      // Send player name
      const name = this.settings.playerName || 'Player';
      s.emit('setName', name);

      if (this.onConnected) this.onConnected();
    });

    s.on('disconnect', () => {
      console.log('[Net] Disconnected');
      this.connected = false;
      this.inGame = false;
      this.roomId = null;
      if (this.onDisconnected) this.onDisconnected();
    });

    s.on('error', (data) => {
      console.warn('[Net] Error:', data.message);
      if (this.onError) this.onError(data.message);
    });

    /* ── Lobby events ─────────────────────────────────────── */

    s.on('roomList', (list) => {
      if (this.onRoomList) this.onRoomList(list);
    });

    s.on('roomJoined', (data) => {
      this.roomId = data.roomId;
      this.isCreator = data.isCreator;
      // Store remote players in model
      this.model.networkPlayers = new Map();
      for (const [id, player] of Object.entries(data.players)) {
        if (id !== this.localId) {
          this.model.networkPlayers.set(id, player);
        }
      }
      if (this.onRoomJoined) this.onRoomJoined(data);
    });

    s.on('playerJoined', (data) => {
      console.log(`[Net] Player joined: ${data.name} (${data.id})`);
      if (this.onPlayerJoined) this.onPlayerJoined(data);
    });

    s.on('playerLeft', (data) => {
      console.log(`[Net] Player left: ${data.id}`);
      this.model.networkPlayers.delete(data.id);
      if (this.view._networkPlayerManager) {
        this.view._networkPlayerManager.removePlayer(data.id);
      }
      if (this.onPlayerLeft) this.onPlayerLeft(data);
    });

    s.on('roomUpdated', (info) => {
      if (info.creatorId === this.localId) this.isCreator = true;
    });

    /* ── Game events ──────────────────────────────────────── */

    s.on('gameStarted', (data) => {
      console.log('[Net] Game started!');
      this.inGame = true;

      // Set up player positions from server BEFORE applying maze
      // (applyServerMaze reveals fog around the player's actual spawn cell)
      this.model.networkPlayers = new Map();
      for (const [id, player] of Object.entries(data.players)) {
        if (id !== this.localId) {
          this.model.networkPlayers.set(id, player);
        } else {
          // Update local player position from server
          this.model.player.x = player.x;
          this.model.player.y = player.y;
          this.model.player.z = player.z;
          this.model.player.yaw = player.yaw;
          this.model.player.pitch = player.pitch;
        }
      }

      // Apply maze after local player position is set
      this.model.applyServerMaze(
        data.maze,
        data.startCell,
        data.exitCell,
        data.level,
      );

      if (this.onGameStarted) this.onGameStarted(data);
    });

    // Per-player level advancement from server (personal maze + enemies)
    s.on('playerLevelAdvanced', (data) => {
      console.log('[Net] Player level advanced →', data.level);

      // Ensure the local player is placed at the server-provided start cell
      if (data.startCell) {
        const world = this.model.cellToWorld(
          data.startCell.r,
          data.startCell.c,
        );
        this.model.player.x = world.x;
        this.model.player.z = world.z;
        this.model.player.y = 2;
        this.model.player.yaw = 0;
        this.model.player.pitch = 0;
        this.model.player.alive = true;
        this.model.player.health = 100;
      }

      if (data.maze) {
        // Replace local maze with server-provided maze for this player
        this.model.applyServerMaze(
          data.maze,
          data.startCell,
          data.exitCell,
          data.level,
        );
      }

      // Rebuild view so the new start position and maze take effect immediately
      if (this.view) {
        this.view.buildLevel();
        this.view.syncCamera();
      }

      // Show level-up overlay
      if (this.view) {
        this.view.showOverlay(
          `<div style="text-align:center;"><h1>Level ${data.level + 1}</h1>` +
            `<p>Welcome to your personal maze!</p></div>`,
          2000,
        );
      }

      // Spawn server-provided enemies (client-side visuals/AI)
      if (this.view && this.view.spawnEnemiesFromServer) {
        this.view.spawnEnemiesFromServer(data.enemies || []);
      }

      // always request pointerlock after teleporting/level-up
      try {
        document.body.requestPointerLock();
      } catch {}
    });

    s.on('playerMoved', (data) => {
      if (!this.inGame) return;
      const np = this.model.networkPlayers.get(data.id);
      if (np) {
        np.x = data.x;
        np.y = data.y;
        np.z = data.z;
        np.yaw = data.yaw;
        np.pitch = data.pitch;
        np.sprinting = data.sprinting;
      } else {
        // New player mid-game
        this.model.networkPlayers.set(data.id, {
          ...data,
          health: 100,
          score: 0,
          alive: true,
        });
      }
      // Push snapshot for interpolation
      if (this.view._networkPlayerManager) {
        this.view._networkPlayerManager.pushSnapshot(data.id, data);
      }
    });

    s.on('playerShot', (data) => {
      if (!this.inGame) return;
      // Spawn visual-only remote projectile
      if (this.view.spawnRemoteProjectile) {
        this.view.spawnRemoteProjectile(
          data.origin,
          data.direction,
          data.weapon,
        );
      }
    });

    s.on('playerDamaged', (data) => {
      if (!this.inGame) return;
      // We got hit — flash screen red, update health
      this.model.player.health = data.health;
      if (this.onPlayerDamaged) this.onPlayerDamaged(data);
    });

    s.on('hitConfirmed', (data) => {
      // Flash the hit player's model red so the shooter sees feedback
      if (this.view._networkPlayerManager) {
        this.view._networkPlayerManager.flashHit(data.targetId);
      }
      if (this.onHitConfirmed) this.onHitConfirmed(data);
    });

    s.on('playerKilled', (data) => {
      if (!this.inGame) return;
      // Update scores
      if (data.targetId === this.localId) {
        this.model.player.health = 0;
        this.model.player.alive = false;
      }
      const targetNp = this.model.networkPlayers.get(data.targetId);
      if (targetNp) {
        targetNp.alive = false;
        targetNp.health = 0;
      }
      // Update killer score
      if (data.killerId === this.localId) {
        this.model.player.score = data.killerScore;
      }
      const killerNp = this.model.networkPlayers.get(data.killerId);
      if (killerNp) killerNp.score = data.killerScore;

      if (this.onPlayerKilled) this.onPlayerKilled(data);
    });

    s.on('playerRespawned', (data) => {
      if (!this.inGame) return;
      if (data.id === this.localId) {
        this.model.player.x = data.x;
        this.model.player.y = data.y;
        this.model.player.z = data.z;
        this.model.player.health = 100;
        this.model.player.alive = true;
      } else {
        const np = this.model.networkPlayers.get(data.id);
        if (np) {
          np.x = data.x;
          np.y = data.y;
          np.z = data.z;
          np.health = 100;
          np.alive = true;
        }
      }
    });

    s.on('positionCorrection', (data) => {
      // Server rejected our position — snap back
      this.model.player.x = data.x;
      this.model.player.y = data.y;
      this.model.player.z = data.z;
    });

    s.on('gameWon', (data) => {
      if (this.onGameWon) this.onGameWon(data);
    });

    s.on('gameState', (data) => {
      if (!this.inGame) return;
      // Reconcile with authoritative game state
      for (const [id, player] of Object.entries(data.players)) {
        if (id === this.localId) {
          // Update health/score from server (position stays local for responsiveness)
          this.model.player.health = player.health;
          this.model.player.score = player.score;
          this.model.player.alive = player.alive;
        } else {
          const np = this.model.networkPlayers.get(id);
          if (np) {
            // Smooth update — position comes from playerMoved events
            np.health = player.health;
            np.score = player.score;
            np.alive = player.alive;
            np.deaths = player.deaths;
            np.name = player.name;
            // Also feed the interpolation buffer from gameState (backup path)
            if (this.view._networkPlayerManager) {
              this.view._networkPlayerManager.pushSnapshot(id, player);
            }
          } else {
            this.model.networkPlayers.set(id, player);
          }
        }
      }

      // Remove players that are no longer in the game state
      for (const id of this.model.networkPlayers.keys()) {
        if (!data.players[id]) {
          this.model.networkPlayers.delete(id);
          if (this.view._networkPlayerManager) {
            this.view._networkPlayerManager.removePlayer(id);
          }
        }
      }
    });
  }

  /* ================================================================== */
  /*  Outgoing commands                                                  */
  /* ================================================================== */

  /** Request the current room list */
  requestRoomList() {
    if (!this.socket || !this.connected) return;
    this.socket.emit('listRooms');
  }

  /**
   * Create a new room.
   * @param {string} name
   * @param {number} maxPlayers
   */
  createRoom(name, maxPlayers, arena = false) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('createRoom', { name, maxPlayers, arena });
  }

  /**
   * Join an existing room.
   * @param {string} roomId
   */
  joinRoom(roomId) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('joinRoom', roomId);
  }

  /** Leave the current room. */
  leaveRoom() {
    if (!this.socket || !this.connected) return;
    this.socket.emit('leaveRoom');
    this.roomId = null;
    this.isCreator = false;
    this.inGame = false;
    if (this.onRoomLeft) this.onRoomLeft();
  }

  /** Start the game (creator only). */
  startGame() {
    if (!this.socket || !this.connected) return;
    this.socket.emit('startGame');
  }

  /** Update weapon choice in lobby. */
  updateWeapon(weapon) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('updateWeapon', weapon);
  }

  /**
   * Send local player movement to the server (throttled to 20 Hz).
   */
  sendMove() {
    if (!this.socket || !this.connected || !this.inGame) return;
    if (!this.model.player.alive) return;

    const now = performance.now();
    if (now - this._lastMoveSend < this._moveSendInterval) return;
    this._lastMoveSend = now;

    const p = this.model.player;
    this.socket.emit('move', {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      sprinting: p.sprinting,
    });
  }

  /**
   * Send a shoot event to the server.
   * @param {{ x: number, y: number, z: number }} origin
   * @param {{ x: number, y: number, z: number }} direction
   */
  sendShoot(origin, direction) {
    if (!this.socket || !this.connected || !this.inGame) return;
    if (!this.model.player.alive) return;

    this.socket.emit('shoot', {
      origin,
      direction,
      weapon: this.settings.weaponType || 'rifle',
    });
  }

  /**
   * Notify server that the local player reached the exit in multiplayer.
   */
  sendPlayerReachedExit() {
    if (!this.socket || !this.connected || !this.inGame) return;
    this.socket.emit('playerReachedExit');
  }

  /**
   * Notify server that this client killed an NPC enemy (for score tracking).
   */
  sendNpcKill() {
    if (!this.socket || !this.connected || !this.inGame) return;
    this.socket.emit('npcKill');
  }

  /**
   * Notify server that this client killed the boss (triggers win state).
   */
  sendBossKill() {
    if (!this.socket || !this.connected || !this.inGame) return;
    this.socket.emit('bossKill');
  }
}
