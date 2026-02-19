/**
 * LobbyView — Multiplayer lobby UI panel.
 * Shows room browser, create room form, room waiting screen, and in-game scoreboard.
 *
 * Integrates into the existing MenuView as a sub-panel.
 */
export class LobbyView {
  /**
   * @param {import('../net/NetworkManager.js').NetworkManager} net
   * @param {import('../model/Settings.js').Settings} settings
   * @param {Function} onGameStart  – called when game starts (transition to playing)
   */
  constructor(net, settings, onGameStart, model) {
    this.net = net;
    this.settings = settings;
    this._onGameStart = onGameStart;
    this.model = model;

    /** Current sub-state: 'browser' | 'room' | 'connecting' */
    this._state = 'connecting';

    /** Current room list from server */
    this._rooms = [];

    /** Players in current room */
    this._roomPlayers = {};

    /** Room info */
    this._roomInfo = null;

    /** Kill feed entries: { text, time } */
    this._killFeed = [];

    /** DOM container (set by MenuView) */
    this._container = null;

    // Register network callbacks
    this._bindNetworkEvents();
  }

  /* ================================================================== */
  /*  Network event bindings                                             */
  /* ================================================================== */

  _bindNetworkEvents() {
    this.net.onConnected = () => {
      this._state = 'browser';
      this.net.requestRoomList();
      this._rebuild();
    };

    this.net.onDisconnected = () => {
      this._state = 'connecting';
      this._rebuild();
    };

    this.net.onRoomList = (list) => {
      this._rooms = list;
      if (this._state === 'browser') this._rebuild();
    };

    this.net.onRoomJoined = (data) => {
      this._state = 'room';
      this._roomPlayers = data.players;
      this._roomInfo = data.room;
      this._rebuild();
    };

    this.net.onRoomLeft = () => {
      this._state = 'browser';
      this.net.requestRoomList();
      this._rebuild();
    };

    this.net.onPlayerJoined = (data) => {
      this._roomPlayers[data.id] = { name: data.name, id: data.id };
      if (this._state === 'room') this._rebuild();
    };

    this.net.onPlayerLeft = (data) => {
      delete this._roomPlayers[data.id];
      if (this._state === 'room') this._rebuild();
    };

    this.net.onGameStarted = () => {
      if (this._onGameStart) this._onGameStart();
    };

    this.net.onPlayerKilled = (data) => {
      this._addKillFeed(`${data.killerName} killed ${data.targetName}`);
      // If we were killed, show death countdown overlay
      if (data.targetId === this.net.localId) {
        this._showDeathOverlay(data.killerName);
      }
    };

    this.net.onPlayerDamaged = () => {
      this._flashDamage();
      if (this.model) this.model.recordDamage();
    };

    this.net.onHitConfirmed = () => {
      this._flashHitmarker();
    };

    this.net.onError = (msg) => {
      this._showToast(msg);
    };
  }

  /* ================================================================== */
  /*  DOM rendering                                                      */
  /* ================================================================== */

  /**
   * Set the container element (provided by MenuView).
   * @param {HTMLElement} container
   */
  setContainer(container) {
    this._container = container;
    this._rebuild();
  }

  /**
   * Rebuild the lobby UI into the container.
   */
  _rebuild() {
    if (!this._container) return;
    this._container.innerHTML = '';

    switch (this._state) {
      case 'connecting':
        this._buildConnecting();
        break;
      case 'browser':
        this._buildBrowser();
        break;
      case 'room':
        this._buildRoom();
        break;
    }
  }

  /* ── Connecting screen ──────────────────────────────────── */

