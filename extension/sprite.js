// Pixel-art scythe sprite + slash animation, rendered procedurally so the same
// code drives the toolbar icon (ImageData) and the static PNG build script.
(function (root) {
  const PAL = {
    K: [22, 18, 34, 255],     // outline
    W: [255, 255, 255, 255],  // blade edge highlight
    B: [214, 226, 240, 255],  // blade
    b: [132, 150, 184, 255],  // blade shade
    H: [176, 112, 58, 255],   // handle
    h: [116, 68, 36, 255],    // handle shade
    G: [120, 255, 214, 255],  // slash trail
    g: [120, 255, 214, 130],  // slash trail (faded)
  };
  // 16x16 base sprite. Blade top-left, handle to bottom-left, so the
  // bottom-right corner stays clear for the queue-count badge.
  const BASE = [
    "................",
    "....WWWWWW......",
    "..WWBBBBBBBB..H.",
    ".WBBBBbbbbBBBHH.",
    ".WBBbb....bbHH..",
    ".WBb......HHh...",
    ".WBb.....HHh....",
    ".WB.....HHh.....",
    ".Wb....HHh......",
    "..W...HHh.......",
    "..b..HHh........",
    "....HHh.........",
    "...HHh..........",
    "..HHh...........",
    "..Hh............",
    "................",
  ];
  const N = 16;
  // Animation: [rotation in degrees (clockwise +), trail strength]
  const FRAMES = [
    [0, 0], [18, 0], [34, 0], [40, 0],          // wind up
    [10, 1], [-35, 2], [-75, 2], [-95, 1],      // slash
    [-80, 0], [-50, 0], [-22, 0], [-6, 0],      // recover
  ];
  const PIVOT = [7.5, 8.5];

  function baseAt(x, y) {
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    const c = BASE[y][x];
    return c === "." ? null : c;
  }

  // Returns a size x size RGBA Uint8ClampedArray for a given rotation.
  function render(size, deg, trail) {
    const out = new Uint8ClampedArray(size * size * 4);
    const fill = new Array(size * size).fill(null);
    const s = size / N;
    const rad = (-deg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + 0.5) / s - 0.5 - PIVOT[0];
        const y = (py + 0.5) / s - 0.5 - PIVOT[1];
        const sx = Math.round(x * cos - y * sin + PIVOT[0]);
        const sy = Math.round(x * sin + y * cos + PIVOT[1]);
        fill[py * size + px] = baseAt(sx, sy);
      }
    }
    // slash trail: arc swept by the blade tip, drawn behind the sprite
    if (trail) {
      const r0 = 6.2 * s, r1 = 7.6 * s;
      const a1 = ((deg + 320) * Math.PI) / 180;          // behind the heel of the blade
      const span = (trail === 2 ? 95 : 55) * Math.PI / 180;
      for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
          if (fill[py * size + px]) continue;
          const x = px + 0.5 - (PIVOT[0] + 0.5) * s, y = py + 0.5 - (PIVOT[1] + 0.5) * s;
          const r = Math.hypot(x, y);
          if (r < r0 || r > r1) continue;
          let d = Math.atan2(y, x) - a1;
          while (d < 0) d += Math.PI * 2;
          while (d >= Math.PI * 2) d -= Math.PI * 2;
          if (d < span) fill[py * size + px] = d < span * 0.6 ? "G" : "g";
        }
      }
    }
    // 1px dark outline around solid pixels
    const ow = Math.max(1, Math.round(s / 2));
    const solid = (x, y) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return false;
      const c = fill[y * size + x];
      return c && c !== "G" && c !== "g";
    };
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        let c = fill[py * size + px];
        if (!c || c === "g" || c === "G") {
          let near = false;
          for (let d = 1; d <= ow && !near; d++)
            near = solid(px - d, py) || solid(px + d, py) || solid(px, py - d) || solid(px, py + d);
          if (near) c = "K";
        }
        if (!c) continue;
        const rgba = PAL[c], o = (py * size + px) * 4;
        out[o] = rgba[0]; out[o + 1] = rgba[1]; out[o + 2] = rgba[2]; out[o + 3] = rgba[3];
      }
    }
    return out;
  }

  const api = {
    frameCount: FRAMES.length,
    idle: (size) => render(size, 0, 0),
    frame: (i, size) => { const f = FRAMES[i % FRAMES.length]; return render(size, f[0], f[1]); },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ScytheSprite = api;
})(typeof self !== "undefined" ? self : this);
