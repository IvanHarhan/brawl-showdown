// Управление: телефон — два стика + кнопка супера; ПК — WASD + мышь.

export type AimKind = 'attack' | 'super';

export interface AimState {
  active: boolean;
  kind: AimKind;
  ax: number; ay: number;   // направление на экране (-1..1), y вниз
  mag: number;              // 0..1 — для супера с точкой
}

export interface InputHandlers {
  /** Выстрел: angle в координатах экрана (0 = вправо, y вниз), mag 0..1; auto=true — автоприцел */
  fire(kind: AimKind, angle: number, mag: number, auto: boolean): void;
}

const DEAD = 0.18;
const TAP_MS = 220;

export class Input {
  isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  mx = 0; my = 0;
  aim: AimState = { active: false, kind: 'attack', ax: 0, ay: 0, mag: 0 };
  mouse = { x: 0, y: 0, has: false };
  keys = new Set<string>();
  enabled = false;
  private moveId: number | null = null;
  private moveOrigin = { x: 0, y: 0 };
  private aimId: number | null = null;
  private aimOrigin = { x: 0, y: 0 };
  private aimStart = 0;
  private aimMoved = 0;
  els!: { root: HTMLElement; moveStick: HTMLElement; aimStick: HTMLElement; moveZone: HTMLElement; atk: HTMLElement; sup: HTMLElement };

  constructor(private h: InputHandlers) {
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'Space' && this.enabled) { e.preventDefault(); this.pcSuper(); }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.has = true; });
  }

  mount(root: HTMLElement) {
    const moveZone = root.querySelector('#moveZone') as HTMLElement;
    const atk = root.querySelector('#atkZone') as HTMLElement;
    const sup = root.querySelector('#supZone') as HTMLElement;
    const moveStick = root.querySelector('#moveStick') as HTMLElement;
    const aimStick = root.querySelector('#aimStick') as HTMLElement;
    this.els = { root, moveStick, aimStick, moveZone, atk, sup };

    moveZone.addEventListener('pointerdown', (e) => {
      if (this.moveId !== null) return;
      e.preventDefault();
      this.moveId = e.pointerId;
      this.moveOrigin = { x: e.clientX, y: e.clientY };
      moveZone.setPointerCapture(e.pointerId);
      this.placeStick(moveStick, e.clientX, e.clientY, 0, 0);
      moveStick.classList.remove('hidden');
    });
    moveZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.moveId) return;
      const [dx, dy] = this.vec(this.moveOrigin, e);
      this.mx = dx; this.my = dy;
      this.placeStick(moveStick, this.moveOrigin.x, this.moveOrigin.y, dx, dy);
    });
    const endMove = (e: PointerEvent) => {
      if (e.pointerId !== this.moveId) return;
      this.moveId = null; this.mx = 0; this.my = 0;
      moveStick.classList.add('hidden');
    };
    moveZone.addEventListener('pointerup', endMove);
    moveZone.addEventListener('pointercancel', endMove);

    const aimDown = (kind: AimKind) => (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.aimId !== null) return;
      if (kind === 'super' && !sup.classList.contains('ready')) return;
      const el = kind === 'attack' ? atk : sup;
      const r = el.getBoundingClientRect();
      this.aimId = e.pointerId;
      this.aimOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      this.aimStart = performance.now();
      this.aimMoved = 0;
      this.aim = { active: false, kind, ax: 0, ay: 0, mag: 0 };
      el.setPointerCapture(e.pointerId);
      aimStick.className = 'stick ' + kind;
      this.placeStick(aimStick, this.aimOrigin.x, this.aimOrigin.y, 0, 0);
    };
    const aimMove = (e: PointerEvent) => {
      if (e.pointerId !== this.aimId) return;
      const [dx, dy, mag] = this.vec(this.aimOrigin, e);
      this.aimMoved = Math.max(this.aimMoved, mag);
      this.aim.ax = dx; this.aim.ay = dy; this.aim.mag = mag;
      this.aim.active = mag > DEAD;
      this.placeStick(aimStick, this.aimOrigin.x, this.aimOrigin.y, dx, dy);
    };
    const aimUp = (e: PointerEvent) => {
      if (e.pointerId !== this.aimId) return;
      this.aimId = null;
      aimStick.classList.add('hidden');
      const kind = this.aim.kind;
      const quick = performance.now() - this.aimStart < TAP_MS && this.aimMoved < 0.35;
      if (e.type !== 'pointercancel') {
        if (quick) this.h.fire(kind, 0, 1, true);
        else if (this.aim.active) this.h.fire(kind, Math.atan2(this.aim.ay, this.aim.ax), this.aim.mag, false);
      }
      this.aim.active = false;
    };
    for (const [el, kind] of [[atk, 'attack'], [sup, 'super']] as const) {
      el.addEventListener('pointerdown', aimDown(kind));
      el.addEventListener('pointermove', aimMove);
      el.addEventListener('pointerup', aimUp);
      el.addEventListener('pointercancel', aimUp);
    }

    // ПК: ЛКМ — атака, ПКМ — супер (по точке мыши)
    root.addEventListener('mousedown', (e) => {
      if (this.isTouch || !this.enabled) return;
      if ((e.target as HTMLElement).closest('button')) return;
      if (e.button === 0) this.h.fire('attack', NaN, 1, false);
      if (e.button === 2) this.pcSuper();
    });
    if (!this.isTouch) root.classList.add('pc');
  }

  private pcSuper() { this.h.fire('super', NaN, 1, false); }

  private vec(o: { x: number; y: number }, e: PointerEvent): [number, number, number] {
    const R = 55;
    let dx = (e.clientX - o.x) / R, dy = (e.clientY - o.y) / R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    return [dx, dy, Math.min(1, m)];
  }

  private placeStick(el: HTMLElement, x: number, y: number, dx: number, dy: number) {
    el.classList.remove('hidden');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    (el.firstElementChild as HTMLElement).style.transform = `translate(calc(-50% + ${dx * 40}px), calc(-50% + ${dy * 40}px))`;
  }

  /** Движение с клавиатуры или стика (экранные оси, y вниз). */
  move(): [number, number] {
    let kx = 0, ky = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) ky -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) ky += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
    if (kx || ky) { const l = Math.hypot(kx, ky); return [kx / l, ky / l]; }
    const m = Math.hypot(this.mx, this.my);
    if (m < DEAD) return [0, 0];
    return [this.mx / m, this.my / m];
  }

  reset() {
    this.mx = this.my = 0;
    this.moveId = this.aimId = null;
    this.aim.active = false;
    this.keys.clear();
    this.els?.moveStick.classList.add('hidden');
    this.els?.aimStick.classList.add('hidden');
  }
}