  _buildConnecting() {
    const div = document.createElement('div');
    div.style.cssText = 'text-align:center;padding:30px;';

    div.innerHTML = `
      <div style="font-size:18px;font-weight:700;margin-bottom:16px;">MULTIPLAYER</div>
      <div style="margin-bottom:12px;opacity:0.7;">Connecting to server...</div>
      <div style="margin-bottom:16px;font-size:12px;opacity:0.5;">${this.settings.serverUrl}</div>
    `;

    // Manual connect button
    const btn = this._makeButton('CONNECT', '#00cc44', () => {
      this.net.connect(this.settings.serverUrl);
    });
    div.appendChild(btn);

    // Server URL input
    const urlGroup = document.createElement('div');
    urlGroup.style.cssText = 'margin-top:12px;';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = this.settings.serverUrl;
    urlInput.placeholder = 'Server URL';
    urlInput.style.cssText =
      'width:100%;padding:8px;background:rgba(0,0,0,0.5);border:1px solid #555;color:white;font-size:13px;box-sizing:border-box;';
    urlInput.addEventListener('change', () => {
      this.settings.serverUrl = urlInput.value;
      this.settings.save();
    });
    urlGroup.appendChild(urlInput);
    div.appendChild(urlGroup);

    // Player name input
    const nameGroup = document.createElement('div');
    nameGroup.style.cssText = 'margin-top:8px;';
    const nameLabel = document.createElement('div');
    nameLabel.textContent = 'Player Name:';
    nameLabel.style.cssText = 'font-size:12px;opacity:0.7;margin-bottom:4px;';
    nameGroup.appendChild(nameLabel);
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = this.settings.playerName;
    nameInput.maxLength = 20;
    nameInput.style.cssText =
      'width:100%;padding:8px;background:rgba(0,0,0,0.5);border:1px solid #555;color:white;font-size:13px;box-sizing:border-box;';
    nameInput.addEventListener('change', () => {
      this.settings.playerName = nameInput.value || 'Player';
      this.settings.save();
    });
    nameGroup.appendChild(nameInput);
    div.appendChild(nameGroup);

    this._container.appendChild(div);
  }

  /* ── Room browser ───────────────────────────────────────── */

  _buildBrowser() {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px;';

    // Header
    const header = document.createElement('div');
    header.style.cssText =
      'display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;';
    header.innerHTML =
      '<div style="font-size:18px;font-weight:700;">ROOMS</div>';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';
    btnRow.appendChild(
      this._makeButton('REFRESH', '#2288ff', () => {
        this.net.requestRoomList();
      }),
    );
    btnRow.appendChild(
      this._makeButton('CREATE', '#00cc44', () => {
        this._showCreateRoomDialog();
      }),
    );
    header.appendChild(btnRow);
    div.appendChild(header);

    // Room list
    const list = document.createElement('div');
    list.style.cssText = 'max-height:250px;overflow-y:auto;';

    if (this._rooms.length === 0) {
      list.innerHTML =
        '<div style="opacity:0.5;text-align:center;padding:20px;">No rooms available. Create one!</div>';
    } else {
      for (const room of this._rooms) {
        const item = document.createElement('div');
        item.style.cssText =
          'display:flex;justify-content:space-between;align-items:center;padding:10px 12px;' +
          'background:rgba(0,0,0,0.3);border:1px solid #444;margin-bottom:6px;cursor:pointer;transition:all 0.2s;';
        item.addEventListener('mouseenter', () => {
          item.style.borderColor = '#00cc44';
        });
        item.addEventListener('mouseleave', () => {
          item.style.borderColor = '#444';
        });

        const info = document.createElement('div');
        info.innerHTML =
          `<div style="font-weight:700;">${this._escHtml(room.name)}</div>` +
          `<div style="font-size:12px;opacity:0.6;">${room.playerCount}/${room.maxPlayers} players • ${room.state}</div>`;
        item.appendChild(info);

        if (room.state === 'waiting' && room.playerCount < room.maxPlayers) {
          const joinBtn = this._makeButton('JOIN', '#00cc44', (e) => {
            e.stopPropagation();
            this.net.joinRoom(room.id);
          });
          item.appendChild(joinBtn);
        }

        item.addEventListener('click', () => {
          if (room.state === 'waiting' && room.playerCount < room.maxPlayers) {
            this.net.joinRoom(room.id);
          }
        });

        list.appendChild(item);
      }
    }
    div.appendChild(list);

    // Connection status
    const status = document.createElement('div');
    status.style.cssText = 'margin-top:8px;font-size:11px;opacity:0.5;';
    status.textContent = `Connected to ${this.settings.serverUrl}`;
    div.appendChild(status);

    this._container.appendChild(div);
  }

  /* ── Room waiting screen ────────────────────────────────── */

