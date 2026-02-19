import * as THREE from 'three';
import { clone as skeletonClone } from 'https://cdn.jsdelivr.net/npm/three@0.158/examples/jsm/utils/SkeletonUtils.js';

/**
 * NetworkPlayerManager — manages spawning, despawning, and interpolating
 * remote player meshes in the Three.js scene.
 *
 * Uses the same player.glb robot model, placed on layer 1 (PLAYER_LAYER)
 * so they're visible to the local camera (which enables layer 1 for remote
 * players) but the local player body is on layer 2 (LOCAL_BODY_LAYER) to
 * remain invisible.
 *
 * Industry-standard snapshot interpolation:
 *   - Buffers incoming position snapshots with timestamps
 *   - Renders remote players at a fixed delay behind real-time (INTERP_DELAY)
 *   - Linearly interpolates between the two snapshots that bracket the render time
 *   - This produces smooth, jitter-free motion independent of network packet timing
 */
export class NetworkPlayerManager {
  /**
   * @param {import('../view/GameView.js').GameView} view
   * @param {import('../model/GameModel.js').GameModel} model
   */
  constructor(view, model) {
    this.view = view;
    this.model = model;

    /** @type {Map<string, PlayerEntry>} */
    this._players = new Map();

    /**
     * Interpolation delay in seconds.
     * Remote players are rendered this far behind real-time.
     * 100 ms is the industry standard for 20 Hz tick servers
     * (Valve Source Engine uses 100 ms at 20 tick, 62.5 ms at 32 tick).
     */
    this.INTERP_DELAY = 0.1;

    /**
     * Maximum snapshots to keep per player.
     * At 20 Hz tick rate, 20 snapshots = 1 second of history.
     */
    this.MAX_SNAPSHOTS = 20;

    /** Monotonic clock — tracks elapsed game time for interpolation */
    this._elapsed = 0;

    // Enable layer 1 on the camera so we can see remote player bodies
    this.view.camera.layers.enable(1);
  }

  /**
   * Spawn a network player mesh.
   * @param {string} id  – socket ID
   * @param {object} state  – { x, y, z, yaw, pitch, name, weapon }
   */
  /**
   * Push a position snapshot for a remote player.
   * Called by NetworkManager whenever a playerMoved or gameState arrives.
   * @param {string} id
   * @param {object} state  – { x, y, z, yaw, pitch }
   */
  pushSnapshot(id, state) {
    const entry = this._players.get(id);
    if (!entry) return;
    entry.snapshots.push({
      time: this._elapsed,
      x: state.x,
      z: state.z,
      yaw: state.yaw || 0,
    });
    // Trim old snapshots
    if (entry.snapshots.length > this.MAX_SNAPSHOTS) {
      entry.snapshots.shift();
    }
  }

  spawnPlayer(id, state) {
    if (this._players.has(id)) return; // Already spawned

    const gltf = this.view.getRobotGltf();
    if (!gltf) {
      console.warn('[NetworkPlayer] Robot GLTF not loaded yet');
      return;
    }

    const body = skeletonClone(gltf.scene);

    // Ground offset so feet sit on floor (y = 0)
    const bbox = new THREE.Box3().setFromObject(body);
    const groundY = -bbox.min.y;

    // Place on PLAYER_LAYER (1) — visible to local camera since we enabled layer 1
    body.layers.set(1);
    body.traverse((child) => {
      child.layers.set(1);
    });

    // Set initial position
    body.position.set(state.x || 0, groundY, state.z || 0);
    body.rotation.y = (state.yaw || 0) + Math.PI;

    // Collect original materials for hit-flash reset
    const originalMaterials = new Map();
    body.traverse((child) => {
      if (child.isMesh && child.material) {
        originalMaterials.set(child, child.material.clone());
      }
    });

    // Add a floating name tag
    const nameSprite = this._createNameTag(state.name || 'Player');
    nameSprite.position.set(0, bbox.max.y - bbox.min.y + 0.3, 0);
    nameSprite.layers.set(1);
    body.add(nameSprite);

    this.view.scene.add(body);

    // Animation
    let mixer = null;
    const clips = gltf.animations || [];
    const idleClip =
      clips.find((c) => /idle/i.test(c.name)) ||
      clips.find((c) => /stand/i.test(c.name)) ||
      clips[0];
    if (idleClip) {
      mixer = new THREE.AnimationMixer(body);
      mixer.clipAction(idleClip).play();
    }

    this._players.set(id, {
      body,
      mixer,
      nameSprite,
      groundY,
      originalMaterials,
      /** Snapshot buffer for interpolation */
      snapshots: [
        {
          time: this._elapsed,
          x: state.x || 0,
          z: state.z || 0,
          yaw: state.yaw || 0,
        },
      ],
      /** Hit-flash timer (seconds remaining) */
      flashTimer: 0,
    });
  }

