// Genera los modelos 3D del mockup: GLB livianos, sin texturas ni programas de 3D.
// Uso:  node mockups/generar.mjs   → escribe camiseta.glb, buzo.glb, taza.glb, termo.glb y tote.glb aquí.
//
// La taza, el termo y la tote se arman con matemática. La camiseta y el buzo parten de una forma hecha con IA
// (fuentes/camiseta.glb y fuentes/buzo.glb) que aquí se adapta. Todo pesa poco para que cargue rápido en celulares
// y equipos sin tarjeta de video. Se modela en cm y se guarda en metros (lo que pide glTF). Y apunta arriba y Z
// hacia el frente.
//
// Lo que Tramaluz lee de cada GLB:
//  - Materiales por nombre: print_frente, print_espalda y print (donde va el diseño), tela, rib, ceramica y
//    metal (toman el color elegido), tapa y puntera (color fijo).
//  - extras.lienzo de cada material de impresión: [ancho, alto] en cm del área que cubren sus UV (0..1).
//  - extras.tramaluz de la escena: dónde va el diseño en cada ubicación, en cm dentro del lienzo
//    (cx = centro horizontal; top = borde de arriba, o cy = centro vertical) y desde qué ángulo mirarlo (vista).
//  - COLOR_0 (si está): sombra de pliegues e interior, que multiplica el color de la tela.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const PI = Math.PI;

/* ---------- vectores ---------- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- superficies en grilla ---------- */
// nu columnas (u) por nv filas (v). wrapU: la columna nu es la misma que la 0 (tubo cerrado).
function surface(nu, nv, f, { wrapU = false } = {}) {
  const cols = wrapU ? nu : nu + 1, P = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i < cols; i++) P.push(f(i / nu, j / nv, i, j));
  const S = { nu, nv, cols, wrapU, P, flip: false };
  S.at = (i, j) => j * cols + (wrapU ? i % nu : i);
  normals(S);
  return S;
}
function normals(S) {
  const N = S.P.map(() => [0, 0, 0]);
  for (let j = 0; j < S.nv; j++) for (let i = 0; i < S.nu; i++) {
    const a = S.at(i, j), b = S.at(i + 1, j), c = S.at(i + 1, j + 1), d = S.at(i, j + 1);
    for (const [x, y, z] of [[a, b, c], [a, c, d]]) {
      const n = cross(sub(S.P[y], S.P[x]), sub(S.P[z], S.P[x]));
      for (const k of [x, y, z]) N[k] = add(N[k], n);
    }
  }
  S.N = N.map(norm);
}
// Da vuelta la superficie si sus normales apuntan hacia adentro. inside(p, i, j) = un punto de adentro.
function orient(S, inside) {
  let s = 0;
  for (let j = 0; j <= S.nv; j++) for (let i = 0; i < S.cols; i++) { const k = S.at(i, j); s += dot(S.N[k], sub(S.P[k], inside(S.P[k], i, j))); }
  if (s < 0) { S.flip = true; S.N = S.N.map(n => mul(n, -1)); }
  return S;
}
// Centro de cada fila (sirve como "adentro" en tubos y piezas torneadas)
function rowCenters(S) {
  const C = [];
  for (let j = 0; j <= S.nv; j++) { let c = [0, 0, 0]; for (let i = 0; i < S.cols; i++) c = add(c, S.P[S.at(i, j)]); C.push(mul(c, 1 / S.cols)); }
  return (p, i, j) => C[j];
}

/* ---------- modelo: una malla con una primitiva por material ---------- */
class Model {
  constructor(name) { this.name = name; this.prims = new Map(); }
  prim(mat) { if (!this.prims.has(mat)) this.prims.set(mat, { mat, pos: [], nrm: [], uv: [], idx: [] }); return this.prims.get(mat); }
  // mat: nombre o función (i, j) → nombre (null = no se dibuja). uv(mat, p, u, v) → [s, t]
  add(S, mat, uv = null) {
    const maps = new Map();
    for (let j = 0; j < S.nv; j++) for (let i = 0; i < S.nu; i++) {
      const m = typeof mat === 'function' ? mat(i, j) : mat; if (!m) continue;
      const pr = this.prim(m); let mp = maps.get(m); if (!mp) maps.set(m, mp = new Map());
      const vid = (ii, jj) => {
        const key = ii * 65536 + jj; let k = mp.get(key); if (k !== undefined) return k;
        const at = S.at(ii, jj), p = S.P[at], n = S.N[at];
        k = pr.pos.length / 3; pr.pos.push(...p); pr.nrm.push(...n);
        const t = uv ? uv(m, p, ii / S.nu, jj / S.nv) : [ii / S.nu, jj / S.nv]; pr.uv.push(t[0], t[1]);
        mp.set(key, k); return k;
      };
      const a = vid(i, j), b = vid(i + 1, j), c = vid(i + 1, j + 1), d = vid(i, j + 1);
      const tri = (x, y, z) => {
        const P = pr.pos, A = [P[x * 3], P[x * 3 + 1], P[x * 3 + 2]], B = [P[y * 3], P[y * 3 + 1], P[y * 3 + 2]], C = [P[z * 3], P[z * 3 + 1], P[z * 3 + 2]];
        if (len(cross(sub(B, A), sub(C, A))) < 1e-7) return; // triángulo sin área (polo)
        if (S.flip) pr.idx.push(x, z, y); else pr.idx.push(x, y, z);
      };
      tri(a, b, c); tri(a, c, d);
    }
  }
}

