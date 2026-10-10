// A minimal PNG decoder for 16-bit grayscale images. Orthanc's `/frames/{i}/image-int16`
// returns a 16-bit PNG (bit depth 16, color type 0), which is roughly 500× smaller than
// the `matlab` text endpoint for a 512×512 slice. The browser cannot window a canvas that
// has already been downconverted to 8 bits, so the pixels must cross as numbers — but
// they can cross as a compressed PNG rather than as text-shaped numbers.
//
// This decoder handles exactly one shape: 16-bit grayscale, single IDAT chunk (or
// concatenated IDAT chunks, which PNG permits). It is not a general PNG decoder.

import { inflateSync } from 'node:zlib';

export type DecodedPng16 = {
  width: number;
  height: number;
  /** Big-endian 16-bit values as stored in the PNG, before any byte-swap. */
  pixels: Uint16Array;
};

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Decode a 16-bit grayscale PNG. Returns null if the image is not that shape — a caller
 * that receives an 8-bit PNG or an RGB PNG gets a refusal rather than a misread.
 */
export function decodePng16(buf: Uint8Array): DecodedPng16 | null {
  if (buf.length < 8) return null;
  for (let i = 0; i < 8; i += 1) {
    if (buf[i] !== PNG_SIGNATURE[i]) return null;
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idatChunks: Uint8Array[] = [];

  while (offset < buf.length) {
    if (offset + 8 > buf.length) return null;
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    const length = view.getUint32(0, false);
    const type = String.fromCharCode(buf[offset + 4]!, buf[offset + 5]!, buf[offset + 6]!, buf[offset + 7]!);
    offset += 8;

    if (offset + length > buf.length) return null;
    const data = buf.subarray(offset, offset + length);

    if (type === 'IHDR') {
      if (length < 13) return null;
      const ihdr = new DataView(data.buffer, data.byteOffset, 13);
      width = ihdr.getUint32(0, false);
      height = ihdr.getUint32(4, false);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset += length + 4;
  }

  if (bitDepth !== 16 || colorType !== 0) return null;
  if (width === 0 || height === 0) return null;
  if (idatChunks.length === 0) return null;

  // Concatenate IDAT chunks: PNG permits splitting the compressed stream across multiple
  // chunks, and Orthanc has been seen to do so for larger frames.
  let totalIdatLen = 0;
  for (const c of idatChunks) totalIdatLen += c.length;
  const idat = new Uint8Array(totalIdatLen);
  let idatOff = 0;
  for (const c of idatChunks) {
    idat.set(c, idatOff);
    idatOff += c.length;
  }

  // The zlib stream in IDAT has a 2-byte header and a 4-byte Adler-32 trailer. Node's
  // inflateSync expects the raw deflate stream or the zlib wrapper; it handles the wrapper.
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(idat);
  } catch {
    return null;
  }

  // Each scanline: 1 filter byte + width * 2 bytes (16-bit grayscale = 2 bytes/pixel).
  const stride = 1 + width * 2;
  if (inflated.length !== stride * height) return null;

  const pixels = new Uint16Array(width * height);

  // PNG filter reconstruction. The filter byte selects one of five schemes; each uses
  // neighbouring pixels to predict the current one, and the stored value is the
  // difference. Reversing the filter yields the original scanline. For 16-bit grayscale,
  // each pixel is two bytes and the filter operates byte-wise.
  const prev = new Uint8Array(width * 2);
  const curr = new Uint8Array(width * 2);

  for (let y = 0; y < height; y += 1) {
    const rowOff = y * stride;
    const filter = inflated[rowOff]!;
    const rowBytes = inflated.subarray(rowOff + 1, rowOff + stride);

    for (let x = 0; x < width * 2; x += 1) {
      const raw = rowBytes[x]!;
      const a = x >= 1 ? curr[x - 1]! : 0;
      const b = prev[x]!;
      const c = x >= 1 ? prev[x - 1]! : 0;
      switch (filter) {
        case 0: curr[x] = raw; break;
        case 1: curr[x] = (raw + a) & 0xff; break;
        case 2: curr[x] = (raw + b) & 0xff; break;
        case 3: curr[x] = (raw + ((a + b) >> 1)) & 0xff; break;
        case 4: curr[x] = (raw + paeth(a, b, c)) & 0xff; break;
        default: return null;
      }
    }

    // PNG stores 16-bit values big-endian; the viewer wants them as Int16Array/Uint16Array
    // in the platform's native endian (little-endian on every supported target).
    for (let x = 0; x < width; x += 1) {
      pixels[y * width + x] = (curr[x * 2]! << 8) | curr[x * 2 + 1]!;
    }

    prev.set(curr);
  }

  return { width, height, pixels };
}

/** The Paeth predictor, per the PNG spec. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
