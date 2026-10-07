import * as THREE from 'three';

// Надписи на одежде. Текст и цвета можно менять здесь, модель пересобирать не нужно.
// pos — точка на груди в координатах модели (x вправо, y вверх, z вперёд), size — ширина и высота.
export interface Decal {
  lines: { text: string; size: number; bold?: boolean; italic?: boolean }[];
  pos: [number, number, number];
  size: [number, number];
  fg: string;
  bg: string | null;   // null — прозрачный фон
  frame?: boolean;      // рамка-этикетка
  bone?: string;        // к какой кости крепить (по умолчанию грудь)
  yaw?: number;         // поворот вокруг вертикали: 0 — смотрит вперёд, π/2 — вбок (нашивка на левом рукаве)
}

export const DECALS: Record<string, Decal[]> = {
  shop: [{
    lines: [{ text: 'JACK', size: 46, bold: true }, { text: "DANIEL'S", size: 46, bold: true }, { text: 'Old No.7', size: 28, italic: true }, { text: 'TENNESSEE', size: 22 }],
    pos: [0, 0.73, 0.218], size: [0.27, 0.3], fg: '#f2f2f2', bg: null, frame: true,
  }],
  mrp: [{
    lines: [{ text: 'Supreme', size: 70, bold: true, italic: true }],
    pos: [0, 0.69, 0.145], size: [0.17, 0.06], fg: '#ffffff', bg: '#d0141e',
  }],
  gamas: [{
    lines: [{ text: 'NAPAPIJRI', size: 60, bold: true }],
    pos: [0, 0.69, 0.168], size: [0.22, 0.06], fg: '#111111', bg: '#f2f2f2',
  }],
  iceberg: [{
    lines: [{ text: '✦', size: 70 }, { text: 'STONE ISLAND', size: 26, bold: true }],
    pos: [0.296, 0.696, 0], size: [0.1, 0.1], fg: '#f2c94c', bg: '#141414', bone: 'arm_L', yaw: Math.PI / 2,
  }],
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
    const font = (px: number) => `${l.italic ? 'italic ' : ''}${l.bold ? 900 : 700} ${px}px Arial Black, Arial, sans-serif`;
    g.font = font(l.size);
    // ужать текст по ширине, чтобы влезал
    const w = g.measureText(l.text).width, maxW = W - 40;
    if (w > maxW) g.font = font(Math.floor((l.size * maxW) / w));
    g.fillText(l.text, W / 2, y);
    y += l.size * 1.15;
  }  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Прикрепить надписи бойца к костям, чтобы они двигались вместе с анимацией. */
export function attachDecal(id: string, model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  for (const d of DECALS[id] ?? []) {
    const bone = model.getObjectByName(d.bone ?? 'chest');
    if (!bone) continue;
    const boneInModel = model.matrixWorld.clone().invert().multiply(bone.matrixWorld);
    const toBone = boneInModel.invert();
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...d.pos),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.yaw ?? 0),
      new THREE.Vector3(1, 1, 1),
    );
    const m = local.premultiply(toBone);
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(d.size[0], d.size[1]),
      new THREE.MeshBasicMaterial({ map: texture(d), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
    );
    m.decompose(plane.position, plane.quaternion, plane.scale);
    plane.renderOrder = 2;
    bone.add(plane);
  }
}