/* ---------- piezas genéricas ---------- */
// Tubo que sigue una curva (abierta o cerrada) con un perfil cerrado.
// path: puntos; up(i): vector que orienta el perfil; profile: [[x, y], ...] en el plano (lado, arriba) del perfil.
function sweep(path, profile, { closed = false, up = null } = {}) {
  const n = path.length, F = [];
  for (let i = 0; i < n; i++) {
    const a = path[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = path[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const T = norm(sub(b, a));
    let U = up ? up(i, path[i], T) : [0, 1, 0];
    U = norm(sub(U, mul(T, dot(U, T)))); const Sd = cross(T, U);
    F.push({ T, U, Sd });
  }
  const segs = closed ? n : n - 1;
  const S = surface(profile.length, segs, (u, v, i, j) => {
    const k = j % n, f = F[k], pr = profile[i % profile.length];
    return add(path[k], add(mul(f.Sd, pr[0]), mul(f.U, pr[1])));
  }, { wrapU: true });
  return orient(S, (p, i, j) => path[j % n]);
}
const circle = (r, n = 8) => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * PI * i / n), r * Math.sin(2 * PI * i / n)]);
const ellipse = (rx, ry, n = 10) => Array.from({ length: n }, (_, i) => [rx * Math.cos(2 * PI * i / n), ry * Math.sin(2 * PI * i / n)]);
// Pieza torneada: perfil [[r, y], ...] girado en Y. u = 0 en la espalda (−Z), 0,5 al frente (+Z).
function lathe(profile, nu) {
  const nv = profile.length - 1;
  const S = surface(nu, nv, (u, v, i, j) => { const [r, y] = profile[j], a = 2 * PI * u - PI; return [r * Math.sin(a), y, r * Math.cos(a)]; }, { wrapU: true });
  return orient(S, (p, i, j) => [0, p[1], 0]);
}
// Ruido suave (para arrugas)
function noise2(x, y) {
  const h = (a, b) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(h(xi, yi), h(xi + 1, yi), u), lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v) * 2 - 1;
}

/* ---------- prendas: camiseta y buzo ---------- */
// La forma de la camiseta y del buzo la hizo una IA (Tripo, por Higgsfield, noviembre de 2026) y está tal cual en
// fuentes/. Aquí se gira y escala a cm, se abren el ruedo y los puños si vienen tapados, se separa en frente, espalda
// y el resto (cada zona de impresión con las UV de su lienzo) y se guarda en los colores de los vértices la sombra de
// los pliegues y del interior (oclusión ambiental): así parece tela aunque la escena tenga pocas luces.

