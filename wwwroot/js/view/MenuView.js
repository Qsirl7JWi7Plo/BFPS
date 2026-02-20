import * as THREE from 'three';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.158/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'https://cdn.jsdelivr.net/npm/three@0.158/examples/jsm/utils/SkeletonUtils.js';

/**
 * MenuView — Apex Legends / COD-style main menu with 3D character preview
 * and functional sub-menus for Loadout, Settings, and Flair.
 */
export class MenuView {
  /**
   * @param {import('../model/Settings.js').Settings} settings
   * @param {Function} onPlay – called when "DEPLOY" is clicked
   * @param {Function} onBack – called when "BACK" is clicked (return to start menu)
   * @param {Promise<void>} [readyPromise] – resolves when GameView models/level are loaded
   */
  constructor(settings, onPlay, onBack, readyPromise) {
    this.settings = settings;
    this._onPlay = onPlay;
    this._onBack = onBack;
    this._gameReady = false;

    /** @type {import('./LobbyView.js').LobbyView|null} */
    this._lobbyView = null;

    /** Whether the DEPLOY action should connect in multiplayer mode */
    this._multiplayerMode = false;

    // ── Dedicated renderer for the preview (alpha for transparent bg) ──
    this._previewRenderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
    });
    this._previewRenderer.setPixelRatio(window.devicePixelRatio);
    this._previewRenderer.setSize(window.innerWidth, window.innerHeight);
    this._previewRenderer.setClearColor(0x000000, 0); // fully transparent
    this._previewCanvas = this._previewRenderer.domElement;
    this._previewCanvas.style.cssText =
      'position:absolute;inset:0;z-index:1;pointer-events:none;';

    // ── 3D preview scene ────────────────────────────────────
    this._previewScene = new THREE.Scene();
    this._previewCamera = new THREE.PerspectiveCamera(
      40,
      window.innerWidth / window.innerHeight,
      0.1,
      100,
    );
    this._previewCamera.position.set(0, 1.0, 2.2);
    this._previewCamera.lookAt(0, 0.9, 0);

    // Dramatic lighting
    this._previewScene.add(new THREE.AmbientLight(0x334466, 0.6));
    const rim = new THREE.DirectionalLight(0x6688ff, 1.2);
    rim.position.set(-3, 4, -2);
    this._previewScene.add(rim);
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(2, 3, 4);
    this._previewScene.add(key);
    const fill = new THREE.DirectionalLight(0xff6633, 0.4);
    fill.position.set(-2, 1, 3);
    this._previewScene.add(fill);

    // Model container (centred in frame)
    this._modelContainer = new THREE.Group();
    this._modelContainer.position.set(0, 0, 0);
    this._previewScene.add(this._modelContainer);

    // Weapon bento display (floating on the left)
    this._weaponBento = new THREE.Group();
    this._weaponBento.position.set(-1.0, 0.7, 0.3);
    this._previewScene.add(this._weaponBento);

    // ── State ───────────────────────────────────────────────
    this._state = 'main'; // 'main' | 'loadout' | 'settings' | 'flair' | 'hidden'
    this._robotGltf = null;
    this._weaponGltfs = {}; // { rifle, shotgun, pistol }
    this._previewModel = null;
    this._previewWeapon = null;
    this._previewMixer = null; // AnimationMixer for idle pose
    this._weaponRotSpeed = 0.6; // weapon bento rotation speed

    // ── DOM ─────────────────────────────────────────────────
    this._buildDOM();
    this._loadPreviewModel();

    // ── Gate DEPLOY button until game assets are ready ──────
    if (readyPromise) {
      readyPromise.then(() => {
        this._gameReady = true;
        if (this._deployBtn) {
          this._deployBtn.textContent = 'DEPLOY';
          this._deployBtn.style.opacity = '1';
          this._deployBtn.style.cursor = 'pointer';
        }
      });
    } else {
      this._gameReady = true;
    }

    // Resize — also resize the dedicated preview canvas
    window.addEventListener('resize', () => {
      this._previewCamera.aspect = window.innerWidth / window.innerHeight;
      this._previewCamera.updateProjectionMatrix();
      this._previewRenderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  /* ================================================================ */
  /*  DOM construction                                                 */
  /* ================================================================ */

  _buildDOM() {
    // Root overlay
    this._root = document.createElement('div');
    this._root.id = 'mainMenu';
    this._root.style.cssText =
      'position:fixed;inset:0;z-index:30;display:flex;flex-direction:column;' +
      'font-family:Arial,Helvetica,sans-serif;color:white;overflow:hidden;' +
      'background:url("img/image1.png") center/cover no-repeat;';
    document.body.appendChild(this._root);

    // Embed the preview canvas inside the menu overlay
    this._root.appendChild(this._previewCanvas);

    // Subtle gradient strip at top for readability
    const glass = document.createElement('div');
    glass.style.cssText =
      'position:absolute;inset:0;' +
      'background:linear-gradient(to bottom, rgba(0,0,10,0.7) 0%, rgba(0,0,10,0.3) 20%, transparent 50%);' +
      'pointer-events:none;';
    this._root.appendChild(glass);

    // Top bar (menu buttons — horizontal row)
    this._leftPanel = document.createElement('div');
    this._leftPanel.style.cssText =
      'position:relative;z-index:1;width:100%;padding:20px 40px;display:flex;' +
      'flex-direction:column;align-items:center;gap:14px;';
    this._root.appendChild(this._leftPanel);

    // Title — compact for top bar
    const title = document.createElement('div');
    title.innerHTML =
      '<span style="font-size:36px;font-weight:900;letter-spacing:6px;' +
      'text-shadow:0 0 30px rgba(0,150,255,0.6),0 0 60px rgba(0,80,255,0.3);">BFPS</span>';
    title.style.marginBottom = '4px';
    this._leftPanel.appendChild(title);

    // Main menu buttons — horizontal row
    this._mainButtons = document.createElement('div');
    this._mainButtons.style.cssText =
      'display:flex;flex-direction:row;gap:12px;flex-wrap:wrap;justify-content:center;';
    this._leftPanel.appendChild(this._mainButtons);

    this._addButton(this._mainButtons, 'DEPLOY', '#00cc44', () => this._play());
    this._addButton(this._mainButtons, 'MULTIPLAYER', '#ff4488', () =>
      this._showState('multiplayer'),
    );
    this._addButton(this._mainButtons, 'LOADOUT', '#dd8800', () =>
      this._showState('loadout'),
    );
    this._addButton(this._mainButtons, 'SETTINGS', '#2288ff', () =>
      this._showState('settings'),
    );
    this._addButton(this._mainButtons, 'FLAIR', '#aa44dd', () =>
      this._showState('flair'),
    );
    this._addButton(this._mainButtons, 'BACK', '#888888', () => this._back());

    // DEPLOY button — starts as "LOADING..." until game assets are ready
    this._deployBtn = this._mainButtons.querySelector('button'); // first button
    if (this._deployBtn && !this._gameReady) {
      this._deployBtn.textContent = 'LOADING...';
      this._deployBtn.style.opacity = '0.5';
      this._deployBtn.style.cursor = 'wait';
    }

    // Sub-menus (appears below the top bar)
    this._subContainer = document.createElement('div');
    this._subContainer.style.cssText =
      'display:none;flex-direction:column;gap:14px;max-height:400px;overflow-y:auto;' +
      'padding:10px 20px;width:360px;';
    this._leftPanel.appendChild(this._subContainer);

    // Controls hint — bottom-left
    const hint = document.createElement('div');
    hint.style.cssText =
      'position:fixed;bottom:12px;left:16px;font-size:12px;opacity:0.5;line-height:1.6;z-index:31;';
    hint.innerHTML =
      'WASD = Move | Shift = Sprint<br>Mouse = Look | LMB = Shoot | RMB = ADS<br>ESC = Pause | TAB = Scoreboard';
    this._leftPanel.appendChild(hint);
  }

  _addButton(container, label, color, onClick) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      `padding:12px 28px;font-size:15px;font-weight:700;letter-spacing:2px;` +
      `border:2px solid ${color};background:rgba(0,0,0,0.4);color:white;cursor:pointer;` +
      `text-align:center;transition:all 0.2s;font-family:inherit;white-space:nowrap;`;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = color;
      btn.style.boxShadow = `0 0 20px ${color}80`;
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(0,0,0,0.4)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', onClick);
    container.appendChild(btn);
    return btn;
  }

  /* ================================================================ */
  /*  Sub-menu builders                                                */
  /* ================================================================ */

  _showState(state) {
    this._state = state;
    this._mainButtons.style.display = 'none';
    this._subContainer.style.display = 'flex';
    this._subContainer.innerHTML = '';

    switch (state) {
      case 'loadout':
        this._buildLoadoutMenu();
        break;
      case 'settings':
        this._buildSettingsMenu();
        break;
      case 'flair':
        this._buildFlairMenu();
        break;
      case 'multiplayer':
        this._buildMultiplayerMenu();
        break;
    }
  }

  _backToMain() {
    this._state = 'main';
    this._mainButtons.style.display = 'flex';
    this._subContainer.style.display = 'none';
    this._subContainer.innerHTML = '';
  }

  /* ── Loadout ─────────────────────────────────────────────── */

  _buildLoadoutMenu() {
    const s = this.settings;
    this._subHeader('LOADOUT');

    const weapons = [
      {
        id: 'rifle',
        name: 'RIFLE',
        desc: 'Balanced range & accuracy',
        icon: '═══╤═',
      },
      {
        id: 'shotgun',
        name: 'SHOTGUN',
        desc: 'Devastating close-range burst',
        icon: '══╗═',
      },
      {
        id: 'pistol',
        name: 'PISTOL',
        desc: 'Rapid-fire, lightweight',
        icon: '─╗',
      },
    ];

    const cards = document.createElement('div');
    cards.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;';

    for (const w of weapons) {
      const card = document.createElement('div');
      const selected = s.weaponType === w.id;
      card.style.cssText =
        `flex:1;min-width:100px;padding:18px 14px;background:${selected ? 'rgba(255,140,0,0.25)' : 'rgba(0,0,0,0.4)'};` +
        `border:2px solid ${selected ? '#dd8800' : '#555'};cursor:pointer;text-align:center;transition:all 0.2s;`;
      card.innerHTML =
        `<div style="font-size:24px;letter-spacing:3px;margin-bottom:6px;">${w.icon}</div>` +
        `<div style="font-weight:700;font-size:16px;margin-bottom:4px;">${w.name}</div>` +
        `<div style="font-size:11px;opacity:0.7;">${w.desc}</div>`;
      card.addEventListener('click', () => {
        s.weaponType = w.id;
        s.save();
        this._showState('loadout');
        this._rebuildPreviewWeapon();
      });
      cards.appendChild(card);
    }
    this._subContainer.appendChild(cards);
    this._subBack();
  }

  /* ── Settings ────────────────────────────────────────────── */

  _buildSettingsMenu() {
    const s = this.settings;
    this._subHeader('SETTINGS');

    // Sensitivity slider
    this._addSlider('Mouse Sensitivity', s.sensitivity, 0.3, 3.0, 0.1, (v) => {
      s.sensitivity = v;
      s.save();
    });

    // FOV slider
    this._addSlider('Field of View', s.fov, 60, 110, 5, (v) => {
      s.fov = v;
      s.save();
    });

    // Invert Y toggle
    this._addToggle('Invert Y-Axis', s.invertY, (v) => {
      s.invertY = v;
      s.save();
    });

    // Crosshair colour
    const crosshairColors = [
      '#ffffff',
      '#ff4444',
      '#44ff44',
      '#44ffff',
      '#ffff44',
      '#ff44ff',
    ];
    this._addColorPicker(
      'Crosshair Color',
      crosshairColors,
      s.crosshairColor,
      (c) => {
        s.crosshairColor = c;
        s.save();
        document.documentElement.style.setProperty('--crosshair-color', c);
      },
    );

    this._subBack();
  }

  /* ── Flair ───────────────────────────────────────────────── */

  _buildFlairMenu() {
    const s = this.settings;
    this._subHeader('FLAIR');

    // Weapon skin
    const skinPresets = [
      { label: 'Obsidian', color: '#222222' },
      { label: 'Gunmetal', color: '#555555' },
      { label: 'Desert', color: '#c4a35a' },
      { label: 'Arctic', color: '#dddddd' },
      { label: 'Blood', color: '#8b0000' },
    ];
    this._addSwatchPicker('Weapon Skin', skinPresets, s.weaponSkin, (c) => {
      s.weaponSkin = c;
      s.save();
      this._rebuildPreviewWeapon();
    });

    // Projectile colour
    const projColors = [
      { label: 'Yellow', color: '#ffff00' },
      { label: 'Red', color: '#ff3333' },
      { label: 'Blue', color: '#3388ff' },
      { label: 'Green', color: '#33ff33' },
    ];
    this._addSwatchPicker(
      'Projectile Color',
      projColors,
      s.projectileColor,
      (c) => {
        s.projectileColor = c;
        s.save();
      },
    );

    // HUD accent
    const hudColors = [
      { label: 'Cyan', color: '#00aaff' },
      { label: 'Orange', color: '#ff8800' },
      { label: 'Green', color: '#44ff44' },
      { label: 'Pink', color: '#ff66aa' },
    ];
    this._addSwatchPicker('HUD Accent', hudColors, s.hudAccent, (c) => {
      s.hudAccent = c;
      s.save();
    });

    this._subBack();
  }

  /* ================================================================ */
  /*  Reusable UI helpers                                              */
  /* ================================================================ */

  _subHeader(text) {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText =
      'font-size:22px;font-weight:800;letter-spacing:3px;margin-bottom:4px;';
    this._subContainer.appendChild(h);
  }

  _subBack() {
    const wrap = document.createElement('div');
    wrap.style.marginTop = '8px';
    this._addButton(wrap, '← BACK', '#888', () => this._backToMain());
    this._subContainer.appendChild(wrap);
  }

  _addSlider(label, value, min, max, step, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'min-width:150px;font-size:14px;';
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
      'min-width:40px;text-align:right;font-size:14px;font-weight:600;';
    valLbl.textContent = Number(value).toFixed(step < 1 ? 1 : 0);

    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      valLbl.textContent = v.toFixed(step < 1 ? 1 : 0);
      onChange(v);
    });

    row.append(lbl, slider, valLbl);
    this._subContainer.appendChild(row);
  }

  _addToggle(label, value, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'min-width:150px;font-size:14px;';
    lbl.textContent = label;

    const btn = document.createElement('button');
    const update = (v) => {
      btn.textContent = v ? 'ON' : 'OFF';
      btn.style.background = v ? '#2288ff' : 'rgba(255,255,255,0.15)';
    };
    btn.style.cssText =
      'padding:6px 18px;border:none;color:white;cursor:pointer;font-weight:700;font-size:14px;' +
      'font-family:inherit;transition:background 0.2s;';
    update(value);
    btn.addEventListener('click', () => {
      const newVal = !btn.textContent.includes('ON');
      update(newVal);
      onChange(newVal);
    });

    row.append(lbl, btn);
    this._subContainer.appendChild(row);
  }

  _addColorPicker(label, colors, current, onChange) {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:12px;flex-wrap:wrap;';

    const lbl = document.createElement('span');
    lbl.style.cssText = 'min-width:150px;font-size:14px;';
    lbl.textContent = label;
    row.appendChild(lbl);

    for (const c of colors) {
      const swatch = document.createElement('div');
      const isSel = c.toLowerCase() === current.toLowerCase();
      swatch.style.cssText =
        `width:28px;height:28px;background:${c};cursor:pointer;` +
        `border:3px solid ${isSel ? '#fff' : 'transparent'};transition:border 0.15s;`;
      swatch.addEventListener('click', () => {
        onChange(c);
        // Refresh selection visuals
        row
          .querySelectorAll('div')
          .forEach((d) => (d.style.borderColor = 'transparent'));
        swatch.style.borderColor = '#fff';
      });
      row.appendChild(swatch);
    }
    this._subContainer.appendChild(row);
  }

  _addSwatchPicker(label, presets, current, onChange) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:6px;';

    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:14px;margin-bottom:6px;';
    lbl.textContent = label;
    row.appendChild(lbl);

    const swatches = document.createElement('div');
    swatches.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

    for (const p of presets) {
      const sw = document.createElement('div');
      const isSel = p.color.toLowerCase() === current.toLowerCase();
      sw.style.cssText =
        `width:44px;height:44px;background:${p.color};cursor:pointer;position:relative;` +
        `border:3px solid ${isSel ? '#fff' : 'transparent'};transition:border 0.15s;` +
        `display:flex;align-items:flex-end;justify-content:center;`;
      sw.innerHTML = `<span style="font-size:9px;padding-bottom:2px;text-shadow:0 0 4px black;">${p.label}</span>`;
      sw.addEventListener('click', () => {
        onChange(p.color);
        swatches
          .querySelectorAll('div')
          .forEach((d) => (d.style.borderColor = 'transparent'));
        sw.style.borderColor = '#fff';
      });
      swatches.appendChild(sw);
    }
    row.appendChild(swatches);
    this._subContainer.appendChild(row);
  }

  /* ================================================================ */
  /*  3D preview                                                       */
  /* ================================================================ */

  async _loadPreviewModel() {
    const loader = new GLTFLoader();
    const loadAsync = (url) =>
      new Promise((res, rej) => loader.load(url, res, undefined, rej));

    const [charGltf, rifle, shotgun, pistol] = await Promise.all([
      loadAsync('/assets/models/characters/player.glb'),
      loadAsync('/assets/models/weapons/rifle.glb'),
      loadAsync('/assets/models/weapons/shotgun.glb'),
      loadAsync('/assets/models/weapons/pistol.glb'),
    ]);
    this._robotGltf = charGltf;
    this._weaponGltfs = { rifle, shotgun, pistol };

    const model = skeletonClone(charGltf.scene);
    // Auto-scale: measure actual height and scale to fill lobby display.
    const bbox = new THREE.Box3().setFromObject(model);
    const modelHeight = bbox.max.y - bbox.min.y;
    const desiredLobbyHeight = 1.8; // fill the lobby view
    const lobbyScale = desiredLobbyHeight / modelHeight;
    model.scale.set(lobbyScale, lobbyScale, lobbyScale);
    model.rotation.y = -0.3; // slight angle for dramatic look
    this._previewModel = model;
    this._modelContainer.add(model);

    // Play idle animation so the character is NOT in T-pose
    const clips = charGltf.animations || [];
    const idleClip =
      clips.find((c) => /idle/i.test(c.name)) ||
      clips.find((c) => /stand/i.test(c.name)) ||
      clips[0];
    if (idleClip) {
      this._previewMixer = new THREE.AnimationMixer(model);
      this._previewMixer.clipAction(idleClip).play();
    }

    this._rebuildPreviewWeapon();
  }

  _rebuildPreviewWeapon() {
    // Remove old weapon
    if (this._previewWeapon) {
      this._previewWeapon.parent?.remove(this._previewWeapon);
      this._previewWeapon = null;
    }

    // Build new weapon from GLB
    const weapon = this._cloneWeaponGLB(
      this.settings.weaponType,
      this.settings.weaponSkin,
    );

    // Display weapon as a standalone bento on the left side.
    // Weapons are metric-scale with barrel along −Z, grip at origin.
    // Tilt slightly so the player can admire it.
    weapon.scale.set(2.5, 2.5, 2.5);
    weapon.rotation.set(0.15, 0.4, 0); // slight tilt for dramatic look
    this._weaponBento.add(weapon);
    this._previewWeapon = weapon;
  }

  /**
   * Clone a weapon GLB asset and apply the player's skin colour.
   * @param {string} type  'rifle' | 'shotgun' | 'pistol'
   * @param {string} skinColor  CSS colour string
   * @returns {THREE.Group}
   */
  _cloneWeaponGLB(type, skinColor) {
    const key = type || 'rifle';
    const gltf = this._weaponGltfs[key];
    if (!gltf) return new THREE.Group();

    const clone = gltf.scene.clone(true);
    const color = new THREE.Color(skinColor || '#888888');
    clone.traverse((child) => {
      if (!child.isMesh) return;
      child.material = child.material.clone();
      if (child.material.name === 'Metal') {
        child.material.color.copy(color);
      }
    });

    // Safety: robust muzzle detection (prefer thin-end test) — flip preview if muzzle is on +Z
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
        if (minSide.count === 0 || maxSide.count === 0) return false;

        const minArea =
          (minSide.maxX - minSide.minX) * (minSide.maxY - minSide.minY) ||
          Infinity;
        const maxArea =
          (maxSide.maxX - maxSide.minX) * (maxSide.maxY - maxSide.minY) ||
          Infinity;
        return maxArea < minArea;
      };

      if (muzzleOnPositiveZ(clone)) {
        clone.rotateY(Math.PI);
        console.debug(
          `Flipped preview weapon orientation for ${key} (muzzle was +Z)`,
        );
      }
    } catch (e) {
      /* ignore bbox failures in very small/empty clones */
    }

    return clone;
  }

  /* ================================================================ */
  /*  Public API                                                       */
  /* ================================================================ */

  /** Render the 3D preview (called from game loop when menu is visible). */
  renderPreview(dt) {
    if (this._state === 'hidden') return;
    // Update idle animation
    if (this._previewMixer) this._previewMixer.update(dt);
    // Slowly rotate the weapon bento
    if (this._weaponBento)
      this._weaponBento.rotation.y += this._weaponRotSpeed * dt;
    this._previewRenderer.render(this._previewScene, this._previewCamera);
  }

  /** Show the main menu. */
  show() {
    this._state = 'main';
    this._root.style.display = 'flex';
    this._mainButtons.style.display = 'flex';
    this._subContainer.style.display = 'none';
    this._subContainer.innerHTML = '';
  }

  /** Hide the menu. */
  hide() {
    this._state = 'hidden';
    this._root.style.display = 'none';
  }

  /** Is the menu currently visible? */
  get visible() {
    return this._state !== 'hidden';
  }

  /* ── Multiplayer ──────────────────────────────────────── */

  _buildMultiplayerMenu() {
    this._subHeader('MULTIPLAYER');

    // Widen sub-container for lobby
    this._subContainer.style.width = '440px';
    this._subContainer.style.maxHeight = '450px';

    // server URL input so player can switch servers without reloading
    const urlGroup = document.createElement('div');
    urlGroup.style.cssText = 'margin-bottom:8px;';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.value = this.settings.serverUrl;
    urlInput.placeholder = 'Server URL';
    urlInput.style.cssText =
      'width:100%;padding:6px;background:rgba(0,0,0,0.4);border:1px solid #555;color:white;font-size:13px;box-sizing:border-box;';
    urlInput.addEventListener('change', () => {
      this.settings.serverUrl = urlInput.value;
      this.settings.save();
    });
    urlGroup.appendChild(urlInput);
    this._subContainer.appendChild(urlGroup);

    // use _addButton helper instead of _makeButton (MenuView has its own helper)
    this._addButton(this._subContainer, 'CONNECT', '#00cc44', () => {
      this.net.disconnect();
      this.net.connect(this.settings.serverUrl);
    });

    if (this._lobbyView) {
      this._lobbyView.setContainer(this._subContainer);
    } else {
      const info = document.createElement('div');
      info.style.cssText = 'opacity:0.6;padding:10px;';
      info.textContent =
        'Multiplayer not initialised. Connect from main.js first.';
      this._subContainer.appendChild(info);
    }

    // Back button needs to be appended after lobby content
    this._subBack();
  }

  /**
   * Set the LobbyView reference so the multiplayer tab can show it.
   * @param {import('./LobbyView.js').LobbyView} lobbyView
   */
  setLobbyView(lobbyView) {
    this._lobbyView = lobbyView;
  }

  /** @private */
  _play() {
    if (!this._gameReady) return; // assets still loading
    this.hide();
    this._onPlay();
  }

  /** @private */
  _back() {
    this.hide();
    if (this._onBack) this._onBack();
  }
}