  /**
   * Remove a network player mesh.
   * @param {string} id
   */
  removePlayer(id) {
    const entry = this._players.get(id);
    if (!entry) return;

    this.view.scene.remove(entry.body);
    if (entry.mixer) {
      entry.mixer.stopAllAction();
      entry.mixer.uncacheRoot(entry.body);
    }
    this._players.delete(id);
  }

  /**
   * Remove all network player meshes.
   */
  removeAll() {
    for (const [id] of this._players) {
      this.removePlayer(id);
    }
  }

  /**
   * Flash a remote player's mesh red to indicate they were hit.
   * @param {string} id  – socket id of the player that was hit
   */
  flashHit(id) {
    const entry = this._players.get(id);
    if (!entry) return;
    entry.flashTimer = 0.2; // seconds
    const flashMat = new THREE.MeshStandardMaterial({
      color: 0xff2222,
      emissive: 0xff0000,
      emissiveIntensity: 0.6,
    });
    entry.body.traverse((child) => {
      if (child.isMesh) child.material = flashMat;
    });
  }

  /**
   * Update all network players — snapshot interpolation + hit flash.
   * Called once per frame from the game loop.
   *
   * Interpolation approach (industry standard — same concept as
   * Valve Source Engine cl_interp / cl_interp_ratio):
   *   renderTime = now − INTERP_DELAY
   *   Find the two snapshots that bracket renderTime, lerp between them.
   *   If we only have one snapshot (or renderTime is ahead of all data),
   *   extrapolate from the latest snapshot.
   *
   * @param {number} dt  – delta time in seconds from Three.Clock
   */
  update(dt) {
    this._elapsed += dt;
    const networkPlayers = this.model.networkPlayers;
    if (!networkPlayers) return;

    // Spawn any new players we haven't seen yet
    for (const [id, state] of networkPlayers) {
      if (!this._players.has(id)) {
        this.spawnPlayer(id, state);
      }
    }

    // Remove players that are no longer in the network state
    for (const [id] of this._players) {
      if (!networkPlayers.has(id)) {
        this.removePlayer(id);
      }
    }

    const renderTime = this._elapsed - this.INTERP_DELAY;

    // Interpolate existing players
    for (const [id, entry] of this._players) {
      const state = networkPlayers.get(id);
      if (!state) continue;

      const { body, snapshots } = entry;

      // Hide dead players
      body.visible = state.alive !== false;

      // ── Snapshot interpolation ──────────────────────────
      let interpX, interpZ, interpYaw;

      if (snapshots.length < 2 || renderTime <= snapshots[0].time) {
        // Not enough data or render time is behind oldest snapshot → use latest
        const s = snapshots[snapshots.length - 1];
        interpX = s.x;
        interpZ = s.z;
        interpYaw = s.yaw;
      } else if (renderTime >= snapshots[snapshots.length - 1].time) {
        // Render time is ahead of newest snapshot → use latest (slight extrapolation)
        const s = snapshots[snapshots.length - 1];
        interpX = s.x;
        interpZ = s.z;
        interpYaw = s.yaw;
      } else {
        // Find bracket: snapshots[i-1].time <= renderTime < snapshots[i].time
        let i = 1;
        while (i < snapshots.length && snapshots[i].time < renderTime) i++;
        const a = snapshots[i - 1];
        const b = snapshots[i];
        const range = b.time - a.time;
        const t = range > 0 ? (renderTime - a.time) / range : 0;

        interpX = a.x + (b.x - a.x) * t;
        interpZ = a.z + (b.z - a.z) * t;

        // Yaw interpolation with wrap-around
        let yawDiff = b.yaw - a.yaw;
        if (yawDiff > Math.PI) yawDiff -= Math.PI * 2;
        if (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
        interpYaw = a.yaw + yawDiff * t;
      }

      body.position.x = interpX;
      body.position.z = interpZ;
      body.position.y = entry.groundY;
      body.rotation.y = interpYaw + Math.PI;

      // ── Hit flash decay ────────────────────────────────
      if (entry.flashTimer > 0) {
        entry.flashTimer -= dt;
        if (entry.flashTimer <= 0) {
          // Restore original materials
          entry.body.traverse((child) => {
            if (child.isMesh && entry.originalMaterials.has(child)) {
              child.material = entry.originalMaterials.get(child).clone();
            }
          });
        }
      }

      // Update animation
      if (entry.mixer) {
        entry.mixer.update(dt);
      }
    }
  }

  /**
   * Create a sprite-based name tag.
   * @param {string} name
   * @returns {THREE.Sprite}
   */
  _createNameTag(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.fillRect(0, 0, 256, 64);
    ctx.font = 'bold 28px Arial';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(name.substring(0, 15), 128, 32);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(1.5, 0.4, 1);
    return sprite;
  }

  /**
   * Check if a player is spawned.
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    return this._players.has(id);
  }

  /**
   * Get the number of active network players.
   * @returns {number}
   */
  get count() {
    return this._players.size;
  }
}