// Lee la malla de un GLB sin comprimir y suelda los vértices repetidos (la IA los corta donde cambian sus UV)
function readMesh(file) {
  const b = readFileSync(file), jl = b.readUInt32LE(12), j = JSON.parse(b.subarray(20, 20 + jl).toString()), bin = b.subarray(28 + jl);
  const acc = i => {
    const a = j.accessors[i], v = j.bufferViews[a.bufferView], n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
    const Ty = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
    const o = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
    return new Ty(bin.buffer.slice(o, o + a.count * n * Ty.BYTES_PER_ELEMENT));
  };
  const P = [], T = [], seen = new Map();
  for (const pr of j.meshes[0].primitives) {
    const pos = acc(pr.attributes.POSITION), W = [];
    const idx = pr.indices != null ? acc(pr.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
    for (let i = 0; i < pos.length; i += 3) {
      const k = `${Math.round(pos[i] * 1e5)},${Math.round(pos[i + 1] * 1e5)},${Math.round(pos[i + 2] * 1e5)}`;
      let w = seen.get(k); if (w === undefined) { w = P.length; seen.set(k, w); P.push([pos[i], pos[i + 1], pos[i + 2]]); }
      W.push(w);
    }
    for (let t = 0; t < idx.length; t += 3) { const a = W[idx[t]], c = W[idx[t + 1]], d = W[idx[t + 2]]; if (a !== c && c !== d && a !== d) T.push([a, c, d]); }
  }
  return { P, T };
}

// Rayos contra la malla, con un árbol de cajas. cast(origen, dirección, tmax) → distancia al primer choque (o Infinity)
function rayCaster(P, T) {
  const nt = T.length, V = new Float64Array(nt * 9), C = new Float64Array(nt * 3), lo = new Float64Array(nt * 3), hi = new Float64Array(nt * 3);
  T.forEach((tr, t) => tr.forEach((v, k) => { for (let d = 0; d < 3; d++) V[t * 9 + k * 3 + d] = P[v][d]; }));
  for (let t = 0; t < nt; t++) for (let d = 0; d < 3; d++) {
    const a = V[t * 9 + d], b = V[t * 9 + 3 + d], c = V[t * 9 + 6 + d];
    lo[t * 3 + d] = Math.min(a, b, c); hi[t * 3 + d] = Math.max(a, b, c); C[t * 3 + d] = (a + b + c) / 3;
  }
  const order = Uint32Array.from({ length: nt }, (_, i) => i), nodes = []; // nodo: caja (6), hijo o primer triángulo, cantidad
  const build = (s, e) => {
    const id = nodes.length, n = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0]; nodes.push(n);
    for (let i = s; i < e; i++) for (let d = 0; d < 3; d++) { n[d] = Math.min(n[d], lo[order[i] * 3 + d]); n[3 + d] = Math.max(n[3 + d], hi[order[i] * 3 + d]); }
    if (e - s <= 6) { n[6] = s; n[7] = e - s; return id; }
    let ax = 0; for (let d = 1; d < 3; d++) if (n[3 + d] - n[d] > n[3 + ax] - n[ax]) ax = d;
    order.set(Array.from(order.subarray(s, e)).sort((a, b) => C[a * 3 + ax] - C[b * 3 + ax]), s);
    const m = (s + e) >> 1; build(s, m); n[6] = build(m, e); return id; // el hijo izquierdo es id + 1
  };
  build(0, nt);
  const st = new Int32Array(128);
  return (o, d, tmax = Infinity) => {
    let best = tmax, sp = 0; st[sp++] = 0;
    const ix = 1 / (d[0] || 1e-12), iy = 1 / (d[1] || 1e-12), iz = 1 / (d[2] || 1e-12);
    while (sp) {
      const id = st[--sp], n = nodes[id];
      let a = (n[0] - o[0]) * ix, b = (n[3] - o[0]) * ix, t0 = Math.min(a, b), t1 = Math.max(a, b);
      a = (n[1] - o[1]) * iy; b = (n[4] - o[1]) * iy; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
      a = (n[2] - o[2]) * iz; b = (n[5] - o[2]) * iz; t0 = Math.max(t0, Math.min(a, b)); t1 = Math.min(t1, Math.max(a, b));
      if (t1 < Math.max(t0, 0) || t0 > best) continue;
      if (!n[7]) { st[sp++] = id + 1; st[sp++] = n[6]; continue; }
      for (let i = n[6]; i < n[6] + n[7]; i++) { // Möller–Trumbore
        const q = order[i] * 9;
        const e1x = V[q + 3] - V[q], e1y = V[q + 4] - V[q + 1], e1z = V[q + 5] - V[q + 2], e2x = V[q + 6] - V[q], e2y = V[q + 7] - V[q + 1], e2z = V[q + 8] - V[q + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x, det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const sx = o[0] - V[q], sy = o[1] - V[q + 1], sz = o[2] - V[q + 2], u = (sx * px + sy * py + sz * pz) / det; if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (d[0] * qx + d[1] * qy + d[2] * qz) / det; if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) / det; if (t > 1e-4 && t < best) best = t;
      }
    }
    return best < tmax ? best : Infinity;
  };
}

const faceNormal = (P, [a, b, c]) => cross(sub(P[b], P[a]), sub(P[c], P[a])); // largo = 2 × área
function vertexNormals(P, T) {
  const N = P.map(() => [0, 0, 0]);
  for (const tr of T) { const n = faceNormal(P, tr); for (const v of tr) N[v] = add(N[v], n); }
  return N.map(norm);
}

// Grilla vista de frente (x, y): para cada celda, guarda un valor por función. Muestreo bilineal (ignora celdas vacías).
function grid(lo, hi, step) {
  const nx = Math.ceil((hi[0] - lo[0]) / step) + 1, ny = Math.ceil((hi[1] - lo[1]) / step) + 1;
  const G = { nx, ny, step, x: i => lo[0] + i * step, y: j => lo[1] + j * step, make: f => { const A = new Float64Array(nx * ny); for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) A[j * nx + i] = f(lo[0] + i * step, lo[1] + j * step, i, j); return A; } };
  G.at = (A, x, y) => {
    const fx = clamp((x - lo[0]) / step, 0, nx - 1.001), fy = clamp((y - lo[1]) / step, 0, ny - 1.001), i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j;
    let s = 0, w = 0;
    for (const [di, dj, k] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
      const v = A[(j + dj) * nx + i + di]; if (Number.isFinite(v) && k > 0) { s += v * k; w += k; }
    }
    return w > 0 ? s / w : NaN;
  };
  // Desenfoque gaussiano que solo promedia celdas con valor (r = radio en cm)
  G.blur = (A, r) => {
    const k = Math.ceil(2 * r / step), wts = Array.from({ length: 2 * k + 1 }, (_, i) => Math.exp(-(((i - k) * step) ** 2) / (2 * r * r)));
    const pass = (src, dx, dy) => G.make((x, y, i, j) => {
      let s = 0, w = 0;
      for (let m = -k; m <= k; m++) { const ii = i + m * dx, jj = j + m * dy; if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue; const v = src[jj * nx + ii]; if (Number.isFinite(v)) { s += v * wts[m + k]; w += wts[m + k]; } }
      return Number.isFinite(src[j * nx + i]) && w > 0 ? s / w : NaN;
    });
    return pass(pass(A, 1, 0), 0, 1);
  };
  return G;
}

