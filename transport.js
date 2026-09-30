/*
 * transport.js — omschreven box en 3D-beeld voor stap 7 (transportafmetingen).
 * Alles in mm. Invoer in lokale coördinaten (lokale Z = omhoog).
 */
(function (root) {
  "use strict";

  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const unit = (a) => { const l = len(a); return l > 0 ? scl(a, 1 / l) : [0, 0, 0]; };

  /* ---------- Punten opschonen ---------- */
  function uniquePoints(pts, grid) {
    const g = grid || 0.5, seen = new Set(), out = [];
    for (const p of pts) {
      const k = Math.round(p[0] / g) + "," + Math.round(p[1] / g) + "," + Math.round(p[2] / g);
      if (!seen.has(k)) { seen.add(k); out.push(p); }
    }
    return out;
  }

  /* ---------- 2D convexe omhullende (monotone chain) ---------- */
  function hull2(P) {
    const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    lo.pop(); up.pop();
    return lo.concat(up);
  }

  // Kleinste rechthoek rond een convexe veelhoek (één zijde valt samen met een hullzijde).
  function minRect(H) {
    let best = { area: Infinity, ang: 0 };
    if (H.length < 3) return { area: 0, ang: 0 };
    for (let i = 0; i < H.length; i++) {
      const a = H[i], b = H[(i + 1) % H.length];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const q of H) {
        const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
      }
      const area = (u1 - u0) * (v1 - v0);
      if (area < best.area) best = { area, ang };
    }
    return best;
  }

  /* ---------- Boxen ---------- */
  function extentsIn(pts, axes) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const p of pts) for (let i = 0; i < 3; i++) {
      const v = dot(p, axes[i]); if (v < mn[i]) mn[i] = v; if (v > mx[i]) mx[i] = v;
    }
    return { min: mn, dims: [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]] };
  }

  // Box uitgelijnd op de lokale as: L = lokale X, B = lokale Y, H = lokale Z.
  function boxAligned(pts) {
    const axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const e = extentsIn(pts, axes);
    return { kind: "aligned", axes, min: e.min, dims: e.dims, tiltDeg: 0 };
  }

  function pcaAxes(pts) {
    const n = pts.length, c = [0, 0, 0];
    pts.forEach((p) => { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; });
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    pts.forEach((p) => { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; });
    // machtsmethode voor de grootste eigenvector, daarna de volgende in het loodrechte vlak
    const power = (M, ortho) => {
      let v = [1, 0.3, 0.1];
      for (let k = 0; k < 60; k++) {
        let w = [dot(M[0], v), dot(M[1], v), dot(M[2], v)];
        ortho.forEach((o) => { w = sub(w, scl(o, dot(w, o))); });
        const l = len(w); if (l < 1e-12) break; v = scl(w, 1 / l);
      }
      return v;
    };
    const a = power(C, []), b = power(C, [a]);
    return [a, b, unit(cross(a, b))];
  }

  // Kleinst mogelijke box: elke kandidaatrichting als hoogte, in het vlak erloodrecht de kleinste rechthoek.
  // Kandidaten: vlaknormalen van de platen (gewogen naar oppervlakte), hoofdassen (PCA) en de lokale assen.
  function boxMin(pts, normals, maxCand) {
    const cands = [], seen = new Set();
    const add = (n) => {
      let u = unit(n); if (len(u) < 0.5) return;
      if (u[2] < -1e-9 || (Math.abs(u[2]) <= 1e-9 && (u[1] < -1e-9 || (Math.abs(u[1]) <= 1e-9 && u[0] < 0)))) u = scl(u, -1);
      const k = u.map((v) => Math.round(v * 400)).join(",");
      if (!seen.has(k)) { seen.add(k); cands.push(u); }
    };
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach(add);
    pcaAxes(pts).forEach(add);
    (normals || []).slice(0, maxCand || 400).forEach(add);

    let best = null;
    for (const n of cands) {
      const a = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0])), b = cross(n, a);
      let h0 = Infinity, h1 = -Infinity; const P2 = new Array(pts.length);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], h = dot(p, n); if (h < h0) h0 = h; if (h > h1) h1 = h;
        P2[i] = [dot(p, a), dot(p, b)];
      }
      const r = minRect(hull2(P2)), vol = r.area * (h1 - h0);
      if (!best || vol < best.vol) {
        const c = Math.cos(r.ang), s = Math.sin(r.ang);
        best = { vol, axes: [n, unit([a[0] * c + b[0] * s, a[1] * c + b[1] * s, a[2] * c + b[2] * s]), unit([-a[0] * s + b[0] * c, -a[1] * s + b[1] * c, -a[2] * s + b[2] * c])] };
      }
    }
    // Hoogte = de boxas die het dichtst bij lokale Z ligt, naar boven gericht. Lengte = de langste van de andere twee.
    const ax = best.axes;
    const iH = [0, 1, 2].reduce((m, i) => (Math.abs(ax[i][2]) > Math.abs(ax[m][2]) ? i : m), 0);
    let eH = ax[iH][2] >= 0 ? ax[iH] : scl(ax[iH], -1);
    const rest = [0, 1, 2].filter((i) => i !== iH);
    const ext = (v) => { let lo = Infinity, hi = -Infinity; for (const p of pts) { const t = dot(p, v); if (t < lo) lo = t; if (t > hi) hi = t; } return hi - lo; };
    const iL = ext(ax[rest[0]]) >= ext(ax[rest[1]]) ? rest[0] : rest[1];
    let eL = ax[iL]; if (eL[0] < 0) eL = scl(eL, -1);
    const eB = unit(cross(eH, eL));
    const axes = [eL, eB, eH], e = extentsIn(pts, axes);
    return { kind: "min", axes, min: e.min, dims: e.dims, tiltDeg: Math.acos(Math.min(1, Math.abs(eH[2]))) * 180 / Math.PI };
  }

  // Oppervlaktegewogen, gesorteerde lijst van driehoeksnormalen (kandidaten voor boxMin).
  function weightedNormals(tris) {
    const acc = new Map();
    for (const t of tris) {
      const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(c); if (a < 1e-6) continue;
      let n = scl(c, 1 / a);
      if (n[2] < -1e-9 || (Math.abs(n[2]) <= 1e-9 && (n[1] < -1e-9 || (Math.abs(n[1]) <= 1e-9 && n[0] < 0)))) n = scl(n, -1);
      const k = n.map((v) => Math.round(v * 400)).join(",");
      const e = acc.get(k); if (e) e.a += a; else acc.set(k, { n, a });
    }
    return [...acc.values()].sort((x, y) => y.a - x.a).map((e) => e.n);
  }

  /* ---------- 3D-beeld ---------- */
  // Camera: van links-voor-boven, zodat de lengte (L) ongeveer horizontaal op het blad ligt.
  const CAM = unit([-0.24, -1, 0.62]);
  // Camera uit de richting naar de kijker (c) en een hulprichting voor "boven" (up).
  function camera(c, up) {
    const cc = unit(c || CAM), f = scl(cc, -1), r = unit(cross(f, up || [0, 0, 1])), u = cross(r, f);
    return { r, u, c: cc };
  }
  // Aanzichten in het frame van de box (x = L, y = B, z = H)
  const VIEWS = {
    iso1: { c: [-0.45, -1, 0.7], up: [0, 0, 1] },   // links-voor-boven
    iso2: { c: [0.45, -1, 0.7], up: [0, 0, 1] },    // rechts-voor-boven
    iso3: { c: [-0.45, 1, 0.7], up: [0, 0, 1] },    // links-achter-boven
    xy: { c: [0, 0, 1], up: [0, 1, 0], ortho: true },  // bovenaanzicht
    xz: { c: [0, -1, 0], up: [0, 0, 1], ortho: true }, // zijaanzicht (van voor)
    yz: { c: [-1, 0, 0], up: [0, 0, 1], ortho: true }  // kopaanzicht (van links)
  };
  const toFrame = (box, p) => [dot(p, box.axes[0]) - box.min[0], dot(p, box.axes[1]) - box.min[1], dot(p, box.axes[2]) - box.min[2]];
  function boxCorners(dims) {
    const out = [];
    for (let i = 0; i < 8; i++) out.push([i & 1 ? dims[0] : 0, i & 2 ? dims[1] : 0, i & 4 ? dims[2] : 0]);
    return out;
  }
  const BOX_EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

  // Projectie (frame-coördinaten → papier-mm) zodat de box in het kader past met marge voor maten.
  // view: {c, up}; k (papier-mm per model-mm) vast opgeven voor aanzichten op schaal, anders passend gemaakt.
  function projection(box, frame, margin, view, kFixed) {
    const cam = view ? camera(view.c, view.up) : camera(), C = boxCorners(box.dims);
    const P = C.map((p) => [dot(p, cam.r), dot(p, cam.u)]);
    const x0 = Math.min(...P.map((p) => p[0])), x1 = Math.max(...P.map((p) => p[0]));
    const y0 = Math.min(...P.map((p) => p[1])), y1 = Math.max(...P.map((p) => p[1]));
    const w = frame.x1 - frame.x0 - 2 * margin, h = frame.y1 - frame.y0 - 2 * margin;
    const k = kFixed || Math.min(w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1));
    const ox = frame.x0 + margin + (w - (x1 - x0) * k) / 2 - x0 * k;
    const oy = frame.y0 + margin + (h - (y1 - y0) * k) / 2 + y1 * k;
    const toPaper = (p) => [ox + dot(p, cam.r) * k, oy - dot(p, cam.u) * k];
    return { cam, k, toPaper, depth: (p) => dot(p, cam.c) };
  }

  // Rasteriseert de driehoeken (frame-coördinaten) met z-buffer en scherpe randen.
  // Geeft RGBA terug voor het kader `frame` (papier-mm) aan `ppm` pixels per mm.
  function render(trisF, proj, frame, ppm) {
    const W = Math.max(1, Math.round((frame.x1 - frame.x0) * ppm)), H = Math.max(1, Math.round((frame.y1 - frame.y0) * ppm));
    const rgba = new Uint8ClampedArray(W * H * 4), zb = new Float32Array(W * H).fill(-Infinity);
    const px = (p) => { const q = proj.toPaper(p); return [(q[0] - frame.x0) * ppm, (q[1] - frame.y0) * ppm, proj.depth(p)]; };
    const L = unit([-0.3, -0.6, 0.9]), base = [150, 166, 182];
    const eps = 4 / proj.k / ppm + 3; // mm diepte-tolerantie voor randen

    for (const t of trisF) {
      const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(c); if (a < 1e-9) continue;
      const n = scl(c, 1 / a), sh = 0.55 + 0.45 * Math.abs(dot(n, L));
      const col = base.map((v) => Math.min(255, Math.round(v * sh + 40 * (1 - sh))));
      const A = px(t[0]), B = px(t[1]), Cc = px(t[2]);
      const minx = Math.max(0, Math.floor(Math.min(A[0], B[0], Cc[0]))), maxx = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], Cc[0])));
      const miny = Math.max(0, Math.floor(Math.min(A[1], B[1], Cc[1]))), maxy = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], Cc[1])));
      const den = (B[1] - Cc[1]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[1] - Cc[1]);
      if (Math.abs(den) < 1e-12) continue;
      for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
        const xs = x + 0.5, ys = y + 0.5;
        const w0 = ((B[1] - Cc[1]) * (xs - Cc[0]) + (Cc[0] - B[0]) * (ys - Cc[1])) / den;
        const w1 = ((Cc[1] - A[1]) * (xs - Cc[0]) + (A[0] - Cc[0]) * (ys - Cc[1])) / den;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * A[2] + w1 * B[2] + w2 * Cc[2], i = y * W + x;
        if (z > zb[i]) { zb[i] = z; const j = i * 4; rgba[j] = col[0]; rgba[j + 1] = col[1]; rgba[j + 2] = col[2]; rgba[j + 3] = 255; }
      }
    }

    // Scherpe randen: randen van één driehoek, of met een knik > 25° tussen twee driehoeken.
    const key = (p) => Math.round(p[0] * 2) + "," + Math.round(p[1] * 2) + "," + Math.round(p[2] * 2);
    const edges = new Map();
    for (const t of trisF) {
      const c = cross(sub(t[1], t[0]), sub(t[2], t[0])), a = len(c); if (a < 1e-9) continue;
      const n = scl(c, 1 / a);
      for (let e = 0; e < 3; e++) {
        const p = t[e], q = t[(e + 1) % 3], kp = key(p), kq = key(q);
        const k = kp < kq ? kp + "|" + kq : kq + "|" + kp;
        const rec = edges.get(k); if (rec) rec.n.push(n); else edges.set(k, { p, q, n: [n] });
      }
    }
    const COS = Math.cos(25 * Math.PI / 180);
    for (const e of edges.values()) {
      const sharp = e.n.length !== 2 || Math.abs(dot(e.n[0], e.n[1])) < COS;
      if (!sharp) continue;
      const A = px(e.p), B = px(e.q), steps = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) * 1.5));
      for (let s = 0; s <= steps; s++) {
        const f = s / steps, x = A[0] + (B[0] - A[0]) * f, y = A[1] + (B[1] - A[1]) * f, z = A[2] + (B[2] - A[2]) * f;
        for (let dy = -1; dy <= 0; dy++) for (let dx = -1; dx <= 0; dx++) {
          const xi = Math.round(x) + dx, yi = Math.round(y) + dy; if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
          const i = yi * W + xi; if (z < zb[i] - eps) continue;
          const j = i * 4; rgba[j] = 52; rgba[j + 1] = 62; rgba[j + 2] = 74; rgba[j + 3] = 255;
        }
      }
    }
    return { W, H, rgba };
  }

  // Kwadraat van de afstand van punt p tot driehoek abc (Ericson, Real-Time Collision Detection).
  function pointTriDist2(p, a, b, c) {
    const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
    const d1 = dot(ab, ap), d2 = dot(ac, ap); let q;
    if (d1 <= 0 && d2 <= 0) q = a;
    else {
      const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
      if (d3 >= 0 && d4 <= d3) q = b;
      else {
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]; }
        else {
          const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
          if (d6 >= 0 && d5 <= d6) q = c;
          else {
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); q = [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w]; }
            else {
              const va = d3 * d6 - d5 * d4;
              if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w]; }
              else { const den = 1 / (va + vb + vc), v = vb * den, w = vc * den; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
            }
          }
        }
      }
    }
    const d = sub(p, q); return dot(d, d);
  }

  root.Transport = { uniquePoints, hull2, minRect, boxAligned, boxMin, weightedNormals, pcaAxes, camera, toFrame, boxCorners, BOX_EDGES, projection, render, VIEWS, pointTriDist2 };
})(typeof window !== "undefined" ? window : globalThis);
