import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

let gradient: THREE.DataTexture | null = null;

/** 3 полосы света. */
export function toonGradient() {
  if (gradient) return gradient;
  const data = new Uint8Array([90, 90, 90, 255, 175, 175, 175, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export function toonMaterial(opts: THREE.MeshToonMaterialParameters = {}) {
  return new THREE.MeshToonMaterial({ gradientMap: toonGradient(), ...opts });
}

/** Толщина обводки — доля расстояния до камеры, поэтому на экране она почти постоянная. */
export const OUTLINE_K = { value: 0.0021 };

/** Чёрная обводка «inverted hull»: копия меша, грани наружу, вершины раздуты по нормали. */
export function outlineMaterial(color = 0x0d0820) {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineK = OUTLINE_K;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineK;')
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        vec3 on = objectNormal;
        #ifdef USE_INSTANCING
          on = mat3( instanceMatrix ) * on;
        #endif
        vec3 vn = normalize( normalMatrix * on );
        mvPosition.xyz += vn * outlineK * max( 1.0, -mvPosition.z );
        gl_Position = projectionMatrix * mvPosition;
      `);
    // в MeshBasicMaterial objectNormal объявлен только при skinning/envmap
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>',
      '#if !defined( USE_ENVMAP ) && !defined( USE_SKINNING )\nvec3 objectNormal = vec3( normal );\n#endif\n#include <begin_vertex>');
  };
  m.customProgramCacheKey = () => 'outline';
  return m;
}

/** Геометрия для обводки: сглаженные нормали, чтобы на углах не было дыр. */
export function outlineGeometry(geo: THREE.BufferGeometry) {
  const g = new THREE.BufferGeometry();
  for (const name of Object.keys(geo.attributes)) {
    if (name === 'normal' || name === 'uv' || name === 'color') continue;
    g.setAttribute(name, geo.attributes[name]);
  }
  if (geo.index) g.setIndex(geo.index);
  const merged = mergeVertices(g, 1e-4);
  merged.computeVertexNormals();
  return merged;
}

export function addOutline(mesh: THREE.Mesh, color?: number): THREE.Mesh {
  const o = new THREE.Mesh(outlineGeometry(mesh.geometry), outlineMaterial(color));
  o.renderOrder = -1;
  mesh.add(o);
  return o;
}

export function instancedOutline(src: THREE.InstancedMesh): THREE.InstancedMesh {
  const o = new THREE.InstancedMesh(outlineGeometry(src.geometry), outlineMaterial(), src.count);
  o.instanceMatrix = src.instanceMatrix;
  o.frustumCulled = false;
  return o;
}

/** Покрасить геометрию в один цвет (атрибут color). */
export function paint(geo: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const c = new THREE.Color(color);
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

/** Покраска по нормали: верх одним цветом, бока другим. */
export function paintTopSide(geo: THREE.BufferGeometry, top: THREE.ColorRepresentation, side: THREE.ColorRepresentation) {
  const ct = new THREE.Color(top), cs = new THREE.Color(side);
  const nrm = geo.attributes.normal;
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const c = nrm.getY(i) > 0.5 ? ct : cs;
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
