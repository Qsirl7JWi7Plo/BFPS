import { LookCommand } from './commands/LookCommand.js';
import { ShootCommand } from './commands/ShootCommand.js';
import { MoveCommand } from './commands/MoveCommand.js';

/**
 * InputController — handles keyboard, mouse, and gamepad input.
 * Translates raw input into Commands that are queued and executed each frame.
 * (MVC: Controller layer)
 *
 * Gamepad mapping (Standard Gamepad — xinput / DualShock / DualSense):
 *   Left  stick  (axes 0,1) / D-pad (buttons 12-15) → movement
 *   Right stick  (axes 2,3)                          → look
 *   Right trigger RT (button 7)                      → shoot
 *   Left  trigger LT (button 6)                      → ADS
 *   Right bumper  RB (button 5)                      → shoot (alt)
 *   Left  stick click L3 (button 10)                 → sprint
 */
export class InputController {
  /**
   * @param {import('../model/GameModel.js').GameModel} model
   * @param {import('../view/GameView.js').GameView} view
   * @param {import('../model/Settings.js').Settings} settings
   */
  constructor(model, view, settings) {
    this.model = model;
    this.view = view;
    this.settings = settings;

    /** @type {import('../net/NetworkManager.js').NetworkManager|null} */
    this.net = null;

    /** Command history for potential undo/redo */
    this.history = [];

    /** Per-frame command queue */
    this._queue = [];

    /* ── Gamepad state ─────────────────────────────────── */
    this._gamepadIndex = null;
    this._deadzone = 0.15;
    this._lookSensitivity = 0.04; // radians/frame at full tilt
    this._prevShootPressed = false; // edge-detect triggers

    /** Whether the controller should process input (false while in menu) */
    this.enabled = false;
    /** Whether the mouse is hovering over the game canvas */
    this._mouseOver = false;

    this._bindKeyboard();
    this._bindMouse();
    this._bindGamepad();
  }

  /* ================================================================== */
  /*  Keyboard                                                           */
  /* ================================================================== */

  _bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.model.movement.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.model.movement.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.model.movement.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.model.movement.right = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.model.player.sprinting = true;
          break;
      }
    });
    document.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.model.movement.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.model.movement.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.model.movement.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.model.movement.right = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.model.player.sprinting = false;
          break;
      }
    });
  }

  /* ================================================================== */
  /*  Mouse + Pointer Lock                                               */
  /* ================================================================== */

  _bindMouse() {
    // Hover-based mouse look — no pointer lock needed for browser feel
    document.addEventListener('mouseenter', () => {
      this._mouseOver = true;
    });
    document.addEventListener('mouseleave', () => {
      this._mouseOver = false;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this._mouseOver || !this.enabled) return;
      const sens = this.settings.sensitivity;
      const invertMul = this.settings.invertY ? 1 : -1;
      const cmd = new LookCommand(
        this.model,
        -e.movementX * 0.002 * sens,
        invertMul * e.movementY * 0.002 * sens,
      );
      this._enqueue(cmd);
    });

    document.addEventListener('click', (e) => {
      if (!this.enabled) return;
      // Request pointer lock on click for raw movementX/Y data
      if (!document.pointerLockElement) {
        document.body.requestPointerLock();
        return;
      }
      const cmd = new ShootCommand(this.model, this.view, this.net);
      this._enqueue(cmd);
    });

    // ── ADS (aim-down-sights) — hold right mouse button ────
    document.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      if (e.button === 2) this.model.aiming = true;
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.model.aiming = false;
    });
    // Prevent context menu on right-click
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* ================================================================== */
  /*  Gamepad                                                            */
  /* ================================================================== */

  _bindGamepad() {
    window.addEventListener('gamepadconnected', (e) => {
      console.log(`Gamepad connected: ${e.gamepad.id}`);
      this._gamepadIndex = e.gamepad.index;
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log(`Gamepad disconnected: ${e.gamepad.id}`);
      if (this._gamepadIndex === e.gamepad.index) this._gamepadIndex = null;
    });
  }

  /**
   * Called once per frame to poll the gamepad and generate commands.
   */
  _pollGamepad() {
    if (this._gamepadIndex === null) return;

    const gp = navigator.getGamepads()[this._gamepadIndex];
    if (!gp) return;

    // ── Left stick → movement ──────────────────────────
    const lx = this._applyDeadzone(gp.axes[0]); // left/right
    const ly = this._applyDeadzone(gp.axes[1]); // up(−)/down(+)

    this.model.movement.forward = ly < 0;
    this.model.movement.backward = ly > 0;
    this.model.movement.left = lx < 0;
    this.model.movement.right = lx > 0;

    // Modulate speed by stick magnitude (analogue feel)
    const mag = Math.min(1, Math.sqrt(lx * lx + ly * ly));
    this.model.player.baseSpeed = 0.15 * (mag > 0 ? mag : 1);

    // ── D-pad (buttons 12-15) overlaid on movement ─────
    if (gp.buttons[12]?.pressed) this.model.movement.forward = true; // up
    if (gp.buttons[13]?.pressed) this.model.movement.backward = true; // down
    if (gp.buttons[14]?.pressed) this.model.movement.left = true; // left
    if (gp.buttons[15]?.pressed) this.model.movement.right = true; // right

    // ── L3 (button 10) → sprint ────────────────────────
    this.model.player.sprinting = !!gp.buttons[10]?.pressed;

    // ── Right stick → look ─────────────────────────────
    const sens = this.settings.sensitivity;
    const invertMul = this.settings.invertY ? 1 : -1;
    const rx = this._applyDeadzone(gp.axes[2]);
    const ry = this._applyDeadzone(gp.axes[3]);
    if (rx !== 0 || ry !== 0) {
      const cmd = new LookCommand(
        this.model,
        -rx * this._lookSensitivity * sens,
        invertMul * ry * this._lookSensitivity * sens,
      );
      this._enqueue(cmd);
    }

    // ── Right trigger RT (btn 7) / Right bumper RB (btn 5) → shoot ──
    const shootPressed = gp.buttons[7]?.pressed || gp.buttons[5]?.pressed;
    if (shootPressed && !this._prevShootPressed) {
      const cmd = new ShootCommand(this.model, this.view, this.net);
      this._enqueue(cmd);
    }
    this._prevShootPressed = shootPressed;

    // ── Left trigger LT (btn 6) → ADS ──────────────────────
    this.model.aiming = !!gp.buttons[6]?.pressed;
  }

  /**
   * Apply dead-zone to an axis value.
   * @param {number} val
   * @returns {number}
   */
  _applyDeadzone(val) {
    return Math.abs(val) < this._deadzone ? 0 : val;
  }

  /* ================================================================== */
  /*  Command queue                                                      */
  /* ================================================================== */

  /** @param {import('./commands/Command.js').Command} cmd */
  _enqueue(cmd) {
    this._queue.push(cmd);
  }

  /**
   * Called each frame by main loop.
   * Polls gamepad, adds the per-frame MoveCommand, then flushes command queue.
   */
  update() {
    if (!this.enabled) return;

    this._pollGamepad();

    // Always add a move command (it no-ops when no keys are held)
    const moveCmd = new MoveCommand(this.model, this.view);
    this._queue.push(moveCmd);

    // Flush
    for (const cmd of this._queue) {
      cmd.execute();
      this.history.push(cmd);
    }
    this._queue.length = 0;

    // Keep history from growing unbounded (last 200 commands)
    if (this.history.length > 200) {
      this.history.splice(0, this.history.length - 200);
    }
  }
}
