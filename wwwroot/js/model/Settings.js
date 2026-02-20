/**
 * Settings — centralised user-preferences model with localStorage persistence.
 * Every option (loadout, sensitivity, cosmetics) lives here.
 */
export class Settings {
  constructor() {
    // ── Defaults ────────────────────────────────────────────
    /** @type {'rifle'|'shotgun'|'pistol'} */
    this.weaponType = 'rifle';

    /** Mouse / stick sensitivity multiplier (0.5 – 3.0) */
    this.sensitivity = 1.0;

    /** Camera field-of-view (60 – 110) */
    this.fov = 75;

    /** Invert Y-axis look */
    this.invertY = false;

    /** Crosshair colour (CSS colour string) */
    this.crosshairColor = '#ffffff';

    /** Weapon skin base colour (hex string) */
    this.weaponSkin = '#222222';

    /** Projectile trail colour (hex string) */
    this.projectileColor = '#ffff00';

    /** HUD accent colour (hex string) */
    this.hudAccent = '#00aaff';

    /** Player display name (multiplayer) */
    this.playerName = 'Player';

    /** Persistent identifier (survives reloads) */
    this.playerId = null;

    /** Multiplayer server URL */
    this.serverUrl = 'https://bfps-production.up.railway.app';

    // ── Change callbacks ────────────────────────────────────
    /** @type {Function[]} */
    this._listeners = [];

    // Hydrate from localStorage
    this.load();

    // ensure persistent id exists
    if (!this.playerId) {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        this.playerId = crypto.randomUUID();
      } else {
        this.playerId = 'pid-' + Math.random().toString(36).slice(2);
      }
      this.save();
    }
  }

  /* ================================================================ */
  /*  Persistence                                                      */
  /* ================================================================ */

  /** Key used in localStorage */
  static STORAGE_KEY = 'bfps_settings';

  /** Save current values to localStorage. */
  save() {
    const data = {
      weaponType: this.weaponType,
      sensitivity: this.sensitivity,
      fov: this.fov,
      invertY: this.invertY,
      crosshairColor: this.crosshairColor,
      weaponSkin: this.weaponSkin,
      projectileColor: this.projectileColor,
      hudAccent: this.hudAccent,
      playerName: this.playerName,
      playerId: this.playerId,
      serverUrl: this.serverUrl,
    };
    try {
      localStorage.setItem(Settings.STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* quota errors are non-fatal */
    }
    this._notify();
  }

  /** Load values from localStorage (missing keys keep their defaults). */
  load() {
    try {
      const raw = localStorage.getItem(Settings.STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.weaponType) this.weaponType = data.weaponType;
      if (data.sensitivity != null) this.sensitivity = data.sensitivity;
      if (data.fov != null) this.fov = data.fov;
      if (data.invertY != null) this.invertY = data.invertY;
      if (data.crosshairColor) this.crosshairColor = data.crosshairColor;
      if (data.weaponSkin) this.weaponSkin = data.weaponSkin;
      if (data.projectileColor) this.projectileColor = data.projectileColor;
      if (data.hudAccent) this.hudAccent = data.hudAccent;
      if (data.playerName) this.playerName = data.playerName;
      if (data.playerId) this.playerId = data.playerId;
      if (data.serverUrl) this.serverUrl = data.serverUrl;
    } catch {
      /* corrupt JSON is non-fatal */
    }
  }

  /* ================================================================ */
  /*  Change notification                                              */
  /* ================================================================ */

  /**
   * Register a callback that fires after every save().
   * @param {Function} fn
   */
  onChange(fn) {
    this._listeners.push(fn);
  }

  /** @private */
  _notify() {
    for (const fn of this._listeners) fn(this);
  }
}
