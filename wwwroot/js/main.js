import * as THREE from 'three';
import { GameModel } from './model/GameModel.js';
import { GameView } from './view/GameView.js';
import { InputController } from './controller/InputController.js';
import { Settings } from './model/Settings.js';
import { MenuView } from './view/MenuView.js';
import { StartMenuView } from './view/StartMenuView.js';
import { NetworkManager } from './net/NetworkManager.js';
import { NetworkPlayerManager } from './net/NetworkPlayerManager.js';
import { LobbyView } from './view/LobbyView.js';

/**
 * Bootstrap — wires Settings, Start Menu, Lobby Menu, Model, View, Controller.
 *
 * Game states:
 *   'start-menu'  →  Title screen over the 3D game world
 *   'lobby'       →  Lobby with loadout / settings / flair + 3D robot preview
 *   'playing'     →  In-game
 *   'paused'      →  In-game with pause overlay (world still renders; MP keeps networking)
 */

// ── Persistent settings (localStorage) ──────────────────────
const settings = new Settings();

// ── Model, View, Controller ─────────────────────────────────
const model = new GameModel(settings);
const view = new GameView(model, settings);
const controller = new InputController(model, view, settings);
const clock = new THREE.Clock();

// ── Apply initial crosshair colour ──────────────────────────
document.documentElement.style.setProperty(
  '--crosshair-color',
  settings.crosshairColor,
);

// ── Menus ───────────────────────────────────────────────────
const startMenu = new StartMenuView(onEnterLobby);
const lobbyMenu = new MenuView(settings, onDeploy, onBackToStart, view.ready);
lobbyMenu.hide(); // lobby starts hidden, start menu is visible

// ── Multiplayer networking ──────────────────────────────────
const net = new NetworkManager(model, view, settings);
const netPlayers = new NetworkPlayerManager(view, model);
view.setNetworkPlayerManager(netPlayers);
controller.net = net;

/**
 * Called when a multiplayer game starts (from LobbyView).
 * Transitions from lobby → playing using the server-provided maze.
 */
function onMultiplayerGameStart() {
  model.multiplayer = true;
  bossSpawned = false;

  // Rebuild the level using server-issued maze data already applied by NetworkManager
  view.buildLevel();
  view.rebuildWeapon();

  gameState = 'playing';
  lobbyMenu.hide();
  if (crosshairEl) crosshairEl.style.display = 'block';
  document.body.requestPointerLock();
  controller.enabled = true;
  clock.getDelta(); // discard stale dt

  // Show multiplayer HUD
  lobbyView.createScoreboard();
  lobbyView.createKillFeed();
  lobbyView.createHealthBar();
  lobbyView.setHudVisible(true);
}

const lobbyView = new LobbyView(net, settings, onMultiplayerGameStart, model);
lobbyMenu.setLobbyView(lobbyView);

// Track enemy count changes (to detect NPC kills for MP scoring)
let previousEnemyCount = 0;
// Track whether boss has been spawned this game
let bossSpawned = false;

/**
 * Handle the server's 'gameWon' event — boss killed, show final scoreboard.
 */
net.onGameWon = (data) => {
  const isWinner = data.winnerId === net.localId;
  const sb = data.scoreboard || {};

  // Build scoreboard HTML
  let rows = '';
  const sorted = Object.entries(sb).sort((a, b) => b[1].score - a[1].score);
  let rank = 0;
  for (const [, p] of sorted) {
    rank++;
    const highlight =
      p.name === data.winnerName ? 'color:#0f0;font-weight:900;' : '';
    rows += `<tr style="${highlight}"><td>${rank}</td><td>${p.name}</td><td>${p.score}</td><td>${p.deaths}</td></tr>`;
  }

  view.showOverlay(
    `<div style="text-align:center;">` +
      `<h1 style="color:${isWinner ? '#0f0' : '#ff4444'};font-size:40px;margin-bottom:8px;">` +
      `${isWinner ? 'VICTORY!' : 'GAME OVER'}</h1>` +
      `<p style="font-size:18px;margin-bottom:4px;">${data.bossKillerName} slew the BOSS!</p>` +
      `<p style="font-size:22px;font-weight:700;margin-bottom:12px;">Winner: ${data.winnerName} (${data.winnerScore} pts)</p>` +
      `<table style="margin:0 auto;border-collapse:collapse;text-align:center;font-size:14px;">` +
      `<tr style="border-bottom:1px solid #555;"><th style="padding:4px 14px;">Rank</th><th style="padding:4px 14px;">Player</th><th style="padding:4px 14px;">Score</th><th style="padding:4px 14px;">Deaths</th></tr>` +
      `${rows}</table></div>`,
  );

  setTimeout(() => {
    view.hideOverlay();
    model.resetGame();
    model.bossLevel = false;
    model.bossEnemy = null;
    bossSpawned = false;
    view.buildLevel();
    returnToLobby();
  }, 8000);
};

