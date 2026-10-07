import * as THREE from 'three';

// Надписи на одежде. Текст и цвета можно менять здесь, модель пересобирать не нужно.
// pos — точка на груди в координатах модели (x вправо, y вверх, z вперёд), size — ширина и высота.
export interface Decal {
  lines: { text: string; size: number; bold?: boolean }[];
  pos: [number, number, number];
  size: [number, number];
  fg: string;
  bg: string | null;   // null — прозрачный фон
  frame?: boolean;      // рамка-этикетка
}

export const DECALS: Record<string, Decal> = {
  shop: {
    lines: [{ text: 'ШОП', size: 70, bold: true }, { text: 'Old №7', size: 30 }, { text: 'BURGER CLUB', size: 22 }],
    pos: [0, 0.73, 0.218], size: [0.27, 0.27], fg: '#f2f2f2', bg: null, frame: true,
  },
  gamas: {
    lines: [{ text: 'GAMAS', size: 64, bold: true }],
    pos: [0, 0.69, 0.168], size: [0.22, 0.075], fg: '#111111', bg: '#f2f2f2',
  },
};

function texture(d: Decal) {
  const W = 256, H = Math.round((256 * d.size[1]) / d.size[0]);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  if (d.bg) { g.fillStyle = d.bg; g.fillRect(0, 0, W, H); }
  g.fillStyle = d.fg; g.strokeStyle = d.fg;
  if (d.frame) { g.lineWidth = 8; g.strokeRect(10, 10, W - 20, H - 20); g.lineWidth = 3; g.strokeRect(22, 22, W - 44, H - 44); }
  const total = d.lines.reduce((s, l) => s + l.size * 1.15, 0);
  let y = (H - total) / 2;
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (const l of d.lines) {
    g.font = `${l.bold ? 900 : 700} ${l.size}px Arial Black, Arial, sans-serif`;
    // ужать текст по ширине, чтобы влезал
    const w = g.measureText(l.text).width, maxW = W - 50;
    if (w > maxW) g.font = `${l.bold ? 900 : 700} ${Math.floor((l.size * maxW) / w)}px Arial Black, Arial, sans-serif`;
    g.fillText(l.text, W / 2, y);
    y += l.size * 1.15;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Прикрепить надпись к кости груди, чтобы она двигалась вместе с анимацией. */
export function attachDecal(id: string, model: THREE.Object3D) {
  const d = DECALS[id];
  const bone = model.getObjectByName('chest');
  if (!d || !bone) return;
  model.updateMatrixWorld(true);
  const boneInModel = model.matrixWorld.clone().invert().multiply(bone.matrixWorld);
  const toBone = boneInModel.invert();
  const m = new THREE.Matrix4().makeTranslation(d.pos[0], d.pos[1], d.pos[2]).premultiply(toBone);
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(d.size[0], d.size[1]),
    new THREE.MeshBasicMaterial({ map: texture(d), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  m.decompose(plane.position, plane.quaternion, plane.scale);
  plane.renderOrder = 2;
  bone.add(plane);
}
