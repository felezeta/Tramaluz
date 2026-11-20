// Genera los modelos 3D del mockup: GLB livianos, sin texturas ni programas de 3D.
// Uso:  node mockups/generar.mjs   → escribe camiseta.glb, buzo.glb, taza.glb, termo.glb y tote.glb aquí.
//
// Todo se arma con matemática para que pesen poco y carguen rápido en celulares y equipos sin tarjeta de video.
// Se modela en cm y se guarda en metros (lo que pide glTF). Y apunta arriba y Z hacia el frente.
//
// Lo que Tramaluz lee de cada GLB:
//  - Materiales por nombre: print_frente, print_espalda y print (donde va el diseño), tela, rib, ceramica y
//    metal (toman el color elegido), tapa y puntera (color fijo).
//  - extras.lienzo de cada material de impresión: [ancho, alto] en cm del área que cubren sus UV (0..1).
//  - extras.tramaluz de la escena: dónde va el diseño en cada ubicación, en cm dentro del lienzo
//    (cx = centro horizontal; top = borde de arriba, o cy = centro vertical) y desde qué ángulo mirarlo (vista).
import { writeFileSync } from 'node:fs';
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
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const bez = (p0, p1, p2, p3, t) => { const s = 1 - t; return add(add(mul(p0, s * s * s), mul(p1, 3 * s * s * t)), add(mul(p2, 3 * s * t * t), mul(p3, t * t * t))); };

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
function stadium(w, h, n = 5) { // rectángulo de puntas redondas: ancho 2w, alto h (de 0 a h)
  const out = [];
  for (let i = 0; i <= n; i++) { const a = -PI / 2 + PI * i / n; out.push([w * Math.cos(a), (h - w) + w * Math.sin(a)]); }
  for (let i = 0; i <= n; i++) { const a = PI / 2 + PI * i / n; out.push([w * Math.cos(a), w + w * Math.sin(a)]); }
  return out.reverse();
}
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
function garment(o) {
  const M = new Model(o.name);
  const n = 2.6; // sección del cuerpo: superelipse (frente plano, costados redondos)
  const sgnPow = (v, e) => Math.sign(v) * Math.abs(v) ** e;
  const ex = th => sgnPow(Math.sin(th), 2 / n), ez = th => sgnPow(Math.cos(th), 2 / n);
  const c2 = th => Math.cos(th) ** 2;
  const byFace = (th, front, back, side) => c2(th) * (Math.cos(th) > 0 ? front : back) + (1 - c2(th)) * side;
  const yTop = th => byFace(th, o.neckFront, o.neckBack, o.hps);           // escote
  const drop = th => byFace(th, o.dropFront, o.dropBack, o.dropSide);      // caída del hombro
  const steep = th => byFace(th, 1.0, 0.55, 0.33);                         // qué tan parado sale del escote
  const A = y => o.A(y), B = y => o.B(y);
  // Arrugas: pliegues verticales abajo y un poco de ruido; casi nada en la zona de impresión del pecho
  const fold = (th, y) => {
    const front = Math.max(0, Math.cos(th)), chest = front ** 2 * smooth(o.hem + 12, o.hem + 26, y);
    const hang = (1 - smooth(o.hem, o.hem + 34, y)) * 0.55 * Math.sin(th * 9 + 0.6) * (0.5 + 0.5 * noise2(th * 3, 1.3));
    const n2 = 0.25 * noise2(th * 4.1 + 7, y * 0.09);
    return (hang + n2) * (1 - 0.85 * chest);
  };
  const bodyPt = (th, y) => {
    const d = fold(th, y), r = norm([ex(th), 0, ez(th) * B(y) / A(y)]);
    return add([A(y) * ex(th), y, B(y) * ez(th)], mul(r, d));
  };
  const neckPt = th => [o.neckA * Math.sin(th), yTop(th), o.neckB * Math.cos(th)];
  const capPt = (th, s) => {
    const N = neckPt(th), dp = drop(th), y1 = yTop(th) - dp, Bt = bodyPt(th, y1);
    const dr = Math.hypot(Bt[0] - N[0], Bt[2] - N[2]);
    // hombro casi recto desde el cuello y luego una curva corta hacia abajo (la tapa la manga)
    const ta = Math.tan(steep(th));
    const p1 = [0.6 * dr, Math.min(0.6 * dr * ta, 0.6 * dp)], p2 = [dr, clamp(dr * ta, 0.15 * dp, 0.8 * dp)], p3 = [dr, dp];
    const b = k => 3 * (1 - s) ** 2 * s * p1[k] + 3 * (1 - s) * s * s * p2[k] + s ** 3 * p3[k];
    const r = dr > 1e-6 ? b(0) / dr : 0;
    return [N[0] + (Bt[0] - N[0]) * r, yTop(th) - b(1), N[2] + (Bt[2] - N[2]) * r];
  };
  const NU = 128, NC = 16, NB = 64, vc = NC / (NC + NB); // divisiones: alrededor (múltiplo de 4), hombro y cuerpo
  const theta = u => -PI + 2 * PI * u;
  const torso = surface(NU, NC + NB, (u, v) => {
    const th = theta(u);
    if (v <= vc + 1e-9) return capPt(th, v / vc);
    const w = (v - vc) / (1 - vc), y1 = yTop(th) - drop(th);
    // filas más juntas cerca del ruedo y del resorte
    return bodyPt(th, lerp(y1, o.hem, w ** 1.08));
  }, { wrapU: true });
  orient(torso, (p) => [0, p[1], 0]);
  const C = o.canvas; // lienzo de impresión: ancho, alto y altura (y) de su borde de arriba
  const planar = (m, p) => m === 'print_espalda' ? [(C.w / 2 - p[0]) / C.w, (C.top - p[1]) / C.h] : [(p[0] + C.w / 2) / C.w, (C.top - p[1]) / C.h];
  M.add(torso, (i, j) => {
    const p = torso.P[torso.at(i, j + 1)];
    if (o.ribTop && p[1] < o.ribTop - 0.01) return 'rib';
    return i >= NU / 4 && i < 3 * NU / 4 ? 'print_frente' : 'print_espalda';
  }, planar);

  // Cuello: banda de resorte sobre el escote
  const neckPath = Array.from({ length: NU }, (_, i) => neckPt(theta(i / NU)));
  const cen = [0, 0, 0];
  M.add(sweep(neckPath, stadium(o.collar[0], o.collar[1]).map(([a, b]) => [a, b - 0.35]), {
    closed: true, up: (i, p, T) => { const r = norm([p[0], 0, p[2]]); return norm(add([0, 1, 0], mul(r, -0.18))); },
  }), 'rib');

  // Ruedo de abajo
  const hemPath = Array.from({ length: NU }, (_, i) => { const th = theta(i / NU); return bodyPt(th, o.hem); });
  M.add(sweep(hemPath, circle(o.ribTop ? 0.5 : 0.32, 10), { closed: true, up: (i, p) => sub(p, [0, p[1], 0]) }), o.ribTop ? 'rib' : 'tela');

  // Mangas
  for (const sx of [1, -1]) {
    const R = o.sleeve(sx);
    const S = surface(R.nu, R.nv, (u, v) => {
      const r = R.ring(v), a = 2 * PI * u;
      return add(r.c, add(mul(r.up, r.r1 * Math.cos(a)), mul(r.side, r.r2 * Math.sin(a))));
    }, { wrapU: true });
    orient(S, (p, i, j) => R.ring(j / R.nv).c);
    M.add(S, (i, j) => (R.cuff && (j + 0.5) / R.nv > R.cuff) ? 'rib' : 'tela');
    const e = R.ring(1);
    const hem = Array.from({ length: 48 }, (_, i) => { const a = 2 * PI * i / 48; return add(e.c, add(mul(e.up, e.r1 * Math.cos(a)), mul(e.side, e.r2 * Math.sin(a)))); });
    M.add(sweep(hem, circle(R.cuff ? 0.45 : 0.3, 6), { closed: true, up: (i, p) => sub(p, e.c) }), R.cuff ? 'rib' : 'tela');
  }

  if (o.extra) o.extra(M, { bodyPt, neckPt, planar, ex, ez, A, B, n });
  return M;
}

