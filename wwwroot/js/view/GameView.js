import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.158/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'https://cdn.jsdelivr.net/npm/three@0.158/examples/jsm/utils/SkeletonUtils.js';

/**
 * GameView — owns the Three.js scene, camera rig, renderer, and model loading.
 * (MVC: View layer)
 */
export class GameView {
  /**
   * @param {import('../model/GameModel.js').GameModel} model
   */
  constructor(model, settings) {
    this.model = model;
    this.settings = settings;

    // ── Scene ───────────────────────────────────────────────
    this.scene = new THREE.Scene();
    // Procedural starry night background (instant — no network fetch)
    this.scene.background = this._createStarrySkyTexture();

    // ── Camera rig (yaw → pitch → camera) ──────────────────
    this.yawObject = new THREE.Object3D();
    this.pitchObject = new THREE.Object3D();
    const _baseFov = settings ? settings.fov : 75;
    this.camera = new THREE.PerspectiveCamera(
      _baseFov,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.pitchObject.add(this.camera);
    this.yawObject.add(this.pitchObject);
    this.yawObject.position.y = model.player.y;
    this.scene.add(this.yawObject);

    // ── Viewmodel scene (player arms — rendered on top) ─
    this.viewmodelScene = new THREE.Scene();
    this.viewmodelCamera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.1,
      10,
    );
    this.viewmodelScene.add(new THREE.AmbientLight(0xffffff, 1.0));
    const vmDir = new THREE.DirectionalLight(0xffffff, 0.6);
    vmDir.position.set(1, 2, 1);
    this.viewmodelScene.add(vmDir);
    this.viewmodelScene.add(this.viewmodelCamera);

    // ── Renderer ────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false); // false = don't touch CSS
    this.renderer.autoClear = false;
    // CSS handles full-viewport sizing; z-index keeps it behind UI overlays.
    this.renderer.domElement.style.cssText =
      'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:0;display:block;';
    document.body.appendChild(this.renderer.domElement);

    // ── Lighting ────────────────────────────────────────────
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);

    // ── Raycaster ───────────────────────────────────────────
    this.raycaster = new THREE.Raycaster();

    // ── Resize handler ──────────────────────────────────────
    window.addEventListener('resize', () => this._onResize());

    // ── Minimap canvas ──────────────────────────────────────
    this._initMinimap();

    // ── HUD elements ────────────────────────────────────────
    this._initHUD();

    // ── Projectile pool ─────────────────────────────────────
    this._initProjectilePool();

    // ── Clock for animation delta ───────────────────────────
    this._clock = new THREE.Clock();

    // ── Enemy AI data ───────────────────────────────────────
    this._enemyData = [];
    this._lastShotTime = 0;

    /** Enemy shooting: detection range (world units) */
    this._enemyDetectRange = 15;
    /** Cooldown between enemy shots (ms) */
    this._enemyShotCooldown = 2000;
    /** Enemy projectile damage */
    this._enemyDamage = 8;
    /** Enemy projectile speed */
    this._enemyProjSpeed = 0.4;

    /** Boss data (if boss level active) */
    this._bossData = null;

    // ── Cached GLTF for enemy / player / weapons ────────────
    this._soldierGltf = null;
    this._robotGltf = null;
    this._weaponGltfs = {}; // { rifle, shotgun, pistol }

    // ── Player character (third-person body in world scene) ─
    // Invisible to local first-person camera via layers;
    // Remote players on layer 1 (visible), local body on layer 2 (invisible).
    this._playerBody = null;
    this._playerBodyMixer = null;
    this._playerBodyGroundY = 0;
    /** @const {number} Layer for remote third-person player bodies */
    this.PLAYER_LAYER = 1;
    /** @const {number} Layer for LOCAL player body (invisible to self) */
    this.LOCAL_BODY_LAYER = 2;

    /** @type {import('../net/NetworkPlayerManager.js').NetworkPlayerManager|null} */
    this._networkPlayerManager = null;

    // ── Groups for easy teardown between levels ─────────────
    this._mazeGroup = null;
    this._exitGate = null;

    // ── Apply initial settings ──────────────────────────────
    if (this.settings) {
      document.documentElement.style.setProperty(
        '--crosshair-color',
        this.settings.crosshairColor,
      );
      this.settings.onChange(() => this._onSettingsChanged());
    }

    // ── Preload GLTFs then build level ──────────────────────
    /** @type {Promise<void>} resolves when all models are loaded and level is built */
    this.ready = this._preloadModels().then(() => this.buildLevel());

