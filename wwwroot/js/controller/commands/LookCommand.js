import { Command } from './Command.js';

/**
 * LookCommand — applies yaw/pitch deltas to the player model.
 * Sensitivity and invertY are applied at creation time by the controller.
 */
export class LookCommand extends Command {
  /**
   * @param {import('../../model/GameModel.js').GameModel} model
   * @param {number} deltaYaw   – horizontal rotation delta (radians)
   * @param {number} deltaPitch – vertical rotation delta (radians)
   */
  constructor(model, deltaYaw, deltaPitch) {
    super();
    this.model = model;
    this.deltaYaw = deltaYaw;
    this.deltaPitch = deltaPitch;
  }

  execute() {
    const p = this.model.player;
    p.yaw += this.deltaYaw;
    p.pitch += this.deltaPitch;
    // Clamp pitch to ±90°
    p.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p.pitch));
  }
}
