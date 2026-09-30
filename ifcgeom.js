/*
 * ifcgeom.js — IFC-geometrie voor stap 4 (hoekpunten van geselecteerde platen).
 * Werkt met een web-ifc IfcAPI-instantie. Alle uitvoer in mm, IFC-assen (Z omhoog).
 */
(function (root) {
  "use strict";

  const CFG = {
    MERGE_MM: 0.05,     // hoekpunten binnen deze afstand worden samengevoegd
    NORMAL_SAME: 0.995, // normalen met cos > dit gelden als dezelfde richting
    CORNER_DET: 0.3     // min. |n1·(n2×n3)| voor een echt hoekpunt (filtert gatafrondingen)
  };

  /* ---------- IFC GUID ---------- */
  const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
  function guidToHex(g) {
    if (!g) return "";
    const s = String(g).trim();
    if (s.length !== 22) return s.replace(/[-{}]/g, "").toLowerCase(); // al 'uncompressed'
    const val = (str) => [...str].reduce((a, c) => a * 64 + B64.indexOf(c), 0);
    const bytes = [val(s.slice(0, 2))];
    for (let i = 2; i < 22; i += 4) {
      const v = val(s.slice(i, i + 4));
      bytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
    }
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- Model-index ---------- */
  function buildIndex(W, api, modelID) {
    const byGuid = new Map(), children = new Map(), info = new Map();
    const rels = api.GetLineIDsWithType(modelID, W.IFCRELAGGREGATES);
    for (let i = 0; i < rels.size(); i++) {
      const r = api.GetLine(modelID, rels.get(i));
      const p = r.RelatingObject && r.RelatingObject.value;
      const kids = (r.RelatedObjects || []).map((o) => o.value);
      if (p != null) children.set(p, (children.get(p) || []).concat(kids));
    }
    const ids = new Set(children.keys());
    api.StreamAllMeshes(modelID, (m) => ids.add(m.expressID));
    for (const id of ids) {
      try {
        const l = api.GetLine(modelID, id);
        if (l && l.GlobalId) {
          byGuid.set(guidToHex(l.GlobalId.value), id);
          info.set(id, { name: (l.Name && l.Name.value) || "", tag: (l.Tag && l.Tag.value) || "", type: l.constructor ? l.constructor.name : "" });
        }
      } catch (e) { /* overslaan */ }
    }
    return { byGuid, children, info };
  }

  function expandIds(index, ids) {
    const out = new Set(), stack = [...ids];
    while (stack.length) {
      const id = stack.pop(); if (out.has(id)) continue;
      out.add(id); (index.children.get(id) || []).forEach((k) => stack.push(k));
    }
    return [...out];
  }

  /* ---------- Geometrie ---------- */
  // web-ifc levert meter en Y-omhoog; terug naar IFC-assen in mm.
  const toIfcMm = (x, y, z) => [x * 1000, -z * 1000, y * 1000];

  function getTriangles(api, modelID, expressIDs) {
    const tris = [];
    api.StreamMeshes(modelID, expressIDs, (mesh) => {
      const gs = mesh.geometries;
      for (let i = 0; i < gs.size(); i++) {
        const pg = gs.get(i), T = pg.flatTransformation;
        const geo = api.GetGeometry(modelID, pg.geometryExpressID);
        const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
        const idx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
        const P = (k) => {
          const x = v[k * 6], y = v[k * 6 + 1], z = v[k * 6 + 2];
          return toIfcMm(T[0] * x + T[4] * y + T[8] * z + T[12], T[1] * x + T[5] * y + T[9] * z + T[13], T[2] * x + T[6] * y + T[10] * z + T[14]);
        };
        for (let t = 0; t < idx.length; t += 3) tris.push([P(idx[t]), P(idx[t + 1]), P(idx[t + 2])]);
        geo.delete();
      }
    });
    return tris;
  }

  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);

  // Echte hoekpunten: punten waar minstens drie duidelijk verschillende vlakken samenkomen.
  function cornerPoints(tris) {
    const q = CFG.MERGE_MM, map = new Map();
    for (const [a, b, c] of tris) {
      const n = cross(sub(b, a), sub(c, a)), l = len(n);
      if (l < 1e-9) continue;
      const nn = [n[0] / l, n[1] / l, n[2] / l];
      for (const p of [a, b, c]) {
        const key = p.map((v) => Math.round(v / q)).join(",");
        let e = map.get(key);
        if (!e) { e = { p, normals: [] }; map.set(key, e); }
        if (!e.normals.some((m) => dot(m, nn) > CFG.NORMAL_SAME)) e.normals.push(nn);
      }
    }
    const out = [];
    for (const e of map.values()) {
      const N = e.normals; if (N.length < 3) continue;
      let ok = false;
      for (let i = 0; i < N.length && !ok; i++)
        for (let j = i + 1; j < N.length && !ok; j++)
          for (let k = j + 1; k < N.length && !ok; k++)
            if (Math.abs(dot(N[i], cross(N[j], N[k]))) >= CFG.CORNER_DET) ok = true;
      if (ok) out.push(e.p);
    }
    return out;
  }


  /* ---------- Uiterste hoekpunten ---------- */
  // Eigenvectoren van een symmetrische 3x3-matrix (Jacobi). Geeft [{val, vec}] gesorteerd van groot naar klein.
  function eig3(A) {
    const a = A.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let it = 0; it < 50; it++) {
      let p = 0, q = 1;
      if (Math.abs(a[0][2]) > Math.abs(a[p][q])) { p = 0; q = 2; }
      if (Math.abs(a[1][2]) > Math.abs(a[p][q])) { p = 1; q = 2; }
      if (Math.abs(a[p][q]) < 1e-12) break;
      const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]), c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
    return [0, 1, 2].map((i) => ({ val: a[i][i], vec: [V[0][i], V[1][i], V[2][i]] })).sort((x, y) => y.val - x.val);
  }

  // Convexe omhullende in 2D (monotone chain), punten als {u, v, p}.
  function hull2d(P) {
    const pts = P.slice().sort((a, b) => a.u - b.u || a.v - b.v);
    if (pts.length < 3) return pts;
    const cr = (o, a, b) => (a.u - o.u) * (b.v - o.v) - (a.v - o.v) * (b.u - o.u);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // Verwijdert tussenpunten op (bijna) rechte randen: kleine knik of kleine afstand tot de lijn.
  function simplify(H, angDeg, distMm) {
    let pts = H.slice(), changed = true;
    const cosLim = Math.cos(angDeg * Math.PI / 180);
    while (changed && pts.length > 3) {
      changed = false;
      for (let i = 0; i < pts.length && pts.length > 3; i++) {
        const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
        const d1 = [b.u - a.u, b.v - a.v], d2 = [c.u - b.u, c.v - b.v];
        const l1 = Math.hypot(...d1), l2 = Math.hypot(...d2), lac = Math.hypot(c.u - a.u, c.v - a.v);
        const cosT = l1 && l2 ? (d1[0] * d2[0] + d1[1] * d2[1]) / (l1 * l2) : 1;
        const dist = lac ? Math.abs((c.u - a.u) * (a.v - b.v) - (a.u - b.u) * (c.v - a.v)) / lac : 0;
        if (cosT > cosLim || dist < distMm) { pts.splice(i, 1); changed = true; i--; }
      }
    }
    return pts;
  }

  /**
   * Uiterste hoekpunten van een plaatvormig object.
   * up: richting die als 'boven' geldt (lokale Z). mode: "top" of "both".
   */
  function outerCorners(tris, up, mode, opt) {
    const o = Object.assign({ ANG_DEG: 5, DIST_MM: 2, FACE_COS: 0.7 }, opt || {});
    // Vlaknormaal van de plaat via hoofdassen van alle hoekpunten
    const all = []; for (const t of tris) for (const p of t) all.push(p);
    const c = [0, 1, 2].map((i) => all.reduce((s, p) => s + p[i], 0) / all.length);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const p of all) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]; }
    const E = eig3(C);
    let n = E[2].vec; if (dot(n, up) < 0) n = n.map((v) => -v);
    const e1 = E[0].vec, e2 = cross(n, e1);

    const faceSet = (sign) => {
      const m = new Map();
      for (const [a, b, cc] of tris) {
        const nn = cross(sub(b, a), sub(cc, a)), l = len(nn); if (l < 1e-9) continue;
        if (sign * dot(nn, n) / l < o.FACE_COS) continue;
        for (const p of [a, b, cc]) m.set(p.map((v) => Math.round(v / CFG.MERGE_MM)).join(","), p);
      }
      return [...m.values()];
    };
    const cornersOf = (pts) => {
      if (pts.length < 3) return [];
      const P = pts.map((p) => { const d = sub(p, c); return { u: dot(d, e1), v: dot(d, e2), p }; });
      return simplify(hull2d(P), o.ANG_DEG, o.DIST_MM).map((q) => q.p);
    };
    let out = cornersOf(faceSet(1));
    if (mode === "both") out = out.concat(cornersOf(faceSet(-1)));
    if (!out.length) { // geen duidelijk boven-/ondervlak: omhullende van alle punten
      const m = new Map(); all.forEach((p) => m.set(p.map((v) => Math.round(v / CFG.MERGE_MM)).join(","), p));
      out = cornersOf([...m.values()]);
    }
    return out;
  }

  function aabb(tris) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (const t of tris) for (const p of t) for (let i = 0; i < 3; i++) { mn[i] = Math.min(mn[i], p[i]); mx[i] = Math.max(mx[i], p[i]); }
    return { min: mn, max: mx };
  }

  const IfcGeom = { eig3, CFG, guidToHex, buildIndex, expandIds, getTriangles, cornerPoints, outerCorners, hull2d, simplify, aabb };
  if (typeof module !== "undefined" && module.exports) module.exports = IfcGeom;
  else root.IfcGeom = IfcGeom;
})(typeof window !== "undefined" ? window : globalThis);