// Quita tapas (el fondo del ruedo o de un puño que la IA dejó cerrado): desde el triángulo que toca un rayo que sube
// por (x, z), recorre los vecinos mientras miren hacia el mismo lado.
function openCaps(P, T, cast, seeds) {
  const edge = new Map();
  T.forEach((tr, t) => tr.forEach((v, k) => { const w = tr[(k + 1) % 3], e = Math.min(v, w) + ',' + Math.max(v, w); (edge.get(e) || edge.set(e, []).get(e)).push(t); }));
  const FN = T.map(tr => norm(faceNormal(P, tr))), cut = new Set();
  for (const [x, z] of seeds) {
    // el primer triángulo que corta el rayo: se busca entre los que están bajo el punto
    const y0 = Math.min(...P.map(p => p[1])) - 5, t = cast([x, y0, z], [0, 1, 0]); if (t === Infinity) continue;
    const hit = [x, y0 + t, z];
    let seed = -1, bd = Infinity;
    T.forEach((tr, i) => { const c = mul(add(add(P[tr[0]], P[tr[1]]), P[tr[2]]), 1 / 3), dd = len(sub(c, hit)); if (dd < bd) { bd = dd; seed = i; } });
    const n0 = FN[seed], stack = [seed]; cut.add(seed);
    while (stack.length) {
      const t2 = stack.pop();
      T[t2].forEach((v, k) => {
        const w = T[t2][(k + 1) % 3];
        for (const u of edge.get(Math.min(v, w) + ',' + Math.max(v, w))) if (!cut.has(u) && dot(FN[u], n0) > 0.8) { cut.add(u); stack.push(u); }
      });
    }
  }
  return T.filter((_, i) => !cut.has(i));
}

