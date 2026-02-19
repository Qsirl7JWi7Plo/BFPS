import { Command } from './Command.js';
import * as THREE from 'three';

/**
 * ShootCommand — fires a projectile from the camera centre.
 * In multiplayer mode, also sends the shot to the server for
 * authoritative hit detection.
 */
export class ShootCommand extends Command {
  /**
   * @param {import('../../model/GameModel.js').GameModel} model
   * @param {import('../../view/GameView.js').GameView} view
   * @param {import('../../net/NetworkManager.js').NetworkManager} [net]
   */
  constructor(model, view, net) {
    super();
    this.model = model;
    this.view = view;
    this.net = net || null;
    /** @type {THREE.Object3D|null} for potential undo */
    this._removedEnemy = null;
  }

  execute() {
    // Don't shoot if dead in multiplayer
    if (this.model.multiplayer && !this.model.player.alive) return;

    // Ensure camera rig reflects latest model position/rotation
    // (syncCamera normally runs AFTER controller.update, so the camera
    //  would still hold the previous frame's transform without this)
    this.view.syncCamera();

    // Fire a projectile (local visual feedback)
    this.view.spawnProjectile();

    // If connected to multiplayer, send shot to server for authoritative hit detection
    if (this.net && this.net.inGame) {
      const origin = new THREE.Vector3();
      this.view.camera.getWorldPosition(origin);
      const direction = new THREE.Vector3();
      this.view.camera.getWorldDirection(direction);

      this.net.sendShoot(
        { x: origin.x, y: origin.y, z: origin.z },
        { x: direction.x, y: direction.y, z: direction.z },
      );
    }
  }

  undo() {
    // Projectiles can't be recalled once fired
  }
}