// Punto del frente del cuerpo a cierta x (para bolsillo y cordones)
function frontAt(G, x, y) {
  const s = clamp(Math.abs(x) / G.A(y), 0, 0.999), th = Math.sign(x) * Math.asin(s ** (G.n / 2));
  return { th, p: G.bodyPt(th, y) };
}

function camiseta() {
  const o = {
    name: 'camiseta', hps: 74, hem: 0, ribTop: 0,
    neckFront: 66.3, neckBack: 72.2, neckA: 8.4, neckB: 7.2,
    dropFront: 6, dropBack: 8.5, dropSide: 11,
    A: y => 25.4 - 0.8 * smooth(14, 30, y) * (1 - smooth(30, 46, y)) + 0.3 * (1 - smooth(0, 12, y)),
    B: y => 11.6 + 0.9 * smooth(30, 52, y) - 0.3 * smooth(52, 64, y) + 0.3 * (1 - smooth(0, 14, y)),
    collar: [0.45, 2.1],
    canvas: { w: 60, h: 80, top: 76 },
    sleeve: sx => {
      const C0 = [sx * 20.5, 57.5, 0], top1 = [sx * 41.5, 54.6, 0], d = norm([sx * 0.82, -0.57, 0]), u1 = [sx * 0.57, 0.82, 0];
      const C1 = sub(top1, mul(u1, 7.4));
      return {
        nu: 48, nv: 20,
        ring: t => ({ c: lerp3(C0, C1, t), up: norm(lerp3([0, 1, 0], u1, t)), side: [0, 0, 1], r1: lerp(9.6, 7.4, t) + 0.5 * Math.sin(PI * t), r2: lerp(6.2, 5.4, t) + 0.6 * Math.sin(PI * t) }),
      };
    },
  };
  const M = garment(o);
  return {
    M, lienzo: [o.canvas.w, o.canvas.h],
    info: {
      lados: {
        frente: { mat: 'print_frente', cx: 30, top: o.canvas.top - (o.neckFront - 8), vista: 0 },
        espalda: { mat: 'print_espalda', cx: 30, top: o.canvas.top - (o.neckBack - 8), vista: 180 },
        pecho: { mat: 'print_frente', cx: 30 + 10.5, top: o.canvas.top - (o.neckFront - 4.5), vista: 0 },
      },
    },
  };
}