// Arma una prenda. o: name, alto (cm), abrir (true: quitar tapas), rib(centro, máximos) (puños y pretina), cordones
// (altura en cm desde donde se buscan, sobre el bolsillo) y lados(medidas, lienzo): dónde va el diseño en cada ubicación.
function garment(o) {
  const src = readMesh(join(DIR, 'fuentes', o.name + '.glb'));
  // La IA la entrega mirando a +X y de 1 de alto: queda mirando a +Z, en cm, centrada y con el ruedo en y = 0
  const lo = [0, 1, 2].map(k => Math.min(...src.P.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...src.P.map(p => p[k])));
  const s = o.alto / (hi[1] - lo[1]), cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
  const P = src.P.map(([x, y, z]) => [-(z - cz) * s, (y - lo[1]) * s, (x - cx) * s]);
  let T = src.T, cast = rayCaster(P, T);
  const B = [0, 1, 2].map(k => Math.min(...P.map(p => p[k]))), H = [0, 1, 2].map(k => Math.max(...P.map(p => p[k])));

  if (o.abrir) {
    // el ruedo (centro) y los puños (el centro de lo más bajo de cada manga)
    const seeds = [[0, 0]];
    for (const sx of [1, -1]) {
      const arm = P.filter(p => sx * p[0] > 0.6 * H[0]), y0 = Math.min(...arm.map(p => p[1])), low = arm.filter(p => p[1] < y0 + 3);
      seeds.push([low.reduce((a, p) => a + p[0], 0) / low.length, low.reduce((a, p) => a + p[2], 0) / low.length]);
    }
    T = openCaps(P, T, cast, seeds); cast = rayCaster(P, T);
  }
  const N = vertexNormals(P, T);

  // Vista de frente y de espalda en una grilla de 0,5 cm: dónde está la tela adelante (F) y atrás (K)
  const G = grid(B, H, 0.5), far = 1000;
  const F = G.make((x, y) => { const t = cast([x, y, H[2] + 1], [0, 0, -1]); return t < far ? H[2] + 1 - t : NaN; });
  const K = G.make((x, y) => { const t = cast([x, y, B[2] - 1], [0, 0, 1]); return t < far ? B[2] - 1 + t : NaN; });
  const mid = G.make((x, y, i, j) => (F[j * G.nx + i] + K[j * G.nx + i]) / 2);
  // UV del lienzo: a lo ancho se mide sobre la tela (largo del arco, sin los pliegues chicos), como se imprime en plano
  const arc = A => {
    const Z = G.blur(A, 2.5), S = new Float64Array(G.nx * G.ny), i0 = Math.round(-B[0] / G.step);
    for (let j = 0; j < G.ny; j++) for (const dir of [1, -1]) for (let i = i0 + dir; i >= 0 && i < G.nx; i += dir) {
      const a = Z[j * G.nx + i], b = Z[j * G.nx + i - dir], dz = Number.isFinite(a) && Number.isFinite(b) ? clamp(a - b, -1.2, 1.2) : 0;
      S[j * G.nx + i] = S[j * G.nx + i - dir] + dir * Math.hypot(G.step, dz);
    }
    return S;
  };
  const SF = arc(F), SK = arc(K);
  const top = Math.ceil(H[1]) + 1, C = { top, h: top + 1, w: 0 };
  const sideOf = c => { const m = G.at(mid, c[0], c[1]); return c[2] > (Number.isFinite(m) ? m : 0) ? 'print_frente' : 'print_espalda'; };

  // Tela por dentro: el rayo que sale por su normal choca con la prenda lejos (no es un pliegue)
  const inner = P.map((p, v) => { const t = cast(add(p, mul(N[v], 0.05)), N[v]); return t > 6 && t < far; });

  // Cordones del buzo: lo que sobresale del pecho (comparado con la mediana de 5 cm a lo ancho)
  const cord = new Set(), tips = new Set();
  if (o.cordones) {
    const Fm = G.make((x, y, i, j) => { const r = []; for (let m = -5; m <= 5; m++) { const v = F[j * G.nx + clamp(i + m, 0, G.nx - 1)]; if (Number.isFinite(v)) r.push(v); } r.sort((a, b) => a - b); return r.length ? r[r.length >> 1] : NaN; });
    const neck = neckFront(G, F);
    const out = P.map(p => Math.abs(p[0]) < 14 && p[1] > o.cordones && p[1] < neck - 1.5 && p[2] > 0 && p[2] > G.at(Fm, p[0], p[1]) + 0.3);
    T.forEach((tr, t) => { if (tr.filter(v => out[v]).length >= 2) cord.add(t); });
    for (const sx of [1, -1]) { // las punteras: los últimos 2,2 cm de cada cordón
      const ys = [...cord].filter(t => sx * P[T[t][0]][0] > 0).flatMap(t => T[t].map(v => P[v][1])), y0 = Math.min(...ys);
      for (const t of cord) if (sx * P[T[t][0]][0] > 0 && T[t].every(v => P[v][1] < y0 + 2.2)) tips.add(t);
    }
  }

  // Sombra (oclusión ambiental): 32 rayos por vértice hacia afuera; lo que choca a menos de D cm oscurece. Adentro, más.
  const DIRS = Array.from({ length: 32 }, (_, k) => { const r = Math.sqrt((k + 0.5) / 32), a = k * 2.39996; return [r * Math.cos(a), r * Math.sin(a), Math.sqrt(1 - r * r)]; });
  const D = 12;
  let AO = P.map((p, v) => {
    const n = N[v], t1 = norm(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), t2 = cross(n, t1), o0 = add(p, mul(n, 0.05));
    const rot = (v * 0.618034) % 1 * 2 * PI, cr = Math.cos(rot), sr = Math.sin(rot);
    let occ = 0;
    for (const [a, b, c] of DIRS) {
      const x = a * cr - b * sr, y = a * sr + b * cr, d = add(add(mul(t1, x), mul(t2, y)), mul(n, c));
      const t = cast(o0, d, D); if (t < D) occ += 1 - t / D;
    }
    return (1 - occ / DIRS.length) * (inner[v] ? 0.55 : 1);
  });
  // suavizado: promedio con los vecinos (quita el ruido de pocos rayos)
  const nb = P.map(() => new Set()); for (const tr of T) for (const v of tr) for (const w of tr) if (v !== w) nb[v].add(w);
  for (let it = 0; it < 2; it++) AO = AO.map((a, v) => { let s = a, n = 1; for (const w of nb[v]) { s += AO[w]; n++; } return s / n; });

  // Materiales y UV
  const M = new Model(o.name), keys = new Map();
  const matOf = (tr, t) => {
    const c = mul(add(add(P[tr[0]], P[tr[1]]), P[tr[2]]), 1 / 3);
    if (tips.has(t)) return 'puntera';
    if (cord.has(t)) return 'rib';
    if (tr.filter(v => inner[v]).length >= 2) return 'tela';
    if (o.rib && o.rib(c, H)) return 'rib';
    return sideOf(c);
  };
  const mats = T.map(matOf);
  // ancho del lienzo: lo que mide la tela de lado a lado (frente y espalda usan el mismo)
  T.forEach((tr, t) => { if (mats[t].startsWith('print')) for (const v of tr) C.w = Math.max(C.w, 2 * Math.abs(G.at(mats[t] === 'print_frente' ? SF : SK, P[v][0], P[v][1])) + 2); });
  C.w = Math.ceil(C.w);
  T.forEach((tr, t) => {
    const m = mats[t], pr = M.prim(m); let mp = keys.get(m); if (!mp) keys.set(m, mp = new Map());
    const ids = tr.map(v => {
      let k = mp.get(v); if (k !== undefined) return k;
      const p = P[v]; k = pr.pos.length / 3; mp.set(v, k);
      pr.pos.push(...p); pr.nrm.push(...N[v]); (pr.col || (pr.col = [])).push(AO[v]);
      const sF = G.at(SF, p[0], p[1]), sK = G.at(SK, p[0], p[1]);
      if (m === 'print_frente') pr.uv.push((sF + C.w / 2) / C.w, (C.top - p[1]) / C.h);
      else if (m === 'print_espalda') pr.uv.push((C.w / 2 - sK) / C.w, (C.top - p[1]) / C.h);
      else pr.uv.push(0, 0);
      return k;
    });
    pr.idx.push(...ids);
  });

  // Medidas para ubicar el diseño (en cm desde el ruedo)
  const meas = { neckFront: neckFront(G, F), backTop: 0, hoodEnd: 0 };
  const i0 = Math.round(-B[0] / G.step);
  for (let j = G.ny - 1; j >= 0; j--) if (Number.isFinite(K[j * G.nx + i0])) { meas.backTop = G.y(j); break; }
  for (let j = G.ny - 1; j > 0; j--) { // donde termina la capucha en la espalda: la tela salta hacia adelante
    const a = K[j * G.nx + i0], b = K[(j - 1) * G.nx + i0];
    if (Number.isFinite(a) && Number.isFinite(b) && b - a > 1) { meas.hoodEnd = G.y(j); break; }
  }
  console.log(`  ${o.name}: ${(H[0] - B[0]).toFixed(1)} × ${(H[1] - B[1]).toFixed(1)} × ${(H[2] - B[2]).toFixed(1)} cm · lienzo ${C.w} × ${C.h} · ` +
    `escote ${meas.neckFront.toFixed(1)} · espalda ${meas.backTop.toFixed(1)}${o.cordones ? ` · capucha ${meas.hoodEnd.toFixed(1)} · cordones ${cord.size} (punteras ${tips.size}, desde ${Math.min(...[...cord].map(t => P[T[t][0]][1])).toFixed(1)} cm)` : ''}`);
  return { M, lienzo: [C.w, C.h], info: { lados: o.lados(meas, C) } };
}
// Altura del escote al frente: subiendo por el centro, donde la tela de adelante se termina (se ve el interior)
function neckFront(G, F) {
  const i0 = Math.round((0 - G.x(0)) / G.step); let y = 0;
  for (let j = Math.round((20 - G.y(0)) / G.step); j < G.ny; j++) { const v = F[j * G.nx + i0]; if (!(v > 0)) break; y = G.y(j); }
  return y;
}