    // Expose for runtime inspection in browser console (debugging only)
    try {
      window.__bfps_gameView = this;
      console.log('[GameView] exposed as window.__bfps_gameView');
    } catch (e) {}
  }

  /* ════════════════════════════════════════════════════════════ */
  /*  Procedural starry-night background                         */
  /* ════════════════════════════════════════════════════════════ */

  _createStarrySkyTexture() {
    const size = 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Night-sky gradient (visible, not pure black)
    const grad = ctx.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#050518');
    grad.addColorStop(0.4, '#0c0c2a');
    grad.addColorStop(0.75, '#141435');
    grad.addColorStop(1, '#1a1a40');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);

    // Stars — varied sizes and brightness
    const starCount = 800;
    for (let i = 0; i < starCount; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() * 2.0 + 0.4;
      const brightness = Math.floor(200 + Math.random() * 55);
      const blue = Math.min(255, brightness + 30);
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${brightness},${brightness},${blue},${0.7 + Math.random() * 0.3})`;
      ctx.fill();
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ================================================================== */
  /*  HUD                                                                */
  /* ================================================================== */

  _initHUD() {
    // Level / score HUD
    this._hud = document.getElementById('hud');
    if (!this._hud) {
      this._hud = document.createElement('div');
      this._hud.id = 'hud';
      this._hud.style.cssText =
        'position:fixed;top:10px;left:10px;color:white;font:bold 16px Arial;z-index:15;text-shadow:1px 1px 2px black;';
      document.body.appendChild(this._hud);
    }

    // Level transition overlay
    this._levelOverlay = document.getElementById('levelOverlay');
    if (!this._levelOverlay) {
      this._levelOverlay = document.createElement('div');
      this._levelOverlay.id = 'levelOverlay';
      this._levelOverlay.style.cssText =
        'position:fixed;inset:0;display:none;align-items:center;justify-content:center;color:white;' +
        'background:rgba(0,0,0,0.85);z-index:25;text-align:center;font-family:Arial,sans-serif;';
      document.body.appendChild(this._levelOverlay);
    }
  }

  /**
   * Show a level-transition or win screen.
   * @param {string} html
   * @param {number} [autoHideMs] – auto-dismiss after ms (0 = stays)
   */
  showOverlay(html, autoHideMs = 0) {
    this._levelOverlay.innerHTML = html;
    this._levelOverlay.style.display = 'flex';
    if (autoHideMs > 0) {
      setTimeout(() => {
        this._levelOverlay.style.display = 'none';
      }, autoHideMs);
    }
  }

  hideOverlay() {
    this._levelOverlay.style.display = 'none';
  }

  updateHUD() {
    const m = this.model;
    const hp = Math.max(0, m.player.health);
    const hpColor = hp > 60 ? '#0f0' : hp > 30 ? '#ff0' : '#f00';
    const hpBar = `<span style="color:${hpColor};">${'█'.repeat(Math.ceil(hp / 10))}${'░'.repeat(10 - Math.ceil(hp / 10))}</span> ${hp}`;
    if (m.bossLevel) {
      this._hud.innerHTML =
        `Level: ${m.currentLevel + 1} / ${m.levels.length}<br>` +
        `<span style="color:#ff4444;font-weight:900;">⚠ BOSS FIGHT ⚠</span><br>` +
        `HP: ${hpBar}<br>` +
        `Score: ${m.score}`;
    } else {
      this._hud.innerHTML =
        `Level: ${m.currentLevel + 1} / ${m.levels.length}<br>` +
        `Enemies: ${m.enemies.length} remaining<br>` +
        `HP: ${hpBar}<br>` +
        `Score: ${m.score}`;
    }
  }

  /* ================================================================== */
  /*  Minimap                                                            */
  /* ================================================================== */

  _initMinimap() {
    this._minimapSize = 180; // CSS pixels
    this._minimapCanvas = document.getElementById('minimap');
    if (!this._minimapCanvas) {
      this._minimapCanvas = document.createElement('canvas');
      this._minimapCanvas.id = 'minimap';
      this._minimapCanvas.style.cssText =
        `position:fixed;bottom:10px;right:10px;width:${this._minimapSize}px;height:${this._minimapSize}px;` +
        `border:2px solid rgba(255,255,255,0.4);z-index:15;image-rendering:pixelated;background:rgba(0,0,0,0.5);`;
      document.body.appendChild(this._minimapCanvas);
    }
    // High-res internal canvas for sharp lines
    this._minimapCanvas.width = 512;
    this._minimapCanvas.height = 512;
    this._mmCtx = this._minimapCanvas.getContext('2d');
  }

  /**
   * Redraw the minimap. Called every frame.
   */
  drawMinimap() {
    const m = this.model;
    if (!m.maze) return;

    const ctx = this._mmCtx;
    const { grid, rows, cols } = m.maze;
    const size = 512;
    const cellPx = size / Math.max(rows, cols);

    ctx.clearRect(0, 0, size, size);

    // Pass 1 — cell floor fills (drawn first so walls render on top)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!m.discovered.has(`${r},${c}`)) continue;
        const x = c * cellPx;
        const y = r * cellPx;
        ctx.fillStyle =
          r === m.exitCell.r && c === m.exitCell.c ? '#005500' : '#333';
        ctx.fillRect(x, y, cellPx, cellPx);
      }
    }

    // Pass 2 — wall rects (fillRect for pixel-perfect rendering at any scale)
    const wallPx = Math.max(2, Math.round(cellPx * 0.06));
    ctx.fillStyle = '#bbb';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!m.discovered.has(`${r},${c}`)) continue;
        const x = c * cellPx;
        const y = r * cellPx;
        const cell = grid[r][c];
        if (!cell.north) ctx.fillRect(x, y - wallPx / 2, cellPx, wallPx);
        if (!cell.south)
          ctx.fillRect(x, y + cellPx - wallPx / 2, cellPx, wallPx);
        if (!cell.west) ctx.fillRect(x - wallPx / 2, y, wallPx, cellPx);
        if (!cell.east)
          ctx.fillRect(x + cellPx - wallPx / 2, y, wallPx, cellPx);
      }
    }

    // Draw exit marker
    if (m.discovered.has(`${m.exitCell.r},${m.exitCell.c}`)) {
      const ex = m.exitCell.c * cellPx + cellPx / 2;
      const ey = m.exitCell.r * cellPx + cellPx / 2;
      ctx.fillStyle = '#0f0';
      ctx.font = `bold ${cellPx * 0.6}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('EXIT', ex, ey);
    }

    // Draw enemies as red dots
    for (const enemy of m.enemies) {
      const ec = m.worldToCell(enemy.position.x, enemy.position.z);
      if (m.discovered.has(`${ec.r},${ec.c}`)) {
        ctx.fillStyle = '#f00';
        ctx.beginPath();
        ctx.arc(
          ec.c * cellPx + cellPx / 2,
          ec.r * cellPx + cellPx / 2,
          cellPx * 0.15,
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }

    // Draw player as bright dot + direction
    const pc = m.worldToCell(m.player.x, m.player.z);
    const px = pc.c * cellPx + cellPx / 2;
    const py = pc.r * cellPx + cellPx / 2;
    const hudColor = (this.settings && this.settings.hudAccent) || '#0af';
    ctx.fillStyle = hudColor;
    ctx.beginPath();
    ctx.arc(px, py, cellPx * 0.25, 0, Math.PI * 2);
    ctx.fill();

    // Direction indicator
    const dirLen = cellPx * 0.45;
    // In our coordinate system, yaw=0 faces −Z which is "up" on the minimap
    const dx = -Math.sin(m.player.yaw) * dirLen;
    const dy = -Math.cos(m.player.yaw) * dirLen;
    ctx.strokeStyle = hudColor;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + dx, py + dy);
    ctx.stroke();
  }

  /* ================================================================== */
  /*  Model preloading                                                   */
  /* ================================================================== */

  async _preloadModels() {
    const loader = new GLTFLoader();
    const loadAsync = (url) =>
      new Promise((resolve, reject) =>
        loader.load(url, resolve, undefined, reject),
      );

    const [soldier, robot, rifle, shotgun, pistol] = await Promise.all([
      loadAsync('/assets/models/characters/enemy.glb'),
      loadAsync('/assets/models/characters/player.glb'),
      loadAsync('/assets/models/weapons/rifle.glb'),
      loadAsync('/assets/models/weapons/shotgun.glb'),
      loadAsync('/assets/models/weapons/pistol.glb'),
    ]);
    this._soldierGltf = soldier;
    this._robotGltf = robot;
    this._weaponGltfs = { rifle, shotgun, pistol };

    // Debug visibility in console
    try {
      console.log('[GameView] Models loaded:', {
        soldier: !!this._soldierGltf,
        robot: !!this._robotGltf,
        weapons: Object.keys(this._weaponGltfs || {}),
      });
    } catch (e) {}

    // ── Compute runtime scale for enemy model ───────────────
    // Instead of baking scale into vertices (which destroys skeleton
    // binding), measure the native bounding box and compute a uniform
    // scale factor so the model renders at TARGET_HEIGHT.
    const TARGET_HEIGHT = 1.8; // metres
    const _tmpScene = soldier.scene.clone();
    const _bb = new THREE.Box3().setFromObject(_tmpScene);
    const nativeH = _bb.max.y - _bb.min.y;
    this._enemyScale = nativeH > 0.01 ? TARGET_HEIGHT / nativeH : 1;
    this._enemyGroundY = -_bb.min.y * this._enemyScale;
    console.log(
      `Enemy native height: ${nativeH.toFixed(2)}, scale: ${this._enemyScale.toFixed(6)}, groundY: ${this._enemyGroundY.toFixed(3)}`,
    );
  }

  /* ================================================================== */
  /*  Level building                                                     */
  /* ================================================================== */

  /**
   * Build (or rebuild) the 3D maze, floor, exit gate, enemies, and arms
   * from current model state.
   */
  buildLevel() {
    // ── Tear down previous level objects ─────────────────────
    if (this._mazeGroup) this.scene.remove(this._mazeGroup);
    if (this._exitGate) this.scene.remove(this._exitGate);
    // Remove old enemies from scene
    for (const e of this.model.enemies) this.scene.remove(e);
    // Remove old floor if any
    if (this._floor) this.scene.remove(this._floor);

    // ── Clean up enemy animation data ───────────────────────
    for (const data of this._enemyData) {
      data.mixer.stopAllAction();
      data.mixer.uncacheRoot(data.enemy);
    }
    this._enemyData = [];

    // ── Recycle all active projectiles ───────────────────────
    for (const proj of this._activeProjectiles) {
      proj.mesh.visible = false;
      this._projectilePool.push(proj.mesh);
    }
    this._activeProjectiles = [];

    const m = this.model;
    const cs = m.cellSize;
    const wh = m.wallHeight;
    const { grid, rows, cols } = m.maze;

    // ── Floor sized to maze ─────────────────────────────────
    const floorW = cols * cs;
    const floorH = rows * cs;
    this._floor = new THREE.Mesh(
      new THREE.PlaneGeometry(floorW, floorH),
      new THREE.MeshStandardMaterial({ color: 0x333333 }),
    );
    this._floor.rotation.x = -Math.PI / 2;
    this._floor.position.set(floorW / 2, 0, floorH / 2);
    this.scene.add(this._floor);

    // ── Ceiling ─────────────────────────────────────────────
    if (this._ceiling) this.scene.remove(this._ceiling);
    this._ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(floorW, floorH),
      new THREE.MeshStandardMaterial({ color: 0x222222, side: THREE.BackSide }),
    );
    this._ceiling.rotation.x = -Math.PI / 2;
    this._ceiling.position.set(floorW / 2, wh, floorH / 2);
    this.scene.add(this._ceiling);

    // ── Build maze walls ────────────────────────────────────
    this._mazeGroup = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x666666 });
    const wallThickness = 0.2;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = grid[r][c];
        const cx = c * cs;
        const cz = r * cs;

        // North wall (top edge of cell)
        if (!cell.north) {
          const wall = new THREE.Mesh(
            new THREE.BoxGeometry(cs, wh, wallThickness),
            wallMat,
          );
          wall.position.set(cx + cs / 2, wh / 2, cz);
          this._mazeGroup.add(wall);
        }
        // West wall (left edge of cell)
        if (!cell.west) {
          const wall = new THREE.Mesh(
            new THREE.BoxGeometry(wallThickness, wh, cs),
            wallMat,
          );
          wall.position.set(cx, wh / 2, cz + cs / 2);
          this._mazeGroup.add(wall);
        }
      }
    }

    // Outer border — south wall of last row
    for (let c = 0; c < cols; c++) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(cs, wh, wallThickness),
        wallMat,
      );
      wall.position.set(c * cs + cs / 2, wh / 2, rows * cs);
      this._mazeGroup.add(wall);
    }
    // Outer border — east wall of last column
    for (let r = 0; r < rows; r++) {
      const wall = new THREE.Mesh(
        new THREE.BoxGeometry(wallThickness, wh, cs),
        wallMat,
      );
      wall.position.set(cols * cs, wh / 2, r * cs + cs / 2);
      this._mazeGroup.add(wall);
    }

    this.scene.add(this._mazeGroup);

    // ── Exit gate ───────────────────────────────────────────
    this._buildExitGate();

    // ── Enemies ─────────────────────────────────────────────
    if (this._soldierGltf) this._spawnEnemies();

    // ── Player arms (only first time) ───────────────────────
    if (!this._viewmodel && this._robotGltf) this._loadPlayerArms();

    // ── Player body (third-person model for multiplayer) ────
    if (this._robotGltf) this._spawnPlayerBody();

    // ── Sync camera to new start ────────────────────────────
    this.syncCamera();
    this.updateHUD();
  }

  /* ------------------------------------------------------------------ */
  /*  Exit gate                                                          */
  /* ------------------------------------------------------------------ */

  _buildExitGate() {
    const m = this.model;
    const pos = m.cellToWorld(m.exitCell.r, m.exitCell.c);
    const cs = m.cellSize;

    this._exitGate = new THREE.Group();

    // Glowing green portal
    const portalGeo = new THREE.BoxGeometry(cs * 0.6, m.wallHeight * 0.8, 0.1);
    const portalMat = new THREE.MeshStandardMaterial({
      color: 0x00ff00,
      emissive: 0x00ff00,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.5,
    });
    const portal = new THREE.Mesh(portalGeo, portalMat);
    portal.position.set(pos.x, m.wallHeight * 0.4, pos.z);
    this._exitGate.add(portal);

    // Frame pillars
    const pillarGeo = new THREE.BoxGeometry(0.3, m.wallHeight, 0.3);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x888888 });
    const leftPillar = new THREE.Mesh(pillarGeo, pillarMat);
    leftPillar.position.set(pos.x - cs * 0.3, m.wallHeight / 2, pos.z);
    this._exitGate.add(leftPillar);

    const rightPillar = new THREE.Mesh(pillarGeo, pillarMat);
    rightPillar.position.set(pos.x + cs * 0.3, m.wallHeight / 2, pos.z);
    this._exitGate.add(rightPillar);

    // Top bar
    const topBar = new THREE.Mesh(
      new THREE.BoxGeometry(cs * 0.6 + 0.3, 0.3, 0.3),
      pillarMat,
    );
    topBar.position.set(pos.x, m.wallHeight * 0.85, pos.z);
    this._exitGate.add(topBar);

    // Point light for glow
    const glow = new THREE.PointLight(0x00ff00, 2, cs * 2);
    glow.position.set(pos.x, m.wallHeight * 0.5, pos.z);
    this._exitGate.add(glow);

    this.scene.add(this._exitGate);
  }

  /* ------------------------------------------------------------------ */
  /*  Enemy spawning                                                     */
  /* ------------------------------------------------------------------ */

  _spawnEnemies() {
    const positions = this.model.getEnemySpawnPositions();
    const clips = this._soldierGltf.animations || [];

    // Log available animations for debugging
    console.log(
      'Enemy animations:',
      clips.map((c) => c.name),
    );

    // Find walk/run clip; fall back to any clip
    const walkClip =
      clips.find((c) => /walk/i.test(c.name)) ||
      clips.find((c) => /run/i.test(c.name)) ||
      clips.find((c) => /move/i.test(c.name)) ||
      clips.find((c) => /locomotion/i.test(c.name)) ||
      clips[0];

    // Runtime scale factor (computed in _preloadModels)
    const s = this._enemyScale || 1;
    const groundY = this._enemyGroundY || 0;

    for (const pos of positions) {
      const enemy = skeletonClone(this._soldierGltf.scene);

      // Apply uniform runtime scale — preserves skeleton binding perfectly
      enemy.scale.set(s, s, s);
      enemy.position.set(pos.x, groundY, pos.z);

      this.scene.add(enemy);
      this.model.addEnemy(enemy);

      // Animation mixer
      const mixer = new THREE.AnimationMixer(enemy);
      if (walkClip) {
        const action = mixer.clipAction(walkClip);
        action.play();
      }

      // AI movement data
      this._enemyData.push({
        enemy,
        mixer,
        targetX: pos.x,
        targetZ: pos.z,
        speed: 0.02 + Math.random() * 0.02,
        lastShotTime: 0, // for shooting cooldown
        isBoss: false,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Player body (third-person model visible to other players)          */
  /* ------------------------------------------------------------------ */

  /**
   * Spawn (or re-spawn) the local player's full character model in the
   * world scene.  This body is placed on PLAYER_LAYER so it is invisible
   * to the local first-person camera but will be seen by future
   * multiplayer spectator / remote-player cameras.
   */
  _spawnPlayerBody() {
    // Clean up previous body if any (level transition)
    if (this._playerBody) {
      this.scene.remove(this._playerBody);
      if (this._playerBodyMixer) {
        this._playerBodyMixer.stopAllAction();
        this._playerBodyMixer.uncacheRoot(this._playerBody);
      }
      this._playerBody = null;
      this._playerBodyMixer = null;
    }

    const gltf = this._robotGltf;
    if (!gltf) return;

    const body = skeletonClone(gltf.scene);

    // Ground offset so feet sit on floor (y = 0)
    const bbox = new THREE.Box3().setFromObject(body);
    this._playerBodyGroundY = -bbox.min.y;

    // Place on LOCAL_BODY_LAYER so local FPS camera (layer 0 + layer 1) won't render it.
    // Remote player bodies use PLAYER_LAYER (1) and are visible.
    body.layers.set(this.LOCAL_BODY_LAYER);
    body.traverse((child) => {
      child.layers.set(this.LOCAL_BODY_LAYER);
    });

    // Initial position — will be updated each frame in syncCamera()
    const p = this.model.player;
    body.position.set(p.x, this._playerBodyGroundY, p.z);
    body.rotation.y = p.yaw;

    this.scene.add(body);
    this._playerBody = body;

    // Play idle animation
    const clips = gltf.animations || [];
    const idleClip =
      clips.find((c) => /idle/i.test(c.name)) ||
      clips.find((c) => /stand/i.test(c.name)) ||
      clips[0];
    if (idleClip) {
      this._playerBodyMixer = new THREE.AnimationMixer(body);
      this._playerBodyMixer.clipAction(idleClip).play();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Viewmodel (player arms + weapon)                                   */
  /* ------------------------------------------------------------------ */

  _loadPlayerArms() {
    const gltf = this._robotGltf;
    if (!gltf) return;

    // ── Build weapon from GLB ─────────────────────────────
    const wType = this.settings ? this.settings.weaponType : 'rifle';
    const wSkin = this.settings ? this.settings.weaponSkin : '#222222';
    const weapon = this._createWeapon(wType, wSkin);

    // ── Standard FPS viewmodel layout ────────────────────────
    // Weapon GLBs are metric (1 unit = 1 m) with grip at origin,
    // barrel along −Z.  Mount directly on viewmodelCamera so
    // −Z = camera forward = barrel direction.  No rotation needed.
    //
    // Hip-fire position: right of centre, below crosshair, forward
    // ADS position:      centred on crosshair, closer to camera
    this._hipPos = new THREE.Vector3(0.18, -0.14, -0.4);
    this._adsPos = new THREE.Vector3(0.0, -0.08, -0.32);
    this._vmPos = this._hipPos.clone();

    weapon.position.copy(this._hipPos);
    this.viewmodelCamera.add(weapon);

    this._viewmodel = weapon; // ADS lerp target
    this._weapon = weapon;
    this._handBone = null; // not used in direct-mount mode
  }

  /* ------------------------------------------------------------------ */
  /*  Weapon loader (GLB assets)                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Clone a weapon GLB, apply the player's skin colour to the 'Metal'
   * material, and return the root Group.
   * @param {string} type  'rifle' | 'shotgun' | 'pistol'
   * @param {string} skinColor  CSS colour string, e.g. '#ff0000'
   * @returns {THREE.Group}
   */
  _createWeapon(type, skinColor) {
    const key = type || 'rifle';
    const gltf = this._weaponGltfs[key];
    if (!gltf) {
      console.warn(`Weapon GLB not loaded: ${key}`);
      return new THREE.Group();
    }
    const clone = gltf.scene.clone(true);

    // Apply skin colour to the 'Metal' material (deep-clone materials so
    // each weapon instance can have its own colour).
    const color = new THREE.Color(skinColor || '#888888');
    clone.traverse((child) => {
      if (!child.isMesh) return;
      child.material = child.material.clone();
      if (child.material.name === 'Metal') {
        child.material.color.copy(color);
      }
    });

    // Runtime safety: detect muzzle side by sampling vertex 'slices' at each Z extreme
    // and flip if the muzzle is on +Z (viewmodel expects muzzle → -Z).
    try {
      const muzzleOnPositiveZ = (group) => {
        let minZ = Infinity,
          maxZ = -Infinity;
        const verts = [];
        group.traverse((m) => {
          if (
            !m.isMesh ||
            !m.geometry ||
            !m.geometry.attributes ||
            !m.geometry.attributes.position
          )
            return;
          const a = m.geometry.attributes.position.array;
          for (let i = 0; i < a.length; i += 3) {
            const x = a[i],
              y = a[i + 1],
              z = a[i + 2];
            verts.push([x, y, z]);
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
          }
        });
        if (verts.length === 0) return false;
        const tol = Math.max((maxZ - minZ) * 0.03, 1e-5);

        const sideBox = (threshold, cmp) => {
          let minX = Infinity,
            maxX = -Infinity,
            minY = Infinity,
            maxY = -Infinity,
            count = 0;
          for (const v of verts) {
            const [x, y, z] = v;
            if (cmp(z, threshold)) {
              minX = Math.min(minX, x);
              maxX = Math.max(maxX, x);
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
              count++;
            }
          }
          return { minX, maxX, minY, maxY, count };
        };

        const minSide = sideBox(minZ + tol, (z, t) => z <= t);
        const maxSide = sideBox(maxZ - tol, (z, t) => z >= t);
        if (minSide.count === 0 || maxSide.count === 0) return false; // inconclusive → don't flip

        const minArea =
          (minSide.maxX - minSide.minX) * (minSide.maxY - minSide.minY) ||
          Infinity;
        const maxArea =
          (maxSide.maxX - maxSide.minX) * (maxSide.maxY - maxSide.minY) ||
          Infinity;
        // muzzle is the thinner end (smaller XY area). If the +Z end is thinner, muzzle is +Z.
        return maxArea < minArea;
      };

      if (muzzleOnPositiveZ(clone)) {
        clone.rotateY(Math.PI);
        console.debug(`Flipped weapon orientation for ${key} (muzzle was +Z)`);
      }
    } catch (e) {
      console.warn('Weapon orientation check failed:', e);
    }

    return clone;
  }

  /* ------------------------------------------------------------------ */
  /*  Viewmodel ADS (aim-down-sights) update                             */
  /* ------------------------------------------------------------------ */

  /**
   * Call each frame to smoothly interpolate the viewmodel between
   * hip-fire and ADS positions.  Also narrows the viewmodel camera
   * FOV when aiming (industry standard zoom effect).
   */
  updateViewmodel() {
    if (!this._viewmodel) return;

    const aiming = this.model.aiming;
    const target = aiming ? this._adsPos : this._hipPos;
    const lerpSpeed = 0.12; // smoothing factor (0-1, higher = snappier)

    // Smoothly interpolate position
    this._vmPos.lerp(target, lerpSpeed);
    this._viewmodel.position.copy(this._vmPos);

    // FOV zoom: use settings FOV as base
    const baseFov = this.settings ? this.settings.fov : 75;
    const targetFov = aiming ? baseFov * 0.6 : baseFov * 0.93;
    this.viewmodelCamera.fov +=
      (targetFov - this.viewmodelCamera.fov) * lerpSpeed;
    this.viewmodelCamera.updateProjectionMatrix();

    // Also zoom the main camera for the world view
    const worldTargetFov = aiming ? baseFov * 0.67 : baseFov;
    this.camera.fov += (worldTargetFov - this.camera.fov) * lerpSpeed;
    this.camera.updateProjectionMatrix();
  }

  /* ------------------------------------------------------------------ */
  /*  Projectile pool                                                    */
  /* ------------------------------------------------------------------ */

  _initProjectilePool(count = 30) {
    this._projectilePool = [];
    this._activeProjectiles = [];
    const geo = new THREE.SphereGeometry(0.1, 6, 6);
    const projColor = this.settings ? this.settings.projectileColor : '#ffff00';
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(projColor),
    });
    this._projectileMat = mat;
    for (let i = 0; i < count; i++) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this._projectilePool.push(mesh);
    }
  }

  /**
   * Fire projectile(s) from the weapon muzzle toward the crosshair.
   * Behaviour varies by weapon type.
   */
  spawnProjectile() {
    const type = this.settings ? this.settings.weaponType : 'rifle';
    const wpnCfg = {
      rifle: { cooldown: 150, speed: 0.8, range: 60, pellets: 1, spread: 0 },
      shotgun: {
        cooldown: 500,
        speed: 0.6,
        range: 25,
        pellets: 5,
        spread: 0.08,
      },
      pistol: { cooldown: 80, speed: 1.0, range: 45, pellets: 1, spread: 0 },
    }[type] || { cooldown: 150, speed: 0.8, range: 60, pellets: 1, spread: 0 };

    const now = performance.now();
    if (now - this._lastShotTime < wpnCfg.cooldown) return;
    this._lastShotTime = now;

    // Camera world-space vectors
    const camPos = new THREE.Vector3();
    this.camera.getWorldPosition(camPos);
    const camDir = new THREE.Vector3();
    this.camera.getWorldDirection(camDir);

    // Camera-local right & up
    const right = new THREE.Vector3()
      .crossVectors(camDir, this.camera.up)
      .normalize();
    const up = new THREE.Vector3().crossVectors(right, camDir).normalize();

    // Muzzle offset: 0.3 right, −0.15 down, 0.5 forward
    const muzzle = camPos
      .clone()
      .addScaledVector(right, 0.3)
      .addScaledVector(up, -0.15)
      .addScaledVector(camDir, 0.5);

    // Aim point (60 units out from camera) — direction converges on crosshair
    const aimPoint = camPos.clone().addScaledVector(camDir, 60);
    const baseDir = new THREE.Vector3()
      .subVectors(aimPoint, muzzle)
      .normalize();

    for (let p = 0; p < wpnCfg.pellets; p++) {
      if (this._projectilePool.length === 0) return;

      const dir = baseDir.clone();
      if (wpnCfg.spread > 0) {
        dir.x += (Math.random() - 0.5) * wpnCfg.spread;
        dir.y += (Math.random() - 0.5) * wpnCfg.spread;
        dir.z += (Math.random() - 0.5) * wpnCfg.spread;
        dir.normalize();
      }

      const mesh = this._projectilePool.pop();
      mesh.position.copy(muzzle);
      mesh.visible = true;

      this._activeProjectiles.push({
        mesh,
        velocity: dir.multiplyScalar(wpnCfg.speed),
        distance: 0,
        maxDistance: wpnCfg.range,
      });
    }
  }

  /**
   * Advance active projectiles, check wall / enemy / player collisions,
   * and recycle spent rounds back into the pool.
   */
  updateProjectiles() {
    for (let i = this._activeProjectiles.length - 1; i >= 0; i--) {
      const proj = this._activeProjectiles[i];

      // Move
      proj.mesh.position.add(proj.velocity);
      proj.distance += proj.velocity.length();

      // Wall collision
      const { x, z } = proj.mesh.position;
      if (this.model.isBlocked(x, z, 0.08)) {
        this._recycleProjectile(i);
        continue;
      }

      // Enemy projectile → damages the LOCAL player
      if (proj.enemyProjectile) {
        const pdx = x - this.model.player.x;
        const pdz = z - this.model.player.z;
        if (pdx * pdx + pdz * pdz < 1.0 && this.model.player.alive) {
          this.model.player.health -= proj.damage || 8;
          this.model.recordDamage();
          // Visual feedback: red flash
          this._flashEnemyDamage();
          if (this.model.player.health <= 0) {
            this.model.player.health = 0;
            this.model.player.alive = false;
          }
          this._recycleProjectile(i);
          continue;
        }
      }

      // Player projectile → hits enemies (skip for remote-only projectiles)
      if (!proj.remoteOnly && !proj.enemyProjectile) {
        let hitEnemy = null;
        for (const enemy of this.model.enemies) {
          const edx = x - enemy.position.x;
          const edz = z - enemy.position.z;
          if (edx * edx + edz * edz < 1.0) {
            // ~1 unit hit radius
            hitEnemy = enemy;
            break;
          }
        }
        if (hitEnemy) {
          const isBoss = hitEnemy === this.model.bossEnemy;
          this.removeFromScene(hitEnemy);
          this.model.removeEnemy(hitEnemy, isBoss);
          this._removeEnemyData(hitEnemy);
          if (isBoss) {
            this.model.bossEnemy = null;
            this.model.bossLevel = false;
            this._bossData = null;
          }
          this._recycleProjectile(i);
          continue;
        }
      }

      // Max distance
      if (proj.distance > proj.maxDistance) {
        this._recycleProjectile(i);
      }
    }
  }

  /** Return a projectile mesh to the pool. */
  _recycleProjectile(index) {
    const proj = this._activeProjectiles[index];
    proj.mesh.visible = false;
    this._projectilePool.push(proj.mesh);
    this._activeProjectiles.splice(index, 1);
  }

  /* ------------------------------------------------------------------ */
  /*  Remote projectiles (visual only — no hit detection)                 */
  /* ------------------------------------------------------------------ */

  /**
   * Spawn a visual-only projectile from a remote player.
   * No collision/damage — that's handled server-side.
   * @param {{ x: number, y: number, z: number }} origin
   * @param {{ x: number, y: number, z: number }} direction
   * @param {string} weapon
   */
  spawnRemoteProjectile(origin, direction, weapon) {
    const wpnCfg = {
      rifle: { speed: 0.8, range: 60, pellets: 1, spread: 0 },
      shotgun: { speed: 0.6, range: 25, pellets: 5, spread: 0.08 },
      pistol: { speed: 1.0, range: 45, pellets: 1, spread: 0 },
    }[weapon] || { speed: 0.8, range: 60, pellets: 1, spread: 0 };

    const baseDir = {
      x: direction.x || 0,
      y: direction.y || 0,
      z: direction.z || -1,
    };
    const len = Math.sqrt(baseDir.x ** 2 + baseDir.y ** 2 + baseDir.z ** 2);
    if (len > 0) {
      baseDir.x /= len;
      baseDir.y /= len;
      baseDir.z /= len;
    }

    for (let p = 0; p < wpnCfg.pellets; p++) {
      if (this._projectilePool.length === 0) return;

      const dir = { ...baseDir };
      if (wpnCfg.spread > 0) {
        dir.x += (Math.random() - 0.5) * wpnCfg.spread;
        dir.y += (Math.random() - 0.5) * wpnCfg.spread;
        dir.z += (Math.random() - 0.5) * wpnCfg.spread;
        const l = Math.sqrt(dir.x ** 2 + dir.y ** 2 + dir.z ** 2);
        if (l > 0) {
          dir.x /= l;
          dir.y /= l;
          dir.z /= l;
        }
      }

      const mesh = this._projectilePool.pop();
      mesh.position.set(origin.x || 0, origin.y || 2, origin.z || 0);
      mesh.visible = true;

      this._activeProjectiles.push({
        mesh,
        velocity: new THREE.Vector3(
          dir.x * wpnCfg.speed,
          dir.y * wpnCfg.speed,
          dir.z * wpnCfg.speed,
        ),
        distance: 0,
        maxDistance: wpnCfg.range,
        remoteOnly: true, // skip enemy hit detection
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Network player management                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Set the network player manager (called from main.js after net init).
   * @param {import('../net/NetworkPlayerManager.js').NetworkPlayerManager} manager
   */
  setNetworkPlayerManager(manager) {
    this._networkPlayerManager = manager;
  }

  /**
   * Update network player interpolation. Called each frame.
   * @param {number} dt
   */
  updateNetworkPlayers(dt) {
    if (this._networkPlayerManager) {
      this._networkPlayerManager.update(dt);
    }
  }

  /**
   * Get the loaded robot GLTF for cloning (used by NetworkPlayerManager).
   * @returns {object|null}
   */
  getRobotGltf() {
    return this._robotGltf;
  }

  /* ------------------------------------------------------------------ */
  /*  Enemy AI / animation                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Update enemy animation mixers, wander AI, shooting, and boss AI.
   * @param {number} dt – seconds since last frame
   */
  updateEnemies(dt) {
    // Update player body animation
    if (this._playerBodyMixer) this._playerBodyMixer.update(dt);

    const px = this.model.player.x;
    const pz = this.model.player.z;
    const now = performance.now();

    for (const data of this._enemyData) {
      // Animation
      data.mixer.update(dt);

      const ex = data.enemy.position.x;
      const ez = data.enemy.position.z;
      const dx = data.targetX - ex;
      const dz = data.targetZ - ez;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Distance to player
      const toPlayerX = px - ex;
      const toPlayerZ = pz - ez;
      const distToPlayer = Math.sqrt(
        toPlayerX * toPlayerX + toPlayerZ * toPlayerZ,
      );

      if (data.isBoss) {
        // ── Boss AI: actively hunts the player ──────────────
        // Always run toward the player
        const bossSpeed = 0.08;
        if (distToPlayer > 1.5) {
          const ndx = toPlayerX / distToPlayer;
          const ndz = toPlayerZ / distToPlayer;
          const nextX = ex + ndx * bossSpeed;
          const nextZ = ez + ndz * bossSpeed;
          // Only move if not blocked
          if (!this.model.isBlocked(nextX, nextZ, 0.6)) {
            data.enemy.position.x = nextX;
            data.enemy.position.z = nextZ;
          } else {
            // Try to path around walls — pick a random open direction
            this._pickNewTarget(data);
            if (dist > 0.3) {
              data.enemy.position.x += (dx / dist) * bossSpeed;
              data.enemy.position.z += (dz / dist) * bossSpeed;
            }
          }
          data.enemy.rotation.y = Math.atan2(toPlayerX, toPlayerZ) + Math.PI;
        }

        // Boss does melee damage when close
        if (distToPlayer < 2.5 && this.model.player.alive) {
          if (now - data.lastShotTime > 800) {
            data.lastShotTime = now;
            this.model.player.health -= 15;
            this.model.recordDamage();
            this._flashEnemyDamage();
            if (this.model.player.health <= 0) {
              this.model.player.health = 0;
              this.model.player.alive = false;
            }
          }
        }
      } else {
        // ── Normal enemy: wander + stop & shoot on sight ──
        const canSeePlayer =
          distToPlayer < this._enemyDetectRange && this.model.player.alive;

        if (canSeePlayer) {
          // Stop moving — face the player and shoot
          data.enemy.rotation.y = Math.atan2(toPlayerX, toPlayerZ) + Math.PI;

          if (now - data.lastShotTime > this._enemyShotCooldown) {
            data.lastShotTime = now;
            this._enemyShootAt(data.enemy, px, pz);
          }
        } else {
          // Wander toward target
          if (dist < 0.3) {
            this._pickNewTarget(data);
          } else {
            const step = data.speed;
            data.enemy.position.x += (dx / dist) * step;
            data.enemy.position.z += (dz / dist) * step;
            data.enemy.rotation.y = Math.atan2(dx, dz) + Math.PI;
          }
        }
      }
    }
  }

  /**
   * Make an enemy fire a projectile toward a target position.
   * @param {THREE.Object3D} enemy
   * @param {number} targetX
   * @param {number} targetZ
   */
  _enemyShootAt(enemy, targetX, targetZ) {
    if (this._projectilePool.length === 0) return;

    const origin = new THREE.Vector3(
      enemy.position.x,
      1.5, // roughly chest height
      enemy.position.z,
    );
    const dir = new THREE.Vector3(
      targetX - origin.x,
      0,
      targetZ - origin.z,
    ).normalize();

    const mesh = this._projectilePool.pop();
    mesh.position.copy(origin);
    // Tint enemy projectiles red
    mesh.material = new THREE.MeshBasicMaterial({ color: 0xff3333 });
    mesh.visible = true;

    this._activeProjectiles.push({
      mesh,
      velocity: dir.multiplyScalar(this._enemyProjSpeed),
      distance: 0,
      maxDistance: this._enemyDetectRange + 5,
      enemyProjectile: true, // Flag: can damage the player
      damage: this._enemyDamage,
    });
  }

  /**
   * Flash the screen red when the player is hit by an enemy projectile or boss.
   * Works in both singleplayer and multiplayer.
   */
  _flashEnemyDamage() {
    if (!this._enemyDmgFlash) {
      this._enemyDmgFlash = document.createElement('div');
      this._enemyDmgFlash.style.cssText =
        'position:fixed;inset:0;background:rgba(255,0,0,0.35);z-index:18;' +
        'pointer-events:none;opacity:0;transition:opacity 0.15s;';
      document.body.appendChild(this._enemyDmgFlash);
    }
    this._enemyDmgFlash.style.opacity = '1';
    setTimeout(() => {
      this._enemyDmgFlash.style.opacity = '0';
    }, 200);
  }

  /**
   * Spawn enemies from server-provided positions.
   * @param {Array<{id:string,x:number,z:number,hp:number}>} enemyDefs
   */
  spawnEnemiesFromServer(enemyDefs) {
    // Clear current enemies
    for (const e of this.model.enemies.slice()) {
      this.removeFromScene(e);
    }
    this.model.enemies = [];
    this._enemyData = [];

    if (!enemyDefs || enemyDefs.length === 0) return;
    for (const ed of enemyDefs) {
      if (!this._soldierGltf) continue;
      const enemy = skeletonClone(this._soldierGltf.scene);
      enemy.scale.setScalar(this._enemyScale || 1);
      enemy.position.set(ed.x, this._enemyGroundY || 0, ed.z);
      enemy.rotation.y = Math.PI;
      enemy.name = ed.id || '';
      this.scene.add(enemy);
      this.model.enemies.push(enemy);

      // Animation mixer
      const clips = this._soldierGltf.animations || [];
      const runClip = clips.find((c) => /run/i.test(c.name)) || clips[0];
      const mixer = runClip ? new THREE.AnimationMixer(enemy) : null;
      if (mixer && runClip) mixer.clipAction(runClip).play();

      this._enemyData.push({
        enemy,
        mixer,
        targetX: enemy.position.x,
        targetZ: enemy.position.z,
        speed: 0.02,
        lastShotTime: 0,
        isBoss: false,
        id: ed.id || null,
      });
    }
  }

  /**
   * Spawn the boss enemy — a larger, faster, red-tinted soldier that
   * actively hunts players. The boss has more health visually (bigger model).
   * @param {{ x: number, z: number }} pos
   */
  spawnBoss(pos) {
    if (!this._soldierGltf) return;

    const boss = skeletonClone(this._soldierGltf.scene);

    // Boss is 2× size
    const s = (this._enemyScale || 1) * 2;
    const groundY = (this._enemyGroundY || 0) * 2;
    boss.scale.set(s, s, s);
    boss.position.set(pos.x, groundY, pos.z);

    // Red tint
    boss.traverse((child) => {
      if (child.isMesh && child.material) {
        child.material = child.material.clone();
        child.material.color.set(0xff2222);
        child.material.emissive = new THREE.Color(0x440000);
        child.material.emissiveIntensity = 0.4;
      }
    });

    // Red point light: menacing glow
    const glow = new THREE.PointLight(0xff0000, 3, 12);
    glow.position.set(0, 3, 0);
    boss.add(glow);

    this.scene.add(boss);
    this.model.addEnemy(boss);
    this.model.bossEnemy = boss;
    this.model.bossLevel = true;

    // Animation
    const clips = this._soldierGltf.animations || [];
    const runClip =
      clips.find((c) => /run/i.test(c.name)) ||
      clips.find((c) => /walk/i.test(c.name)) ||
      clips[0];
    const mixer = new THREE.AnimationMixer(boss);
    if (runClip) {
      const action = mixer.clipAction(runClip);
      action.timeScale = 1.5;
      action.play();
    }

    this._enemyData.push({
      enemy: boss,
      mixer,
      targetX: pos.x,
      targetZ: pos.z,
      speed: 0.08,
      lastShotTime: 0,
      isBoss: true,
    });
    this._bossData = this._enemyData[this._enemyData.length - 1];
  }

  /**
   * Choose a random open neighbour cell for an enemy to walk toward.
   */
  _pickNewTarget(data) {
    const m = this.model;
    if (!m.maze) return;
    const { grid, rows, cols } = m.maze;
    const cell = m.worldToCell(data.enemy.position.x, data.enemy.position.z);
    const r = cell.r;
    const c = cell.c;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return;

    const g = grid[r][c];
    const neighbours = [];
    if (g.north && r > 0) neighbours.push({ r: r - 1, c });
    if (g.south && r < rows - 1) neighbours.push({ r: r + 1, c });
    if (g.west && c > 0) neighbours.push({ r, c: c - 1 });
    if (g.east && c < cols - 1) neighbours.push({ r, c: c + 1 });

    if (neighbours.length === 0) return;
    const pick = neighbours[Math.floor(Math.random() * neighbours.length)];
    const world = m.cellToWorld(pick.r, pick.c);
    data.targetX = world.x;
    data.targetZ = world.z;
  }

  /**
   * Remove animation / AI data for a killed enemy.
   */
  _removeEnemyData(enemy) {
    const idx = this._enemyData.findIndex((d) => d.enemy === enemy);
    if (idx !== -1) {
      this._enemyData[idx].mixer.stopAllAction();
      this._enemyData.splice(idx, 1);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public helpers                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Sync the camera rig to match the model's player state.
   * Also moves the third-person player body so other players see it.
   */
  syncCamera() {
    const p = this.model.player;
    this.yawObject.position.set(p.x, p.y, p.z);
    this.yawObject.rotation.y = p.yaw;
    this.pitchObject.rotation.x = p.pitch;

    // Keep the third-person player body in sync
    if (this._playerBody) {
      this._playerBody.position.set(p.x, this._playerBodyGroundY, p.z);
      this._playerBody.rotation.y = p.yaw + Math.PI; // face the direction the camera faces
    }
  }

  /**
   * Perform a raycast from screen centre and return the enemy root (if any).
   * @returns {THREE.Object3D|null}
   */
  raycastEnemies() {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.raycaster.intersectObjects(this.model.enemies, true);
    if (hits.length > 0) {
      return this.model.findEnemyRoot(hits[0].object);
    }
    return null;
  }

  /**
   * Remove an enemy object from the scene.
   * @param {THREE.Object3D} enemy
   */
  removeFromScene(enemy) {
    this.scene.remove(enemy);
  }

  /** Render one frame. */
  render() {
    // Pass 1 — world scene (enemies, floor, etc.)
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Pass 2 — viewmodel (player arms) rendered on top.
    // Clear only the depth buffer so arms are never occluded by world geo.
    this.renderer.clearDepth();
    this.renderer.render(this.viewmodelScene, this.viewmodelCamera);
  }

  /* ------------------------------------------------------------------ */
  /*  Settings change handler                                            */
  /* ------------------------------------------------------------------ */

  _onSettingsChanged() {
    const s = this.settings;
    // Crosshair colour
    document.documentElement.style.setProperty(
      '--crosshair-color',
      s.crosshairColor,
    );
    // Projectile colour
    if (this._projectileMat)
      this._projectileMat.color.set(new THREE.Color(s.projectileColor));
    // FOV
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    // Rebuild weapon if type or skin changed
    this.rebuildWeapon();
  }

  /**
   * Destroy the current viewmodel weapon and rebuild it from settings.
   */
  rebuildWeapon() {
    if (!this._weapon) return;
    const parent = this._weapon.parent;
    if (parent) parent.remove(this._weapon);

    const type = this.settings ? this.settings.weaponType : 'rifle';
    const skin = this.settings ? this.settings.weaponSkin : '#222222';
    const newWeapon = this._createWeapon(type, skin);

    // Direct-mount on viewmodelCamera — barrel already along −Z (forward)
    newWeapon.position.copy(this._vmPos || this._hipPos);
    this.viewmodelCamera.add(newWeapon);

    this._viewmodel = newWeapon;
    this._weapon = newWeapon;
  }

  /* ------------------------------------------------------------------ */
  /*  Internal                                                            */
  /* ------------------------------------------------------------------ */

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewmodelCamera.aspect = w / h;
    this.viewmodelCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); // false = CSS already handles sizing via 100vw/100vh
  }
}