  _buildRoom() {
    const div = document.createElement('div');
    div.style.cssText = 'padding:10px;';

    const roomName = this._roomInfo ? this._roomInfo.name : 'Room';
    div.innerHTML = `<div style="font-size:18px;font-weight:700;margin-bottom:12px;">${this._escHtml(roomName)}</div>`;

    // Player list
    const playerList = document.createElement('div');
    playerList.style.cssText = 'margin-bottom:16px;';
    const entries = Object.values(this._roomPlayers);
    for (const p of entries) {
      const row = document.createElement('div');
      row.style.cssText =
        'padding:6px 10px;background:rgba(0,0,0,0.3);margin-bottom:4px;display:flex;align-items:center;gap:8px;';
      const isMe = p.id === this.net.localId;
      const isCreator = this._roomInfo && p.id === this._roomInfo.creatorId;
      row.innerHTML =
        `<span style="color:${isMe ? '#00ff88' : '#fff'};">${this._escHtml(p.name || 'Player')}</span>` +
        (isCreator
          ? ' <span style="font-size:10px;opacity:0.6;color:#ffaa00;">HOST</span>'
          : '') +
        (isMe ? ' <span style="font-size:10px;opacity:0.6;">(you)</span>' : '');
      playerList.appendChild(row);
    }
    div.appendChild(playerList);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';

    if (this.net.isCreator) {
      btnRow.appendChild(
        this._makeButton('START GAME', '#00cc44', () => {
          this.net.startGame();
        }),
      );
    } else {
      const waiting = document.createElement('div');
      waiting.style.cssText = 'opacity:0.6;padding:10px;';
      waiting.textContent = 'Waiting for host to start...';
      btnRow.appendChild(waiting);
    }

    btnRow.appendChild(
      this._makeButton('LEAVE', '#cc4444', () => {
        this.net.leaveRoom();
      }),
    );

    div.appendChild(btnRow);

    this._container.appendChild(div);
  }

  /* ── Create room dialog ─────────────────────────────────── */

  _showCreateRoomDialog() {
    if (!this._container) return;
    this._container.innerHTML = '';

    const div = document.createElement('div');
    div.style.cssText = 'padding:10px;';
    div.innerHTML =
      '<div style="font-size:18px;font-weight:700;margin-bottom:12px;">CREATE ROOM</div>';

    // Room name
    const nameGroup = document.createElement('div');
    nameGroup.style.cssText = 'margin-bottom:10px;';
    nameGroup.innerHTML =
      '<div style="font-size:12px;opacity:0.7;margin-bottom:4px;">Room Name:</div>';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = `${this.settings.playerName}'s Room`;
    nameInput.maxLength = 30;
    nameInput.style.cssText =
      'width:100%;padding:8px;background:rgba(0,0,0,0.5);border:1px solid #555;color:white;font-size:13px;box-sizing:border-box;';
    nameGroup.appendChild(nameInput);
    div.appendChild(nameGroup);

    // Max players
    const maxGroup = document.createElement('div');
    maxGroup.style.cssText = 'margin-bottom:14px;';
    maxGroup.innerHTML =
      '<div style="font-size:12px;opacity:0.7;margin-bottom:4px;">Max Players:</div>';
    const maxSelect = document.createElement('select');
    maxSelect.style.cssText =
      'padding:8px;background:rgba(0,0,0,0.5);border:1px solid #555;color:white;font-size:13px;';
    for (const n of [2, 4, 6, 8, 12, 16]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = String(n);
      if (n === 8) opt.selected = true;
      maxSelect.appendChild(opt);
    }
    maxGroup.appendChild(maxSelect);
    div.appendChild(maxGroup);

    // Buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;';
    btnRow.appendChild(
      this._makeButton('CREATE', '#00cc44', () => {
        this.net.createRoom(nameInput.value, parseInt(maxSelect.value));
      }),
    );
    btnRow.appendChild(
      this._makeButton('CANCEL', '#888', () => {
        this._state = 'browser';
        this._rebuild();
      }),
    );
    div.appendChild(btnRow);

    this._container.appendChild(div);
  }

  /* ================================================================== */
  /*  In-game HUD elements                                               */
  /* ================================================================== */

  /**
   * Create/show the in-game scoreboard (toggled with TAB).
   * @returns {HTMLElement}
   */
  createScoreboard() {
    if (this._scoreboard) return this._scoreboard;

    const sb = document.createElement('div');
    sb.id = 'scoreboard';
    sb.style.cssText =
      'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);' +
      'background:rgba(0,0,0,0.85);border:2px solid #555;padding:20px;' +
      'min-width:400px;z-index:50;display:none;font-family:Arial,sans-serif;color:white;';
    document.body.appendChild(sb);
    this._scoreboard = sb;

    // TAB key toggles
    document.addEventListener('keydown', (e) => {
      if (e.code === 'Tab' && this.net.inGame) {
        e.preventDefault();
        sb.style.display = 'block';
        this._updateScoreboard();
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code === 'Tab') {
        sb.style.display = 'none';
      }
    });

    return sb;
  }

