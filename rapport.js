/*
 * rapport.js — kleurenbeeld per klasse en het A3-rapport (jsPDF).
 */
(function (root) {
  "use strict";
  const T = root.Transport;
  const ZCOL = ["#2f6fb3", "#4aa3c7", "#2e8b6e", "#7bb86f", "#1f4e79", "#5c9e8c", "#9cc5e0", "#3d7ea6", "#6fa8a0", "#a9c97a", "#27628c", "#89b8d8", "#4c8f5a", "#b6d3a1", "#335f7a", "#7fb0c9"];
  const COL = { dwarsschot: "#e07a1f", langsschot: "#8a4fb8", overig: "#c4c9c5" };
  const colorOf = (u) => (u.huid && u.zicht ? ZCOL[(u.zicht.k - 1) % ZCOL.length] : COL[u.klasse] || COL.overig);
  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

  // isometrisch beeld, gekleurd per klasse. Geeft een PNG-data-URL.
  const VIEW_ONDER = { c: [-0.45, -1, -0.7], up: [0, 0, 1] };
  function raster(r, wMm, hMm, ppm, view) {
    const box = r.box, frame = { x0: 0, y0: 0, x1: wMm, y1: hMm }, proj = T.projection(box, frame, 4, view || T.VIEWS.iso1);
    const W = Math.round(wMm * ppm), H = Math.round(hMm * ppm), rgba = new Uint8ClampedArray(W * H * 4), zb = new Float32Array(W * H).fill(-Infinity);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255; }
    const Lt = [-0.3, -0.6, 0.9].map((v) => v / Math.hypot(0.3, 0.6, 0.9));
    const px = (p) => { const f = T.toFrame(box, p), q = proj.toPaper(f); return [q[0] * ppm, q[1] * ppm, proj.depth(f)]; };
    for (const u of r.U) {
      const base = hex(colorOf(u));
      for (const t of u.tris) {
        const A = px(t[0]), B = px(t[1]), C = px(t[2]);
        const c = cross(sub(T.toFrame(box, t[1]), T.toFrame(box, t[0])), sub(T.toFrame(box, t[2]), T.toFrame(box, t[0]))), l = Math.hypot(c[0], c[1], c[2]); if (l < 1e-9) continue;
        const sh = 0.55 + 0.45 * Math.abs(dot(c.map((v) => v / l), Lt)), col = base.map((v) => Math.round(v * sh + 255 * 0.1 * (1 - sh)));
        const minx = Math.max(0, Math.floor(Math.min(A[0], B[0], C[0]))), maxx = Math.min(W - 1, Math.ceil(Math.max(A[0], B[0], C[0])));
        const miny = Math.max(0, Math.floor(Math.min(A[1], B[1], C[1]))), maxy = Math.min(H - 1, Math.ceil(Math.max(A[1], B[1], C[1])));
        const den = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]); if (Math.abs(den) < 1e-12) continue;
        for (let y = miny; y <= maxy; y++) for (let x = minx; x <= maxx; x++) {
          const xs = x + 0.5, ys = y + 0.5, w0 = ((B[1] - C[1]) * (xs - C[0]) + (C[0] - B[0]) * (ys - C[1])) / den, w1 = ((C[1] - A[1]) * (xs - C[0]) + (A[0] - C[0]) * (ys - C[1])) / den, w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * A[2] + w1 * B[2] + w2 * C[2], i = y * W + x; if (z > zb[i]) { zb[i] = z; rgba[i * 4] = col[0]; rgba[i * 4 + 1] = col[1]; rgba[i * 4 + 2] = col[2]; }
        }
      }
    }
    return { W, H, rgba };
  }
  function image(r, wMm, hMm, ppm, view) {
    const { W, H, rgba } = raster(r, wMm, hMm, ppm, view);
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H; cv.getContext("2d").putImageData(new ImageData(rgba, W, H), 0, 0);
    return cv.toDataURL("image/png");
  }

  // A3 liggend: blad 1 overzicht (als er meer dan één deel is), daarna één blad per deel.
  function pdf(jsPDF, parts, meta, fmt) {
    const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a3" }), W = 420, Hh = 297, M = 12;
    const f0 = (v) => fmt(v, 0), f1 = (v) => fmt(v, 1);
    const head = (title, sub) => { doc.setFont("helvetica", "bold"); doc.setFontSize(16); doc.text(title, M, M + 6); doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(90); doc.text(sub, M, M + 12); doc.setTextColor(0); doc.setDrawColor(200); doc.line(M, M + 15, W - M, M + 15); };
    const table = (x, y, cols, rows, widths, fs) => { doc.setFontSize(fs || 9); doc.setFont("helvetica", "bold"); let cx = x; cols.forEach((c, i) => { doc.text(String(c), cx, y); cx += widths[i]; }); doc.setFont("helvetica", "normal"); y += 1.5; doc.setDrawColor(210); doc.line(x, y, x + widths.reduce((a, b) => a + b, 0), y); y += 4.2;
      rows.forEach((r) => { if (y > Hh - M - 4) return; let cx2 = x; r.forEach((c, i) => { const s = String(c == null ? "" : c); doc.text(doc.splitTextToSize(s, widths[i] - 2)[0] || "", cx2, y); cx2 += widths[i]; }); y += 4.4; }); return y; };
    const kv = (x, y, rows, w1, w2) => { doc.setFontSize(10); rows.forEach(([k, v]) => { doc.setTextColor(90); doc.text(k, x, y); doc.setTextColor(0); doc.setFont("helvetica", "bold"); doc.text(String(v), x + w1, y); doc.setFont("helvetica", "normal"); y += 5.6; }); return y; };
    const stamp = `${meta.title} · ${new Date().toLocaleDateString("nl-BE")} · regels v${meta.version}`;
    if (parts.length > 1 || meta.project) {
      head(`${meta.title} – overzicht`, stamp);
      const rows = parts.map((p) => [p.label, `${f0(p.dims[0])} × ${f0(p.dims[1])} × ${f0(p.dims[2])}`, f1(p.t), f1(p.A), fmt(p.V, 2), p.parts, p.M, p.Z, `${p.nDS} / ${p.T}`, p.L, p.R]);
      const s = meta.totals; rows.push(["Totaal", "", f1(s.t), f1(s.A), fmt(s.V, 2), s.parts, s.M, s.Z, `${s.nDS} / ${s.T}`, s.L, s.R]);
      let y = table(M, M + 26, ["Deel", "L × B × H (mm)", "Ton", "m²", "m³", "Onderdelen", "Mono (geschat)", "Zichten", "Schotten / types", "Langsschotten", "Samenstel (regels)"], rows, [70, 60, 22, 26, 22, 26, 30, 22, 34, 30, 34], 10);
      y += 8; y = kv(M, y, meta.predictLines, 90, 120);
      doc.setFontSize(8.5); doc.setTextColor(90); doc.splitTextToSize(meta.note, W - 2 * M).forEach((l) => { doc.text(l, M, y + 4); y += 4; }); doc.setTextColor(0);
    }
    parts.forEach((p, idx) => {
      if (idx > 0 || parts.length > 1 || meta.project) doc.addPage("a3", "landscape");
      head(`${p.label}`, `${p.source} · ${p.scopeText} · ${stamp}`);
      const imgW = 250, imgH = 150, h2 = imgH / 2 - 2;
      doc.addImage(root.Rapport.image(p.r, imgW, h2, 3), "PNG", M, M + 20, imgW, h2);
      doc.addImage(root.Rapport.image(p.r, imgW, h2, 3, VIEW_ONDER), "PNG", M, M + 24 + h2, imgW, h2);
      doc.setFontSize(8); doc.setTextColor(120); doc.text("van boven", M, M + 23); doc.text("van onder", M, M + 27 + h2); doc.setTextColor(0);
      // legende
      let ly = M + 20 + imgH + 6; doc.setFontSize(8.5); const leg = p.r.Z.map((z) => [ZCOL[(z.k - 1) % ZCOL.length], "Z" + z.k]).concat([[COL.dwarsschot, "dwarsschot"], [COL.langsschot, "langsschot"], [COL.overig, "overig"]]);
      let lx = M; leg.forEach(([c, t]) => { doc.setFillColor(...hex(c)); doc.rect(lx, ly - 3, 4, 4, "F"); doc.text(t, lx + 5.5, ly); lx += 8 + doc.getTextWidth(t) + 4; if (lx > M + imgW - 20) { lx = M; ly += 5.5; } });
      // kerncijfers
      const x2 = M + imgW + 12;
      let y = kv(x2, M + 26, [["Hoofdafmetingen (kleinste box)", `${f0(p.dims[0])} × ${f0(p.dims[1])} × ${f0(p.dims[2])} mm`], ["Nettogewicht", `${fmt(p.t * 1000, 0)} kg`], ["Netto oppervlakte", `${f1(p.A)} m²`], ["Volume (gewicht / 7850)", `${fmt(p.V, 3)} m³`],
        ["Onderdelen / gevormde platen", `${p.parts} / ${p.formed}`], ["Monotekeningen (geschat)", p.M], ["Zichten", `${p.Z}  (${p.orientText})`], ["Dwarsschotten / types", `${p.nDS} / ${p.T}`], ["Langsschotten", p.L], ["Samensteltekeningen (regels)", p.R],
        ["Samensteltekeningen (gekalibreerd)", p.Rk], ["Uren (schatting)", p.Uk]], 62, 70);
      // zichten en schotten
      y += 4; doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.text("Zichten", x2, y); doc.setFont("helvetica", "normal");
      y = table(x2, y + 5, ["#", "Stand", "Platen", "Naam in IFC"], p.r.Z.map((z) => ["Z" + z.k, z.orient, z.els.length, z.names]), [12, 24, 14, 90], 8.5);
      y += 3; doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.text("Dwarsschotten", x2, y); doc.setFont("helvetica", "normal");
      y = table(x2, y + 5, ["#", "Positie (mm)", "Type", "Platen", "Raakt"], p.r.DS.map((d) => ["S" + d.k, f0(d.s - p.r.DS[0].s), "T" + d.type, d.els.length, d.tz.map((k) => "Z" + k).join(" ")]), [12, 26, 14, 14, 74], 8.5);
      // waarschuwingen
      const warn = p.warn || []; if (warn.length) { let wy = Hh - M - 4 - warn.length * 4.5; doc.setFontSize(8.5); doc.setTextColor(160, 90, 0); warn.forEach((w) => { doc.text(doc.splitTextToSize("• " + w, W - 2 * M)[0], M, wy); wy += 4.5; }); doc.setTextColor(0); }
    });
    return doc.output("arraybuffer");
  }

  const Rapport = { VIEW_ONDER, raster, image, pdf, colorOf, ZCOL, COL };
  root.Rapport = Rapport;
})(typeof window !== "undefined" ? window : globalThis);