function camiseta() {
  return garment({
    name: 'camiseta', alto: 75,
    lados: (m, C) => ({
      frente: { mat: 'print_frente', cx: C.w / 2, top: C.top - (m.neckFront - 8), vista: 0 },
      espalda: { mat: 'print_espalda', cx: C.w / 2, top: C.top - (m.backTop - 10), vista: 180 },
      pecho: { mat: 'print_frente', cx: C.w / 2 + 10.5, top: C.top - (m.neckFront - 4.5), vista: 0 },
    }),
  });
}

function buzo() {
  return garment({
    name: 'buzo', alto: 82, abrir: true, cordones: 36,
    rib: (c, H) => c[1] < (Math.abs(c[0]) > 0.6 * H[0] ? 9 : 7), // pretina y puños
    lados: (m, C) => ({
      frente: { mat: 'print_frente', cx: C.w / 2, top: C.top - (m.neckFront - 7), vista: 0 },
      espalda: { mat: 'print_espalda', cx: C.w / 2, top: C.top - (m.hoodEnd - 3), vista: 180 },
      pecho: { mat: 'print_frente', cx: C.w / 2 + 12, top: C.top - (m.neckFront - 5), vista: 0 }, // al lado del cordón
    }),
  });
}

/* ---------- taza 11 oz ---------- */
function taza() {
  const M = new Model('taza');
  const R = 4.1, y0 = 0.45, y1 = 9.25;
  const prof = [[0, 0], [2.9, 0], [3.55, 0.05], [3.88, 0.17], [4.05, 0.33], [R, y0], [R, y1], [4.08, 9.42], [4.0, 9.53], [3.88, 9.56], [3.77, 9.48], [3.73, 9.3], [3.72, 1.3], [3.62, 0.95], [3.3, 0.78], [2.4, 0.72], [0, 0.71]];
  const body = lathe(prof, 64);
  const circ = 2 * PI * R, H = y1 - y0;
  M.add(body, (i, j) => j === 5 ? 'print' : 'ceramica', (m, p, u) => m === 'print' ? [u, (y1 - p[1]) / H] : [u, 0]);
  // Asa atrás (−Z), en el plano YZ
  const path = [];
  for (let k = 0; k <= 20; k++) { const a = lerp(PI / 2 + 0.24, -PI / 2 - 0.24, k / 20); path.push([0, 4.95 + 3.15 * Math.sin(a), -R + 0.55 - 3.05 * Math.cos(a) - 0.55]); }
  M.add(sweep(path, ellipse(0.46, 0.68, 12), { up: () => [1, 0, 0] }), 'ceramica'); // 1,4 cm de ancho, 0,9 de grueso
  return {
    M, lienzo: [circ, H],
    // frente: centrado al lado contrario del asa (diseños que rodean la taza)
    // lado: a 90° del asa, que queda a la derecha al mirar el diseño (el mockup clásico de taza)
    info: { lados: { frente: { mat: 'print', cx: circ / 2, cy: H / 2, vista: 35 }, lado: { mat: 'print', cx: circ * 0.75, cy: H / 2, vista: 90 } } },
  };
}