  /**
   * Update the scoreboard contents.
   */
  _updateScoreboard() {
    if (!this._scoreboard) return;

    let html =
      '<div style="font-size:18px;font-weight:700;margin-bottom:12px;text-align:center;">SCOREBOARD</div>';
    html += '<table style="width:100%;border-collapse:collapse;">';
    html +=
      '<tr style="border-bottom:1px solid #555;"><th style="text-align:left;padding:4px 8px;">Player</th><th style="padding:4px 8px;">Kills</th><th style="padding:4px 8px;">Deaths</th><th style="padding:4px 8px;">Health</th></tr>';

    // Local player
    const lp = this.net.model.player;
    html += `<tr style="color:#00ff88;"><td style="padding:4px 8px;">${this._escHtml(this.settings.playerName)} (you)</td><td style="text-align:center;padding:4px 8px;">${lp.score || 0}</td><td style="text-align:center;padding:4px 8px;">${lp.deaths || 0}</td><td style="text-align:center;padding:4px 8px;">${lp.health || 0}</td></tr>`;

    // Network players
    const np = this.net.model.networkPlayers;
    if (np) {
      for (const [, p] of np) {
        html += `<tr><td style="padding:4px 8px;">${this._escHtml(p.name || 'Player')}</td><td style="text-align:center;padding:4px 8px;">${p.score || 0}</td><td style="text-align:center;padding:4px 8px;">${p.deaths || 0}</td><td style="text-align:center;padding:4px 8px;">${p.health || 0}</td></tr>`;
      }
    }

    html += '</table>';
    this._scoreboard.innerHTML = html;
  }

  /**
   * Create the kill feed overlay.
   */
  createKillFeed() {
    if (this._killFeedEl) return;
    this._killFeedEl = document.createElement('div');
    this._killFeedEl.id = 'killfeed';
    this._killFeedEl.style.cssText =
      'position:fixed;top:60px;right:10px;z-index:20;font-family:Arial,sans-serif;' +
      'color:white;font-size:13px;text-shadow:1px 1px 2px black;';
    document.body.appendChild(this._killFeedEl);
  }

  /**
   * Add a kill message to the feed.
   * @param {string} text
   */
  _addKillFeed(text) {
    this._killFeed.push({ text, time: Date.now() });
    // Keep last 5
    if (this._killFeed.length > 5) this._killFeed.shift();
    this._renderKillFeed();

    // Auto-remove after 5 seconds
    setTimeout(() => {
      this._killFeed.shift();
      this._renderKillFeed();
    }, 5000);
  }

  _renderKillFeed() {
    if (!this._killFeedEl) return;
    this._killFeedEl.innerHTML = this._killFeed
      .map(
        (k) =>
          `<div style="padding:2px 6px;background:rgba(0,0,0,0.5);margin-bottom:2px;">${this._escHtml(k.text)}</div>`,
      )
      .join('');
  }

  /**
   * Create a health bar HUD element for multiplayer.
   */
  createHealthBar() {
    if (this._healthBar) return;
    this._healthBar = document.createElement('div');
    this._healthBar.id = 'healthbar';
    this._healthBar.style.cssText =
      'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:20;' +
      'width:200px;height:10px;background:rgba(0,0,0,0.5);border:1px solid #555;';
    const fill = document.createElement('div');
    fill.id = 'healthbar-fill';
    fill.style.cssText =
      'height:100%;background:#00ff44;transition:width 0.3s;width:100%;';
    this._healthBar.appendChild(fill);
    document.body.appendChild(this._healthBar);

    // Health text
    this._healthText = document.createElement('div');
    this._healthText.id = 'healthtext';
    this._healthText.style.cssText =
      'position:fixed;bottom:32px;left:50%;transform:translateX(-50%);z-index:20;' +
      'font:bold 14px Arial;color:white;text-shadow:1px 1px 2px black;';
    document.body.appendChild(this._healthText);
  }

  /**
   * Update the health bar display.
   * @param {number} health
   */
  updateHealthBar(health) {
    const fill = document.getElementById('healthbar-fill');
    if (fill) {
      fill.style.width = `${Math.max(0, health)}%`;
      if (health > 60) fill.style.background = '#00ff44';
      else if (health > 30) fill.style.background = '#ffaa00';
      else fill.style.background = '#ff3333';
    }
    if (this._healthText) {
      this._healthText.textContent = `HP: ${Math.max(0, Math.ceil(health))}`;
    }
  }

