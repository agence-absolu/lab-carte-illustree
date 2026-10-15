// Traitements raster partagés (grilles Float32Array, lignes du nord vers le sud).

/**
 * Bouche les trous d'une grille (push-pull) : moyenne des valeurs valides sur une
 * pyramide de résolutions, puis redescente. Les trous prennent une valeur qui
 * prolonge doucement leur pourtour, sans marche.
 */
export function inpaint(v: Float32Array, valid: Uint8Array, w: number, h: number): Float32Array {
  if (w <= 4 || h <= 4) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < v.length; i++) if (valid[i]) (sum += v[i]), n++;
    return new Float32Array(v.length).fill(n ? sum / n : 0);
  }
  const cw = Math.ceil(w / 2);
  const ch = Math.ceil(h / 2);
  const cv = new Float32Array(cw * ch);
  const cn = new Uint8Array(cw * ch);
  const acc = new Float32Array(cw * ch);
  const cnt = new Uint16Array(cw * ch);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!valid[j * w + i]) continue;
      const c = (j >> 1) * cw + (i >> 1);
      acc[c] += v[j * w + i];
      cnt[c]++;
    }
  }
  for (let c = 0; c < cv.length; c++) if (cnt[c]) (cv[c] = acc[c] / cnt[c]), (cn[c] = 1);
  const coarse = inpaint(cv, cn, cw, ch);
  const out = new Float32Array(v);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (valid[j * w + i]) continue;
      // Interpolation bilinéaire dans le niveau grossier
      const fx = Math.min(cw - 1.001, Math.max(0, (i - 0.5) / 2));
      const fy = Math.min(ch - 1.001, Math.max(0, (j - 0.5) / 2));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const dx = fx - x0;
      const dy = fy - y0;
      const x1 = Math.min(cw - 1, x0 + 1);
      const y1 = Math.min(ch - 1, y0 + 1);
      out[j * w + i] =
        (coarse[y0 * cw + x0] * (1 - dx) + coarse[y0 * cw + x1] * dx) * (1 - dy) +
        (coarse[y1 * cw + x0] * (1 - dx) + coarse[y1 * cw + x1] * dx) * dy;
    }
  }
  return out;
}

/** Distance (px, chanfrein 3-4) de chaque pixel au pixel valide le plus proche. */
export function distanceTo(valid: Uint8Array, w: number, h: number): Float32Array {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = valid[i] ? 0 : 1e9;
  const relax = (i: number, j: number, di: number, dj: number, cost: number) => {
    const ii = i + di;
    const jj = j + dj;
    if (ii < 0 || jj < 0 || ii >= w || jj >= h) return;
    const v = d[jj * w + ii] + cost;
    if (v < d[j * w + i]) d[j * w + i] = v;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      relax(i, j, -1, 0, 1);
      relax(i, j, 0, -1, 1);
      relax(i, j, -1, -1, 4 / 3);
      relax(i, j, 1, -1, 4 / 3);
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      relax(i, j, 1, 0, 1);
      relax(i, j, 0, 1, 1);
      relax(i, j, 1, 1, 4 / 3);
      relax(i, j, -1, 1, 4 / 3);
    }
  }
  return d;
}

/** Échantillonne une grille en (fi, fj) pixels fractionnaires (centre du pixel 0 = 0,5), bilinéaire. */
export function sampleBilinear(v: Float32Array, w: number, h: number, fi: number, fj: number): number {
  const x = Math.min(w - 1.001, Math.max(0, fi - 0.5));
  const y = Math.min(h - 1.001, Math.max(0, fj - 0.5));
  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  const dx = x - i0;
  const dy = y - j0;
  const a = v[j0 * w + i0] * (1 - dx) + v[j0 * w + i0 + 1] * dx;
  const b = v[(j0 + 1) * w + i0] * (1 - dx) + v[(j0 + 1) * w + i0 + 1] * dx;
  return a * (1 - dy) + b * dy;
}

/** Flou de boîte séparable (rayon r px), appliqué n fois ≈ flou gaussien. */
export function boxBlur(v: Float32Array, w: number, h: number, r: number, n = 3): Float32Array {
  let a = new Float32Array(v);
  let b = new Float32Array(v.length);
  for (let pass = 0; pass < n; pass++) {
    for (let j = 0; j < h; j++) {
      const row = j * w;
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += a[row + Math.min(w - 1, Math.max(0, i))];
      for (let i = 0; i < w; i++) {
        b[row + i] = sum / (2 * r + 1);
        sum += a[row + Math.min(w - 1, i + r + 1)] - a[row + Math.max(0, i - r)];
      }
    }
    for (let i = 0; i < w; i++) {
      let sum = 0;
      for (let j = -r; j <= r; j++) sum += b[Math.min(h - 1, Math.max(0, j)) * w + i];
      for (let j = 0; j < h; j++) {
        a[j * w + i] = sum / (2 * r + 1);
        sum += b[Math.min(h - 1, j + r + 1) * w + i] - b[Math.max(0, j - r) * w + i];
      }
    }
  }
  return a;
}
