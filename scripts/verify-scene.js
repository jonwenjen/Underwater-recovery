/*
 * Page-side test-scene generator for scripts/verify.mjs (injected with
 * addInitScript). Renders a colourful reef with known ground-truth colours,
 * then degrades it with the Jaffe–McGlamery image-formation model:
 *
 *   I_c = J_c · E_c · t_c + B_c · (1 − t_c),   t_c = exp(−β_c · d),  E_c = exp(−K_c · D)
 *
 * (J scene radiance, d object distance, D depth below surface, β attenuation,
 * K downwelling attenuation, B veiling light). Because J is known, the harness
 * can measure how close the app gets to the true colours.
 */
(() => {
  const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const toSrgb = (l) => {
    const v = Math.min(1, Math.max(0, l));
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  // deterministic PRNG
  const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

  const WATER = {
    blue: { beta: [0.4, 0.065, 0.035], K: [0.3, 0.05, 0.025], B: [0.015, 0.16, 0.3] },
    green: { beta: [0.35, 0.09, 0.16], K: [0.25, 0.06, 0.13], B: [0.02, 0.24, 0.12] },
  };

  /**
   * Ground truth at w×h. `pan` shifts the camera (scene units of width).
   * Returns sRGB J (0..1), distance d (m), and masks for scoring.
   */
  function truth(w, h, pan = 0, seed = 7) {
    const J = new Float32Array(w * h * 3);
    const d = new Float32Array(w * h);
    const object = new Uint8Array(w * h); // 1 = a real surface (not open water)
    const coral = new Uint8Array(w * h);
    const slate = new Uint8Array(w * h);
    const r = rng(seed);
    const corals = [];
    for (let i = 0; i < 26; i++) {
      const pal = [
        [0.86, 0.18, 0.16],
        [0.95, 0.48, 0.14],
        [0.62, 0.22, 0.66],
        [0.9, 0.3, 0.45],
      ][i % 4];
      corals.push({ u: r() * 1.6 - 0.1, v: 0.55 + r() * 0.42, rad: 0.025 + r() * 0.05, c: pal });
    }
    const fish = [];
    for (let i = 0; i < 14; i++)
      fish.push({ u: r() * 1.6 - 0.1, v: 0.2 + r() * 0.45, a: 0.03 + r() * 0.02, b: 0.012 + r() * 0.008, dist: 3 + r() * 5 });
    const aspect = w / h;
    for (let y = 0; y < h; y++) {
      const v = y / h;
      for (let x = 0; x < w; x++) {
        const u = x / w + pan;
        const i = y * w + x;
        const hz = 0.36 + 0.05 * Math.sin(u * 7) + 0.02 * Math.sin(u * 23);
        let c = null;
        let dist = 30;
        if (v >= hz) {
          const k = (v - hz) / (1 - hz);
          dist = 1.6 + 11 * Math.pow(1 - k, 1.6);
          const n = 0.06 * Math.sin(u * 180) * Math.cos(v * 150) + 0.04 * Math.sin(u * 47 + v * 31);
          c = [0.76 + n, 0.69 + n, 0.5 + n * 0.8];
          // rocks
          const rk = Math.sin(u * 9.3) * Math.cos(v * 11.1) + Math.sin(u * 17 + 1) * 0.5;
          if (rk > 0.95) c = [0.34 + n, 0.33 + n, 0.31 + n];
          object[i] = 1;
        }
        for (const cr of corals) {
          const du = (u - cr.u) * aspect,
            dv = v - cr.v;
          const rr = du * du + dv * dv;
          if (v >= hz && rr < cr.rad * cr.rad) {
            const tex = 0.08 * Math.sin(du * 400) * Math.sin(dv * 400);
            c = [cr.c[0] + tex, cr.c[1] + tex, cr.c[2] + tex];
            coral[i] = 1;
            object[i] = 1;
          }
        }
        for (const f of fish) {
          const du = (u - f.u) / f.a,
            dv = (v - f.v) / f.b;
          if (du * du + dv * dv < 1) {
            const stripe = Math.sin(du * 12) > 0.6 ? 0.15 : 0;
            c = [0.98 - stripe, 0.84 - stripe, 0.18];
            dist = f.dist;
            object[i] = 1;
            coral[i] = 0;
          }
        }
        // neutral white slate, bottom right (fixed to the frame, like a diver's slate)
        const su = x / w,
          sv = v;
        if (su > 0.8 && su < 0.93 && sv > 0.72 && sv < 0.9) {
          c = [0.88, 0.88, 0.88];
          dist = 1.8;
          object[i] = 1;
          slate[i] = 1;
          coral[i] = 0;
        }
        const q = i * 3;
        if (c) {
          J[q] = Math.min(1, Math.max(0, c[0]));
          J[q + 1] = Math.min(1, Math.max(0, c[1]));
          J[q + 2] = Math.min(1, Math.max(0, c[2]));
        }
        d[i] = dist;
      }
    }
    return { J, d, object, coral, slate, w, h };
  }

  /** Degrade a truth scene. Returns 8-bit sRGB RGBA. */
  function degrade(t, water = 'blue', depth = 8, seed = 3) {
    const { J, d, w, h } = t;
    const W = WATER[water];
    const E = W.K.map((k) => Math.exp(-k * depth));
    const n = w * h;
    const lin = new Float32Array(n * 3);
    let lsum = 0;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) {
        const tc = Math.exp(-W.beta[c] * d[i]);
        lin[i * 3 + c] = toLin(J[i * 3 + c]) * E[c] * tc + W.B[c] * (1 - tc);
      }
      lsum += 0.2126 * lin[i * 3] + 0.7152 * lin[i * 3 + 1] + 0.0722 * lin[i * 3 + 2];
    }
    // camera auto-exposure to a mid-grey average, as a real camera would
    const gain = 0.16 / (lsum / n);
    const r = rng(seed);
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const speck = r() < 0.0015 ? 0.25 : 0; // backscatter particles
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(toSrgb(lin[i * 3 + c] * gain + speck) * 255 + (r() - 0.5) * 3);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  /** Clean well-exposed rendition of the truth (the "no harm" control). */
  function clean(t) {
    const n = t.w * t.h;
    const out = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const open = !t.object[i];
      out[i * 4] = Math.round((open ? 0.55 : t.J[i * 3]) * 255);
      out[i * 4 + 1] = Math.round((open ? 0.7 : t.J[i * 3 + 1]) * 255);
      out[i * 4 + 2] = Math.round((open ? 0.85 : t.J[i * 3 + 2]) * 255);
      out[i * 4 + 3] = 255;
    }
    return out;
  }

  async function toFile(rgba, w, h, name) {
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return new File([blob], name, { type: 'image/png' });
  }

  /** Chromaticity error vs truth over object pixels (and optional mask). */
  function chromaError(px, pw, ph, t, maskName = 'object') {
    const mask = t[maskName];
    let err = 0,
      cnt = 0,
      rc = 0;
    for (let y = 0; y < ph; y++)
      for (let x = 0; x < pw; x++) {
        const tx = Math.min(t.w - 1, Math.floor(((x + 0.5) / pw) * t.w));
        const ty = Math.min(t.h - 1, Math.floor(((y + 0.5) / ph) * t.h));
        const ti = ty * t.w + tx;
        if (!mask[ti]) continue;
        const i = (y * pw + x) * 4;
        const s = px[i] + px[i + 1] + px[i + 2] + 1e-3;
        const q = ti * 3;
        const st = t.J[q] + t.J[q + 1] + t.J[q + 2] + 1e-3;
        for (let c = 0; c < 3; c++) err += Math.abs(px[i + c] / s - t.J[q + c] / st);
        rc += px[i] / s;
        cnt++;
      }
    return { err: err / Math.max(1, cnt), redChroma: rc / Math.max(1, cnt), n: cnt };
  }

  window.__scene = { truth, degrade, clean, toFile, chromaError, WATER };
})();