/* ---------- termo (botella de 750 ml) ---------- */
function termo() {
  const M = new Model('termo');
  const R = 3.6, y0 = 1.0, y1 = 19.4;
  const prof = [[0, 0], [3.0, 0], [3.38, 0.08], [3.55, 0.3], [R, 0.6], [R, y0], [R, y1], [3.58, 19.9], [3.48, 20.6], [3.25, 21.25], [2.9, 21.75], [2.62, 22.1], [2.55, 22.4], [2.55, 22.9], [2.2, 22.95], [0, 22.95]];
  const body = lathe(prof, 64);
  const circ = 2 * PI * R, H = y1 - y0;
  M.add(body, (i, j) => j === 5 ? 'print' : 'metal', (m, p, u) => m === 'print' ? [u, (y1 - p[1]) / H] : [u, 0]);
  const cap = lathe([[2.4, 22.55], [2.78, 22.6], [2.84, 22.9], [2.84, 26.2], [2.74, 26.75], [2.45, 27.0], [1.2, 27.08], [0, 27.08]], 48);
  M.add(cap, 'tapa');
  const loop = [];
  for (let k = 0; k <= 16; k++) { const a = lerp(0.18, PI - 0.18, k / 16); loop.push([1.55 * Math.cos(a), 26.85 + 1.75 * Math.sin(a), 0]); }
  M.add(sweep(loop, ellipse(0.42, 0.32, 10), { up: () => [0, 0, 1] }), 'tapa');
  return {
    M, lienzo: [circ, H],
    info: { lados: { frente: { mat: 'print', cx: circ / 2, cy: H / 2, vista: 22 } } },
  };
}

/* ---------- tote bag ---------- */
function tote() {
  const M = new Model('tote');
  const W = 38, H = 42, D = 2.3;
  const sx = x => Math.sqrt(Math.max(0, 1 - Math.abs(x / (W / 2)) ** 6));
  const sy = y => y < H / 2 ? Math.sqrt(Math.max(0, 1 - Math.abs((H / 2 - y) / (H / 2)) ** 6)) : 0.42 + 0.58 * (1 - ((y - H / 2) / (H / 2)) ** 4);
  const zf = (x, y) => D * sx(x) * sy(y) + 0.18 * noise2(x * 0.12, y * 0.1) * sx(x) * Math.min(1, y / 4);
  const panel = (s) => {
    const S = surface(30, 34, (u, v) => { const x = lerp(-W / 2, W / 2, u), y = lerp(H, 0, v); return [x, y, s * zf(x, y)]; });
    return orient(S, p => [p[0], p[1], p[2] - s]);
  };
  const planar = (m, p) => m === 'print_espalda' ? [(W / 2 - p[0]) / W, (H - p[1]) / H] : [(p[0] + W / 2) / W, (H - p[1]) / H];
  M.add(panel(1), 'print_frente', planar);
  M.add(panel(-1), 'print_espalda', planar);
  const seam = [];
  for (let k = 0; k <= 14; k++) seam.push([-W / 2, lerp(H, 0, k / 14), 0]);
  for (let k = 1; k <= 14; k++) seam.push([lerp(-W / 2, W / 2, k / 14), 0, 0]);
  for (let k = 1; k <= 14; k++) seam.push([W / 2, lerp(0, H, k / 14), 0]);
  M.add(sweep(seam, circle(0.28, 6), { up: () => [0, 0, 1] }), 'tela');
  for (const s of [1, -1]) {
    const hem = []; for (let k = 0; k <= 30; k++) { const x = lerp(-W / 2, W / 2, k / 30); hem.push([x, H, s * zf(x, H)]); }
    M.add(sweep(hem, circle(0.38, 6), { up: () => [0, 1, 0] }), 'tela');
    // Asa: arco plano que nace adentro del ruedo
    const arc = [];
    for (let k = 0; k <= 26; k++) {
      const a = lerp(PI + 0.06, -0.06, k / 26), x = 8.2 * Math.cos(a), y = H - 1.2 + 24 * Math.sin(a);
      arc.push([x, y, s * (zf(x, Math.min(H, y)) + 0.35 + 1.4 * Math.max(0, Math.sin(a)))]);
    }
    M.add(sweep(arc, [[-1.3, -0.12], [1.3, -0.12], [1.3, 0.12], [-1.3, 0.12]], { up: () => [0, 0, s] }), 'tela');
  }
  return {
    M, lienzo: [W, H],
    info: {
      lados: {
        frente: { mat: 'print_frente', cx: W / 2, cy: H * 0.47, vista: 0 },
        espalda: { mat: 'print_espalda', cx: W / 2, cy: H * 0.47, vista: 180 },
      },
    },
  };
}

