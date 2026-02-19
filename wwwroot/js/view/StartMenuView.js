/**
 * StartMenuView — a minimal title screen that sits transparently
 * over the rendered 3D game world (starry sky + maze).
 */
export class StartMenuView {
  /**
   * @param {Function} onStart – called when PLAY is clicked
   */
  constructor(onStart) {
    this._onStart = onStart;
    this._visible = true;
    this._buildDOM();
  }

  /* ─────────────────────────────────────────────────────────── */

  _buildDOM() {
    this._root = document.createElement('div');
    this._root.id = 'startMenu';
    this._root.style.cssText =
      'position:fixed;inset:0;z-index:35;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;' +
      'background:url("img/image0.png") center/cover no-repeat;' +
      'font-family:Arial,Helvetica,sans-serif;color:white;';
    document.body.appendChild(this._root);

    // Title
    const title = document.createElement('div');
    title.style.cssText = 'text-align:center;margin-bottom:50px;';
    title.innerHTML =
      '<div style="font-size:96px;font-weight:900;letter-spacing:12px;' +
      'text-shadow:0 0 40px rgba(0,150,255,0.7),0 0 80px rgba(0,80,255,0.35);">BFPS</div>' +
      '<div style="font-size:16px;letter-spacing:5px;opacity:0.55;margin-top:8px;">' +
      'BROWSER FIRST-PERSON SHOOTER</div>';
    this._root.appendChild(title);

    // PLAY button
    const btn = document.createElement('button');
    btn.textContent = 'PLAY';
    btn.style.cssText =
      'padding:20px 80px;font-size:24px;font-weight:800;letter-spacing:4px;' +
      'border:3px solid #00cc44;background:rgba(0,0,0,0.5);color:white;cursor:pointer;' +
      'transition:all 0.25s;font-family:inherit;';
    btn.addEventListener('mouseenter', () => {
      btn.style.background = '#00cc44';
      btn.style.boxShadow = '0 0 30px rgba(0,204,68,0.6)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'rgba(0,0,0,0.5)';
      btn.style.boxShadow = 'none';
    });
    btn.addEventListener('click', () => this._onStart());
    this._root.appendChild(btn);

    // Subtle hint
    const hint = document.createElement('div');
    hint.style.cssText =
      'margin-top:40px;font-size:13px;opacity:0.4;letter-spacing:2px;';
    hint.textContent = 'CLICK PLAY TO ENTER LOBBY';
    this._root.appendChild(hint);
  }

  /* ── Public API ──────────────────────────────────────────── */

  show() {
    this._visible = true;
    this._root.style.display = 'flex';
  }

  hide() {
    this._visible = false;
    this._root.style.display = 'none';
  }

  get visible() {
    return this._visible;
  }
}
