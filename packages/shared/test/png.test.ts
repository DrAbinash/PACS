import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { decodePng16 } from '../src/png.js';

// A 16-bit grayscale PNG builder for tests. Orthanc's `/frames/{i}/image-int16` returns
// this shape, and the decoder must agree with the matlab parser on the same pixel values.
function buildPng16(width: number, height: number, pixels: number[]): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit depth 16, color type 0 (grayscale), compression 0, filter 0, interlace 0.
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Build raw scanlines: filter byte 0 (None) + big-endian 16-bit pixels.
  const stride = 1 + width * 2;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const off = y * stride;
    raw[off] = 0; // filter: None
    for (let x = 0; x < width; x += 1) {
      const v = pixels[y * width + x]!;
      raw[off + 1 + x * 2] = (v >> 8) & 0xff;
      raw[off + 1 + x * 2 + 1] = v & 0xff;
    }
  }

  const idat = deflateSync(raw);

  const chunks: Uint8Array[] = [sig];
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', idat));
  chunks.push(chunk('IEND', new Uint8Array(0)));

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const buf = new Uint8Array(12 + len);
  const view = new DataView(buf.buffer);
  view.setUint32(0, len, false);
  buf[4] = type.charCodeAt(0);
  buf[5] = type.charCodeAt(1);
  buf[6] = type.charCodeAt(2);
  buf[7] = type.charCodeAt(3);
  buf.set(data, 8);
  // CRC is not checked by the decoder, so a zero placeholder is fine for tests.
  view.setUint32(8 + len, 0, false);
  return buf;
}

describe('decodePng16', () => {
  it('decodes a 2×2 grayscale 16-bit PNG', () => {
    const pixels = [100, 200, 300, 400];
    const png = buildPng16(2, 2, pixels);
    const decoded = decodePng16(png);
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(2);
    expect(decoded!.height).toBe(2);
    expect(Array.from(decoded!.pixels)).toEqual(pixels);
  });

  it('decodes a 4×4 PNG with values across the 16-bit range', () => {
    const pixels = [0, 1, 255, 256, 1000, 32767, 32768, 65535, 100, 200, 300, 400, 500, 600, 700, 800];
    const png = buildPng16(4, 4, pixels);
    const decoded = decodePng16(png);
    expect(decoded).not.toBeNull();
    expect(decoded!.width).toBe(4);
    expect(decoded!.height).toBe(4);
    expect(Array.from(decoded!.pixels)).toEqual(pixels);
  });

  it('returns null for a non-PNG buffer', () => {
    expect(decodePng16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
  });

  it('returns null for an 8-bit PNG', () => {
    // Build a PNG with bit depth 8 instead of 16.
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, 2, false);
    ihdrView.setUint32(4, 2, false);
    ihdr[8] = 8; // bit depth 8, not 16
    ihdr[9] = 0;
    const raw = new Uint8Array([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
    const idat = deflateSync(raw);
    const png = new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))]);
    expect(decodePng16(png)).toBeNull();
  });

  it('returns null for an RGB PNG', () => {
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, 2, false);
    ihdrView.setUint32(4, 2, false);
    ihdr[8] = 16;
    ihdr[9] = 2; // color type 2: RGB, not 0 (grayscale)
    const raw = new Uint8Array(20);
    const idat = deflateSync(raw);
    const png = new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))]);
    expect(decodePng16(png)).toBeNull();
  });

  it('handles PNG filter Sub correctly', () => {
    // Build a PNG with filter type 1 (Sub) on the second row.
    const width = 3;
    const height = 2;
    const pixels = [100, 200, 300, 150, 250, 350];
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = new Uint8Array(13);
    const ihdrView = new DataView(ihdr.buffer);
    ihdrView.setUint32(0, width, false);
    ihdrView.setUint32(4, height, false);
    ihdr[8] = 16;
    ihdr[9] = 0;

    const stride = 1 + width * 2;
    const raw = new Uint8Array(stride * height);
    // Row 0: filter None
    raw[0] = 0;
    raw[1] = 0; raw[2] = 100; // 100 = 0x0064
    raw[3] = 0; raw[4] = 200; // 200 = 0x00C8
    raw[5] = 1; raw[6] = 44; // 300 = 0x012C
    // Row 1: filter Sub (each byte = original - left byte)
    raw[stride] = 1; // filter: Sub
    // Pixel (1,0) = 150 = 0x0096. Bytes: [0x00, 0x96]
    // Sub: byte0 = 0x00 - 0 = 0x00, byte1 = 0x96 - 0x00 = 0x96 = 150
    raw[stride + 1] = 0;
    raw[stride + 2] = 150;
    // Pixel (1,1) = 250 = 0x00FA. Bytes: [0x00, 0xFA]
    // Sub: byte0 = 0x00 - 0x96 = 0x6A = 106 (wrap), byte1 = 0xFA - 0x00 = 0xFA = 250
    raw[stride + 3] = 106;
    raw[stride + 4] = 250;
    // Pixel (1,2) = 350 = 0x015E. Bytes: [0x01, 0x5E]
    // Sub: byte0 = 0x01 - 0xFA = 0x07 (wrap), byte1 = 0x5E - 0x01 = 0x5D = 93
    raw[stride + 5] = 7;
    raw[stride + 6] = 93;

    const idat = deflateSync(raw);
    const png = new Uint8Array([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', idat), ...chunk('IEND', new Uint8Array(0))]);
    const decoded = decodePng16(png);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.pixels)).toEqual(pixels);
  });
});