// Update health bar from model each frame (done in game loop below)

// ── Game state ──────────────────────────────────────────────
let gameState = 'start-menu'; // 'start-menu' | 'lobby' | 'playing'
let levelTransitionCooldown = 0;
const crosshairEl = document.getElementById('crosshair');

/* ================================================================== */
/*  State transitions                                                  */
/* ================================================================== */

/** Start Menu → Lobby */
function onEnterLobby() {
  gameState = 'lobby';
  startMenu.hide();
  lobbyMenu.show();
}

/** Lobby → Start Menu (BACK button) */
function onBackToStart() {
  gameState = 'start-menu';
  lobbyMenu.hide();
  startMenu.show();
}

/** Lobby → Playing (DEPLOY button) */
function onDeploy() {
  gameState = 'playing';
  model.multiplayer = false;
  lobbyMenu.hide();
  if (crosshairEl) crosshairEl.style.display = 'block';

  // Rebuild weapon in case loadout changed while in lobby
  view.rebuildWeapon();

  document.body.requestPointerLock();
  controller.enabled = true;
  clock.getDelta(); // discard stale dt
}

/** Playing → Lobby (explicit leave action) */
function returnToLobby() {
  if (gameState !== 'playing' && gameState !== 'paused') return;

  // Close pause menu if open
  if (paused) togglePause();

  gameState = 'lobby';
  controller.enabled = false;
  model.player.sprinting = false;
  if (crosshairEl) crosshairEl.style.display = 'none';
  try {
    document.exitPointerLock();
  } catch (_) {
    /* already unlocked */
  }

  // Hide multiplayer HUD when returning to lobby
  if (model.multiplayer) {
    lobbyView.setHudVisible(false);
    net.leaveRoom();
  }

  lobbyMenu.show();
}

/* ================================================================== */
/*  Pause menu overlay                                                 */
/* ================================================================== */
let paused = false;

const pauseOverlay = document.createElement('div');
pauseOverlay.id = 'pause-overlay';
pauseOverlay.style.cssText =
  'position:fixed;inset:0;z-index:40;display:none;align-items:center;justify-content:center;' +
  'background:rgba(0,0,0,0.7);font-family:Arial,sans-serif;color:white;';
document.body.appendChild(pauseOverlay);

function buildPauseMenu() {
  pauseOverlay.innerHTML = '';
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:rgba(20,20,30,0.95);border:2px solid #555;padding:28px 36px;' +
    'min-width:340px;max-width:420px;display:flex;flex-direction:column;gap:16px;';

  // Title
  const title = document.createElement('div');
  title.textContent = model.multiplayer ? 'GAME MENU' : 'PAUSED';
  title.style.cssText =
    'font-size:28px;font-weight:900;letter-spacing:4px;text-align:center;';
  panel.appendChild(title);

  // ── Settings section ──────────────────────────────────
  const settingsHeader = document.createElement('div');
  settingsHeader.textContent = 'SETTINGS';
  settingsHeader.style.cssText =
    'font-size:14px;font-weight:700;letter-spacing:2px;opacity:0.6;margin-top:4px;';
  panel.appendChild(settingsHeader);

  // Sensitivity slider
  panel.appendChild(
    _pauseSlider(
      'Mouse Sensitivity',
      settings.sensitivity,
      0.3,
      3.0,
      0.1,
      (v) => {
        settings.sensitivity = v;
        settings.save();
      },
    ),
  );
  // FOV slider
  panel.appendChild(
    _pauseSlider('Field of View', settings.fov, 60, 110, 5, (v) => {
      settings.fov = v;
      settings.save();
    }),
  );
  // Invert Y toggle
  panel.appendChild(
    _pauseToggle('Invert Y-Axis', settings.invertY, (v) => {
      settings.invertY = v;
      settings.save();
    }),
  );
  // Crosshair colour
  const crosshairColors = [
    '#ffffff',
    '#ff4444',
    '#44ff44',
    '#44ffff',
    '#ffff44',
    '#ff44ff',
  ];
  panel.appendChild(
    _pauseColorPicker(
      'Crosshair Color',
      crosshairColors,
      settings.crosshairColor,
      (c) => {
        settings.crosshairColor = c;
        settings.save();
        document.documentElement.style.setProperty('--crosshair-color', c);
      },
    ),
  );

  // ── Buttons ───────────────────────────────────────────
  const btnRow = document.createElement('div');
  btnRow.style.cssText =
    'display:flex;gap:10px;margin-top:10px;justify-content:center;';

  btnRow.appendChild(_pauseButton('RESUME', '#00cc44', () => togglePause()));

  const leaveLabel = model.multiplayer ? 'LEAVE MATCH' : 'LEAVE';
  btnRow.appendChild(
    _pauseButton(leaveLabel, '#cc4444', () => returnToLobby()),
  );

  panel.appendChild(btnRow);
  pauseOverlay.appendChild(panel);
}

