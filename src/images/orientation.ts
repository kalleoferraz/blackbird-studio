/** Longest side `max`, aspect ratio kept. Returns the input size when it is not larger than `max`. */
export function fitLongest(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return {
    width: width >= height ? max : Math.max(1, Math.round(width * scale)),
    height: height > width ? max : Math.max(1, Math.round(height * scale)),
  };
}

/** Orientations 5..8 swap width and height when displayed. */
export function swapsAxes(orientation: number): boolean {
  return orientation >= 5 && orientation <= 8;
}

export interface Pixels {
  /** RGBA, 4 bytes per pixel. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Applies an EXIF orientation to an RGBA bitmap (stored orientation in, displayed orientation out).
 * Meant for small images (the already-reduced copy), where a per-pixel loop costs little.
 */
export function applyOrientation(src: Pixels, orientation: number): Pixels {
  if (orientation === 1 || orientation < 1 || orientation > 8) return src;
  const { width: w, height: h } = src;
  const dw = swapsAxes(orientation) ? h : w;
  const dh = swapsAxes(orientation) ? w : h;
  const from = new Uint32Array(src.data.buffer, src.data.byteOffset, w * h);
  const out = new Uint32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break; // mirror horizontal
        case 3: sx = w - 1 - x; sy = h - 1 - y; break; // rotate 180
        case 4: sx = x; sy = h - 1 - y; break; // mirror vertical
        case 5: sx = y; sy = x; break; // transpose
        case 6: sx = y; sy = h - 1 - x; break; // rotate 90 clockwise
        case 7: sx = w - 1 - y; sy = h - 1 - x; break; // transverse
        default: sx = w - 1 - y; sy = x; break; // 8: rotate 90 counter-clockwise
      }
      out[y * dw + x] = from[sy * w + sx] as number;
    }
  }
  return { data: new Uint8ClampedArray(out.buffer), width: dw, height: dh };
}