/* ---------- escritura del GLB ---------- */
const MATS = {
  print_frente: { color: [1, 1, 1], rough: 0.92, double: true },
  print_espalda: { color: [1, 1, 1], rough: 0.92, double: true },
  print: { color: [1, 1, 1], rough: 0.3, double: false },
  tela: { color: [0.9, 0.9, 0.9], rough: 0.92, double: true },
  rib: { color: [0.85, 0.85, 0.85], rough: 0.95, double: true },
  ceramica: { color: [0.95, 0.95, 0.95], rough: 0.25, double: false },
  metal: { color: [0.9, 0.9, 0.9], rough: 0.45, double: false },
  tapa: { color: [0.13, 0.13, 0.13], rough: 0.4, double: false },
  puntera: { color: [0.75, 0.75, 0.75], rough: 0.35, double: false },
};
// Se guarda comprimido con KHR_mesh_quantization (lo lee three.js): posiciones en enteros de 16 bits
// (el nodo las devuelve a metros con una escala y un centro), normales en 8 bits y UV en 16 bits.
function writeGLB(file, { M, lienzo, info }) {
  const prims = [...M.prims.values()].filter(p => p.idx.length);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const pr of prims) for (let i = 0; i < pr.pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pr.pos[i + k] / 100); hi[k] = Math.max(hi[k], pr.pos[i + k] / 100); }
  const ctr = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2), half = Math.max(...[0, 1, 2].map(k => (hi[k] - lo[k]) / 2)) * 1.0001;
  const json = {
    asset: { version: '2.0', generator: 'Tramaluz · mockups/generar.mjs' },
    extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0, scenes: [{ name: M.name, nodes: [0], extras: { tramaluz: info } }],
    nodes: [{ name: M.name, mesh: 0, translation: ctr, scale: [half, half, half] }], meshes: [{ name: M.name, primitives: [] }],
    materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }],
  };
  const parts = []; let off = 0;
  const view = (typed, target, byteStride) => {
    const b = Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length, target, ...(byteStride ? { byteStride } : {}) });
    parts.push(b); off += b.length;
    const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; }
    return json.bufferViews.length - 1;
  };
  const acc = (typed, type, componentType, count, target, extra = {}, byteStride = 0) => {
    json.accessors.push({ bufferView: view(typed, target, byteStride), componentType, count, type, ...extra });
    return json.accessors.length - 1;
  };
  for (const pr of prims) {
    const nv = pr.pos.length / 3;
    const pos = new Int16Array(nv * 4), nrm = new Int8Array(nv * 4), uv = new Uint16Array(nv * 2);
    const mn = [32767, 32767, 32767], mx = [-32767, -32767, -32767];
    for (let i = 0; i < nv; i++) {
      for (let k = 0; k < 3; k++) {
        const q = Math.round((pr.pos[i * 3 + k] / 100 - ctr[k]) / half * 32767); pos[i * 4 + k] = q; mn[k] = Math.min(mn[k], q); mx[k] = Math.max(mx[k], q);
        nrm[i * 4 + k] = Math.round(clamp(pr.nrm[i * 3 + k], -1, 1) * 127);
      }
      for (let k = 0; k < 2; k++) uv[i * 2 + k] = Math.round(clamp(pr.uv[i * 2 + k], 0, 1) * 65535);
    }
    const attributes = {
      POSITION: acc(pos, 'VEC3', 5122, nv, 34962, { normalized: true, min: mn, max: mx }, 8),
      NORMAL: acc(nrm, 'VEC3', 5120, nv, 34962, { normalized: true }, 4),
      TEXCOORD_0: acc(uv, 'VEC2', 5123, nv, 34962, { normalized: true }),
    };
    if (pr.col) { // sombra en 8 bits (gris: el mismo valor en R, G y B)
      const col = new Uint8Array(nv * 4);
      for (let i = 0; i < nv; i++) col.fill(Math.round(clamp(pr.col[i], 0, 1) * 255), i * 4, i * 4 + 3);
      attributes.COLOR_0 = acc(col, 'VEC3', 5121, nv, 34962, { normalized: true }, 4);
    }
    const indices = acc(nv < 65536 ? new Uint16Array(pr.idx) : new Uint32Array(pr.idx), 'SCALAR', nv < 65536 ? 5123 : 5125, pr.idx.length, 34963);
    const md = MATS[pr.mat];
    const mat = { name: pr.mat, pbrMetallicRoughness: { baseColorFactor: [...md.color, 1], metallicFactor: 0, roughnessFactor: md.rough }, doubleSided: md.double };
    if (pr.mat.startsWith('print')) mat.extras = { lienzo };
    json.materials.push(mat);
    json.meshes[0].primitives.push({ attributes, indices, material: json.materials.length - 1 });
  }
  const bin = Buffer.concat(parts); json.buffers[0].byteLength = bin.length;
  let js = Buffer.from(JSON.stringify(json)); const jpad = (4 - (js.length % 4)) % 4; if (jpad) js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
  const total = 12 + 8 + js.length + 8 + bin.length;
  const h = Buffer.alloc(12); h.writeUInt32LE(0x46546C67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(total, 8);
  const cj = Buffer.alloc(8); cj.writeUInt32LE(js.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
  const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
  writeFileSync(file, Buffer.concat([h, cj, js, cb, bin]));
  let verts = 0, tris = 0; for (const pr of M.prims.values()) { verts += pr.pos.length / 3; tris += pr.idx.length / 3; }
  console.log(`${M.name}.glb  ${(total / 1024).toFixed(0)} KB  ·  ${verts} vértices  ·  ${tris} triángulos`);
}

for (const make of [camiseta, buzo, taza, termo, tote]) {
  const r = make();
  writeGLB(join(DIR, r.M.name + '.glb'), r);
}