function togglePause() {
  if (gameState !== 'playing' && gameState !== 'paused') return;

  paused = !paused;
  if (paused) {
    gameState = 'paused';
    controller.enabled = false;
    model.player.sprinting = false;
    if (crosshairEl) crosshairEl.style.display = 'none';
    try {
      document.exitPointerLock();
    } catch (_) {
      /* already unlocked */
    }
    buildPauseMenu();
    pauseOverlay.style.display = 'flex';
  } else {
    gameState = 'playing';
    pauseOverlay.style.display = 'none';
    if (crosshairEl) crosshairEl.style.display = 'block';
    document.body.requestPointerLock();
    controller.enabled = true;
  }
}

/* ── Pause menu UI helpers ─────────────────────────────── */
function _pauseSlider(label, value, min, max, step, onChange) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'min-width:140px;font-size:13px;';
  lbl.textContent = label;
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = min;
  slider.max = max;
  slider.step = step;
  slider.value = value;
  slider.style.cssText = 'flex:1;accent-color:#2288ff;cursor:pointer;';
  const valLbl = document.createElement('span');
  valLbl.style.cssText =
    'min-width:36px;text-align:right;font-size:13px;font-weight:600;';
  valLbl.textContent = Number(value).toFixed(step < 1 ? 1 : 0);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valLbl.textContent = v.toFixed(step < 1 ? 1 : 0);
    onChange(v);
  });
  row.append(lbl, slider, valLbl);
  return row;
}

function _pauseToggle(label, value, onChange) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:10px;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'min-width:140px;font-size:13px;';
  lbl.textContent = label;
  const btn = document.createElement('button');
  let current = value;
  const updateBtn = () => {
    btn.textContent = current ? 'ON' : 'OFF';
    btn.style.background = current ? '#2288ff' : 'rgba(255,255,255,0.15)';
  };
  btn.style.cssText =
    'padding:5px 16px;border:none;color:white;cursor:pointer;font-weight:700;font-size:13px;font-family:inherit;';
  updateBtn();
  btn.addEventListener('click', () => {
    current = !current;
    updateBtn();
    onChange(current);
  });
  row.append(lbl, btn);
  return row;
}

function _pauseColorPicker(label, colors, current, onChange) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'min-width:140px;font-size:13px;';
  lbl.textContent = label;
  row.appendChild(lbl);
  for (const c of colors) {
    const swatch = document.createElement('div');
    const isSel = c.toLowerCase() === current.toLowerCase();
    swatch.style.cssText = `width:24px;height:24px;background:${c};cursor:pointer;border:3px solid ${isSel ? '#fff' : 'transparent'};`;
    swatch.addEventListener('click', () => {
      onChange(c);
      row.querySelectorAll('div').forEach((d) => {
        d.style.borderColor = 'transparent';
      });
      swatch.style.borderColor = '#fff';
    });
    row.appendChild(swatch);
  }
  return row;
}

function _pauseButton(label, color, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText =
    `padding:10px 22px;font-size:14px;font-weight:700;letter-spacing:1px;` +
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

/* ── ESC handling ──────────────────────────────────────────
 * ESC toggles the in-game pause overlay. Does NOT return to lobby.
 */
document.addEventListener('keydown', (e) => {
  if (
    e.code === 'Escape' &&
    (gameState === 'playing' || gameState === 'paused')
  ) {
    e.preventDefault();
    togglePause();
  }
});
/* Pointer lock lost while playing → show pause menu (don't return to lobby) */
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && gameState === 'playing' && !paused) {
    togglePause();
  }
});

/* ================================================================== */
/*  Game loop                                                          */
/* ================================================================== */