function buzo() {
  const o = {
    name: 'buzo', hps: 71, hem: 0, ribTop: 6.5,
    neckFront: 63, neckBack: 70, neckA: 9.6, neckB: 8.2,
    dropFront: 6.5, dropBack: 8.5, dropSide: 11,
    A: y => 28.2 - 1.6 * (1 - smooth(4, 9, y)) + 0.4 * smooth(9, 14, y) * (1 - smooth(14, 26, y)),
    B: y => 13.3 + 0.9 * smooth(30, 50, y) - 0.4 * smooth(50, 62, y) - 0.8 * (1 - smooth(4, 9, y)),
    collar: [0.45, 1.6],
    canvas: { w: 66, h: 84, top: 76 },
    sleeve: sx => {
      // manga larga: baja casi recta con un leve codo, y puño de resorte
      const C0 = [sx * 22.6, 55.5, 0], P1 = [sx * 33, 48, 0], P2 = [sx * 37.5, 28, 0], C1 = [sx * 38.5, 8.5, 0];
      const cuff = 0.86;
      const ring = t => {
        const c = bez(C0, P1, P2, C1, t), T = norm(sub(bez(C0, P1, P2, C1, Math.min(1, t + 0.01)), bez(C0, P1, P2, C1, Math.max(0, t - 0.01))));
        const perp = norm([-T[1] * sx, T[0] * sx, 0]);
        const upv = norm(lerp3([0, 1, 0], [perp[0] * sx < 0 ? -perp[0] : perp[0], Math.abs(perp[1]), 0], smooth(0, 0.3, t)));
        const up = [sx * Math.abs(upv[0]), upv[1], 0];
        let r1 = lerp(11.2, 7.6, smooth(0, 0.8, t)) + 0.8 * Math.sin(PI * Math.min(1, t / cuff)), r2 = lerp(7.2, 6.0, smooth(0, 0.8, t)) + 0.6 * Math.sin(PI * Math.min(1, t / cuff));
        if (t > cuff - 0.03) { const k = smooth(cuff - 0.03, cuff + 0.01, t); r1 = lerp(r1, 5.4, k); r2 = lerp(r2, 4.6, k); }
        return { c, up, side: [0, 0, 1], r1, r2 };
      };
      return { nu: 44, nv: 40, ring, cuff };
    },
  };
  let hoodInfo;
  o.extra = (M, G) => {
    // Capucha (puesta): elipsoide con la abertura de la cara al frente; lo de abajo queda escondido dentro del cuerpo
    const Ch = [0, 77.8, -4.0], R = [12.9, 17.6, 15.0], a0 = 0.98;
    const hoodPt = (al, be) => add(Ch, [R[0] * Math.sin(al) * Math.sin(be), R[1] * Math.sin(al) * Math.cos(be), R[2] * Math.cos(al)]);
    // se va hacia atrás arriba (punta suave) y cae sobre la espalda
    const lean = p => {
      const t = clamp((p[1] - 66) / 30, 0, 1), back = clamp((Ch[2] - p[2]) / R[2], 0, 1), low = clamp((Ch[1] - p[1]) / R[1], 0, 1);
      return [p[0] * (1 + 0.06 * back * low), p[1] - 2.5 * back * low * low, p[2] - 3.2 * t * t * (0.4 + 0.6 * back)];
    };
    const hood = surface(72, 30, (u, v) => lean(hoodPt(a0 + (PI - a0) * v, 2 * PI * u)), { wrapU: true });
    orient(hood, () => Ch);
    M.add(hood, 'tela');
    const rim = Array.from({ length: 80 }, (_, i) => lean(hoodPt(a0, 2 * PI * i / 80)));
    M.add(sweep(rim, circle(0.75, 8), { closed: true, up: (i, p) => sub(p, add(Ch, [0, 0, R[2] * Math.cos(a0)])) }), 'tela');
    // Cordones: salen del borde de la capucha y caen sobre el pecho
    for (const sx of [1, -1]) {
      const be = PI - sx * 0.62, top = lean(hoodPt(a0, be));
      const pts = [top];
      const x0 = top[0] + sx * 0.4;
      for (const y of [top[1] - 3, 58, 54, 50, 46, 42.5]) {
        const f = frontAt(G, x0 + sx * (60 - y) * 0.015, y), nrm = norm([G.ex(f.th) * 0.3, 0, 1]);
        pts.push(add(f.p, mul(nrm, 0.7 + Math.max(0, y - 58) * 0.4)));
      }
      const path = []; // Catmull-Rom suave
      for (let k = 0; k < pts.length - 1; k++) {
        const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(pts.length - 1, k + 2)];
        for (let s = 0; s < 6; s++) { const t = s / 6, t2 = t * t, t3 = t2 * t; path.push([0, 1, 2].map(c => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3))); }
      }
      path.push(pts[pts.length - 1]);
      M.add(sweep(path, circle(0.38, 6), { up: () => [1, 0, 0] }), 'rib');
      const end = path[path.length - 1], dir = norm(sub(end, path[path.length - 2]));
      M.add(sweep([sub(end, mul(dir, 0.6)), end, add(end, mul(dir, 2.4))], circle(0.5, 6), { up: () => [1, 0, 0] }), 'puntera');
    }
    // Bolsillo canguro: una capa sobre el frente, con la misma impresión (el diseño pasa por encima)
    const yb = 8.2, yt = 29, xr = y => y < 15 ? 18.5 : lerp(18.5, 13.2, (y - 15) / (yt - 15));
    const pocket = surface(48, 24, (u, v) => {
      const y = lerp(yt, yb, v), x = lerp(-xr(y), xr(y), u), f = frontAt(G, x, y);
      const nrm = norm([G.ex(f.th) * G.B(y) / G.A(y) * 0.6, 0, Math.max(0.2, G.ez(f.th))]);
      const edge = Math.min(1, Math.min(u, 1 - u) * 14, Math.min(v, 1 - v) * 10);
      return add(f.p, mul(nrm, 0.25 + 0.35 * edge));
    });
    orient(pocket, p => [p[0] * 0.8, p[1], 0]);
    M.add(pocket, 'print_frente', G.planar);
    const outline = [];
    for (let k = 0; k <= 12; k++) { const y = lerp(yb, yt, k / 12); outline.push([xr(y), y]); }
    for (let k = 1; k <= 12; k++) outline.push([lerp(xr(yt), -xr(yt), k / 12), yt]);
    for (let k = 1; k <= 12; k++) { const y = lerp(yt, yb, k / 12); outline.push([-xr(y), y]); }
    for (let k = 1; k < 12; k++) outline.push([lerp(-xr(yb), xr(yb), k / 12), yb]);
    const opath = outline.map(([x, y]) => { const f = frontAt(G, x, y); return add(f.p, [0, 0, 0.3]); });
    M.add(sweep(opath, circle(0.3, 6), { closed: true, up: () => [0, 0, 1] }), 'tela');
    hoodInfo = { back: 64 };
  };
  const M = garment(o);
  return {
    M, lienzo: [o.canvas.w, o.canvas.h],
    info: {
      lados: {
        frente: { mat: 'print_frente', cx: 33, top: o.canvas.top - (o.neckFront - 8), vista: 0 },
        espalda: { mat: 'print_espalda', cx: 33, top: o.canvas.top - (hoodInfo.back - 2), vista: 180 },
        pecho: { mat: 'print_frente', cx: 33 + 11, top: o.canvas.top - (o.neckFront - 5), vista: 0 },
      },
    },
  };
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
