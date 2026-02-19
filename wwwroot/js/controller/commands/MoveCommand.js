import { Command } from './Command.js';

/**
 * MoveCommand — translates the player each frame based on intent flags.
 * Reads model.movement and writes back to model.player position.
 * Checks maze wall collisions so the player slides along walls.
 */
export class MoveCommand extends Command {
  /**
   * @param {import('../../model/GameModel.js').GameModel} model
   * @param {import('../../view/GameView.js').GameView} view
   */
  constructor(model, view) {
    super();
    this.model = model;
    this.view = view;
  }

  execute() {
    const { movement, player } = this.model;

    // Dead players can't move in multiplayer
    if (this.model.multiplayer && !player.alive) return;

    if (
      !movement.forward &&
      !movement.backward &&
      !movement.left &&
      !movement.right
    ) {
      return;
    }

    const speed =
      player.baseSpeed * (player.sprinting ? player.sprintMultiplier : 1.0);

    // Derive world-space forward from yaw only (stay on XZ plane)
    const sinYaw = Math.sin(player.yaw);
    const cosYaw = Math.cos(player.yaw);
    const fwdX = -sinYaw;
    const fwdZ = -cosYaw;
    const rgtX = -cosYaw;
    const rgtZ = sinYaw;

    let dx = 0;
    let dz = 0;
    if (movement.forward) {
      dx += fwdX * speed;
      dz += fwdZ * speed;
    }
    if (movement.backward) {
      dx -= fwdX * speed;
      dz -= fwdZ * speed;
    }
    if (movement.left) {
      dx += rgtX * speed;
      dz += rgtZ * speed;
    }
    if (movement.right) {
      dx -= rgtX * speed;
      dz -= rgtZ * speed;
    }

    // ── Wall collision: try each axis independently (slide) ──
    const newX = player.x + dx;
    const newZ = player.z + dz;

    if (!this.model.isBlocked(newX, player.z)) {
      player.x = newX;
    }
    if (!this.model.isBlocked(player.x, newZ)) {
      player.z = newZ;
    }
  }
}