function gameLoop() {
  requestAnimationFrame(gameLoop);

  const dt = clock.getDelta();

  /* ── Start-menu: render just the game world behind the overlay ── */
  if (gameState === 'start-menu') {
    view.syncCamera();
    view.render();
    return;
  }

  /* ── Lobby: render game world + 3D robot preview on top ──────── */
  if (gameState === 'lobby') {
    view.syncCamera();
    view.render();
    lobbyMenu.renderPreview(dt);
    return;
  }

  /* ── Paused ──────────────────────────────────────────────────── */
  if (gameState === 'paused') {
    // Multiplayer: keep networking and remote players alive
    if (model.multiplayer && net.inGame) {
      const p = model.player;
      net.sendMove(p.x, p.y, p.z, p.yaw, p.pitch);
      view.updateNetworkPlayers(dt);
      lobbyView.updateHealthBar(p.health);
    }
    // Still render the world behind the pause overlay
    view.syncCamera();
    view.render();
    view.drawMinimap();
    return;
  }

  /* ── Playing ─────────────────────────────────────────────────── */
  if (model.gameWon) return;

  // 1. Controller processes input → queues & executes commands
  controller.update();

  // 2. Update fog-of-war from player position
  model.updateFog();

  // 2a. Auto-heal (after 3 s of no damage)
  model.updateAutoHeal(dt);

  // 3. Update viewmodel (ADS transitions)
  view.updateViewmodel();

  // 3a. Advance projectiles and check hits
  const enemyCountBefore = model.enemies.length;
  view.updateProjectiles();
  const enemyCountAfter = model.enemies.length;

  // Detect NPC / boss kills from projectile hits
  if (enemyCountAfter < enemyCountBefore) {
    const killed = enemyCountBefore - enemyCountAfter;
    // Check if the boss was just killed
    if (model.bossEnemy === null && bossSpawned && model.bossLevel === false) {
      // Boss was killed!
      if (model.multiplayer && net.inGame) {
        net.sendBossKill();
      } else {
        // Singleplayer boss kill — instant win
        view.showOverlay(
          `<div><h1 style="color:#0f0;">BOSS DEFEATED!</h1>` +
            `<p style="font-size:22px;">You escaped the maze!</p>` +
            `<p>Total score: ${model.score}</p></div>`,
        );
        setTimeout(() => {
          view.hideOverlay();
          model.resetGame();
          bossSpawned = false;
          view.buildLevel();
          returnToLobby();
        }, 5000);
      }
    } else {
      // Normal NPC kills
      for (let k = 0; k < killed; k++) {
        if (model.multiplayer && net.inGame) {
          net.sendNpcKill();
        }
      }
    }
  }

  // 3b. Animate + move enemies (includes enemy shooting + boss AI)
  view.updateEnemies(dt);

  // 3c. Boss spawn check — when all normal enemies are dead, spawn the boss
  if (!bossSpawned && model.enemies.length === 0 && !model.bossLevel) {
    bossSpawned = true;
    const bossPos = model.getBossSpawnPosition();
    view.spawnBoss(bossPos);
    view.showOverlay(
      `<div><h1 style="color:#ff2222;text-shadow:0 0 20px red;">⚠ BOSS INCOMING ⚠</h1>` +
        `<p style="font-size:16px;">A powerful enemy has appeared! Kill it to win!</p></div>`,
      3000,
    );
  }

  // 3d. Multiplayer: send movement & update remote players
  if (model.multiplayer && net.inGame) {
    const p = model.player;
    net.sendMove(p.x, p.y, p.z, p.yaw, p.pitch);
    view.updateNetworkPlayers(dt);
    lobbyView.updateHealthBar(p.health);
  }

  // 4. Check if player reached the exit gate (singleplayer only, non-boss levels)
  if (!model.multiplayer && !model.bossLevel) {
    if (levelTransitionCooldown > 0) {
      levelTransitionCooldown--;
    } else if (model.isAtExit()) {
      const hasNext = model.nextLevel();
      if (hasNext) {
        bossSpawned = false;
        view.showOverlay(
          `<div><h1>Level ${model.currentLevel + 1}</h1>` +
            `<p>Find the exit gate!</p></div>`,
          2000,
        );
        view.buildLevel();
        levelTransitionCooldown = 120; // ~2 sec at 60fps
      } else {
        // Game won — show overlay then return to lobby
        view.showOverlay(
          `<div><h1 style="color:#0f0;">YOU WIN!</h1>` +
            `<p>You escaped all ${model.levels.length} levels.</p>` +
            `<p>Total kills: ${model.score}</p></div>`,
        );
        setTimeout(() => {
          view.hideOverlay();
          model.resetGame();
          bossSpawned = false;
          view.buildLevel();
          returnToLobby();
        }, 4000);
      }
    }
  }

  // 5. Sync camera + render
  view.syncCamera();
  view.render();

  // 6. HUD + minimap
  view.updateHUD();
  view.drawMinimap();
}

gameLoop();