  /**
   * Flash crosshair white & expand briefly to show the shooter they hit someone.
   */
  _flashHitmarker() {
    // Flash crosshair color to white
    document.documentElement.style.setProperty('--crosshair-color', '#ffffff');

    // Show an X-shaped hitmarker over the crosshair
    if (!this._hitmarker) {
      this._hitmarker = document.createElement('div');
      this._hitmarker.style.cssText =
        'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:19;pointer-events:none;' +
        'font:bold 26px Arial;color:#fff;text-shadow:0 0 4px #000;opacity:0;transition:opacity 0.12s;';
      this._hitmarker.textContent = '\u2716'; // ✖ heavy multiplication x
      document.body.appendChild(this._hitmarker);
    }
    this._hitmarker.style.opacity = '1';
    clearTimeout(this._hitmarkerTimer);
    this._hitmarkerTimer = setTimeout(() => {
      this._hitmarker.style.opacity = '0';
      // Restore crosshair color from settings
      const s = this.model?.settings || {};
      document.documentElement.style.setProperty(
        '--crosshair-color',
        s.crosshairColor || '#00ff00',
      );
    }, 150);
  }

  /**
   * Flash red screen when damaged.
   */
  _flashDamage() {
    if (!this._damageFlash) {
      this._damageFlash = document.createElement('div');
      this._damageFlash.style.cssText =
        'position:fixed;inset:0;background:rgba(255,0,0,0.3);z-index:18;pointer-events:none;opacity:0;transition:opacity 0.15s;';
      document.body.appendChild(this._damageFlash);
    }
    this._damageFlash.style.opacity = '1';
    setTimeout(() => {
      this._damageFlash.style.opacity = '0';
    }, 200);
  }

  /**
   * Show a toast notification.
   * @param {string} msg
   */
  _showToast(msg) {
    const toast = document.createElement('div');
    toast.style.cssText =
      'position:fixed;bottom:60px;left:50%;transform:translateX(-50%);z-index:100;' +
      'background:rgba(200,50,50,0.9);color:white;padding:10px 20px;font:14px Arial;' +
      'border-radius:4px;transition:opacity 0.5s;';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
    }, 2500);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }

  /**
   * Show/hide multiplayer HUD elements.
   * @param {boolean} visible
   */
  setHudVisible(visible) {
    const display = visible ? 'block' : 'none';
    if (this._healthBar) this._healthBar.style.display = display;
    if (this._healthText) this._healthText.style.display = display;
    if (this._killFeedEl) this._killFeedEl.style.display = display;
    if (!visible && this._deathOverlay) {
      this._deathOverlay.style.display = 'none';
    }
  }

  /* ================================================================== */
  /*  Death overlay + respawn countdown                                  */
  /* ================================================================== */

  /**
   * Show a full-screen death overlay with a 7-second countdown.
   * The player's view stays on their dead position (hover over corpse).
   * @param {string} killerName
   */
  _showDeathOverlay(killerName) {
    if (!this._deathOverlay) {
      this._deathOverlay = document.createElement('div');
      this._deathOverlay.id = 'death-overlay';
      this._deathOverlay.style.cssText =
        'position:fixed;inset:0;z-index:25;display:flex;flex-direction:column;' +
        'align-items:center;justify-content:center;pointer-events:none;' +
        'font-family:Arial,sans-serif;color:white;text-shadow:2px 2px 8px black;' +
        'background:rgba(100,0,0,0.35);';
      document.body.appendChild(this._deathOverlay);
    }

    this._deathOverlay.style.display = 'flex';
    let remaining = 7;

    const update = () => {
      this._deathOverlay.innerHTML =
        `<div style="font-size:48px;font-weight:900;letter-spacing:4px;margin-bottom:12px;color:#ff4444;">YOU DIED</div>` +
        `<div style="font-size:18px;opacity:0.8;margin-bottom:20px;">Killed by ${this._escHtml(killerName)}</div>` +
        `<div style="font-size:72px;font-weight:900;">${remaining}</div>` +
        `<div style="font-size:14px;opacity:0.6;margin-top:8px;">Respawning...</div>`;
    };
    update();

    if (this._deathTimer) clearInterval(this._deathTimer);
    this._deathTimer = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(this._deathTimer);
        this._deathTimer = null;
        this._deathOverlay.style.display = 'none';
        // Server will handle the actual respawn + position
      } else {
        update();
      }
    }, 1000);
  }

  /* ================================================================== */
  /*  Helpers                                                            */
  /* ================================================================== */

  _makeButton(label, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      `padding:8px 16px;font-size:13px;font-weight:700;letter-spacing:1px;` +
      `border:2px solid ${color};background:rgba(0,0,0,0.4);color:white;cursor:pointer;` +
      `transition:all 0.2s;font-family:inherit;white-space:nowrap;`;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = color;
      btn.style.boxShadow = `0 0 15px ${color}80`;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(0,0,0,0.4)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', onClick);
    return btn;
  }

  _escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
