import { describe, expect, it } from 'vitest';
import {
  applyWindow, defaultWindow, frameToBytes, parseMatlabFrame, tagValue,
} from '../src/pixels.js';

// The matlab text is Orthanc 1.13.0's own shape, captured from the pinned container:
// `double([ ` … ` ])`, values space-separated, rows separated by `;`. Not a remembered
// format — the first version of this fixture was written from a truncated print and had
// no semicolons in it, which is how the parser shipped broken for a whole frame.
const DOUBLE = 'double([ 400 400 400 -500 65535 1228 ; 1291 454 517 580 643 706 769 ])';

describe('parseMatlabFrame', () => {
  it('reads the values the node printed', () => {
    const frame = parseMatlabFrame(DOUBLE);
    expect(frame).not.toBeNull();
    // 65535 does not fit a signed 16-bit slot, so it lands on the same bits as -1; the
    // browser reads the buffer unsigned when the study says PixelRepresentation 0.
    expect(Array.from(frame!.values)).toEqual([400, 400, 400, -500, -1, 1228, 1291, 454, 517, 580, 643, 706, 769]);
    expect(frame!.negativeSeen).toBe(true);
  });

  it('reports a value that cannot be 16-bit at all', () => {
    expect(parseMatlabFrame('double([ 1 70000 2 ])')!.overflowSeen).toBe(true);
    expect(parseMatlabFrame('double([ 1 -40000 2 ])')!.overflowSeen).toBe(true);
    expect(parseMatlabFrame('double([ 1 2 3 ])')!.overflowSeen).toBe(false);
    expect(parseMatlabFrame('double([ 1 2 3 ])')!.negativeSeen).toBe(false);
  });

  it('keeps the unsigned interpretation when the bits are read back unsigned', () => {
    // A study with PixelRepresentation 0 can carry 65535. The wire is 16 bits either
    // way, so the browser must be able to recover it by reading the same buffer as
    // unsigned — the value the reader sees has to be the value the scanner stored.
    const frame = parseMatlabFrame('double([ 0 32768 65535 ])')!;
    const unsigned = new Uint16Array(frameToBytes(frame).buffer);
    expect(Array.from(unsigned)).toEqual([0, 32768, 65535]);
  });

  it('refuses anything that is not that shape', () => {
    // An Orthanc error page arriving where a frame should be must fail, not draw black.
    expect(parseMatlabFrame('{"HttpError":"Not Found"}')).toBeNull();
    expect(parseMatlabFrame('')).toBeNull();
    expect(parseMatlabFrame('double([])')).toBeNull();
    expect(parseMatlabFrame('double([ 1 abc 3 ])')).toBeNull();
  });

  it('splits the rows the node separates with semicolons', () => {
    // Measured shape from the pinned container: one line, rows separated by `;`, no
    // commas, no newlines. Flat row-major is the order the canvas wants.
    const frame = parseMatlabFrame('double([ 1 2 3 ; 4 5 6 ; 7 8 9 ])');
    expect(Array.from(frame!.values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(frame!.overflowSeen).toBe(false);
  });
});

describe('frameToBytes', () => {
  it('writes little-endian 16-bit values', () => {
    const frame = parseMatlabFrame('double([ 258 ])')!; // 0x0102
    expect(Array.from(frameToBytes(frame))).toEqual([0x02, 0x01]);
  });
});

describe('applyWindow', () => {
  const mk = (values: number[]) => Int16Array.from(values);

  it('maps the window centre to mid-grey and the top of the window to white', () => {
    const out = applyWindow(mk([40, 240]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: 0, invert: false,
    });
    expect([out[0], out[1], out[2]]).toEqual([128, 128, 128]); // the centre of the window
    expect([out[4], out[5], out[6]]).toEqual([255, 255, 255]); // 240 is the top edge
    expect(out[3]).toBe(255); // alpha is opaque everywhere
  });

  it('applies rescale before the window, because the window is written in HU', () => {
    // Stored 1200 with slope 1 and intercept -1024 is 176 HU; the same window in HU
    // terms must give the same grey whichever order the code reaches for.
    const a = applyWindow(mk([1200]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: -1024, invert: false,
    });
    const b = applyWindow(mk([176]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: 0, invert: false,
    });
    expect(a[0]).toBe(b[0]);
    expect(a[0]).toBe(214);
  });

  it('clamps outside the window instead of wrapping', () => {
    const out = applyWindow(mk([-3000, 3000]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: -1024, invert: false,
    });
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(255);
  });

  it('inverts for Monochrome1', () => {
    const normal = applyWindow(mk([240]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: 0, invert: false,
    });
    const inverted = applyWindow(mk([240]), {
      level: { center: 40, width: 400 }, rescaleSlope: 1, rescaleIntercept: 0, invert: true,
    });
    expect(normal[0]! + inverted[0]!).toBe(255);
  });

  it('treats a zero width as a single level rather than dividing by it', () => {
    const out = applyWindow(mk([10, 10, 11]), {
      level: { center: 10, width: 0 }, rescaleSlope: 1, rescaleIntercept: 0, invert: false,
    });
    expect(out[0]).toBe(0);
    expect(out[8]).toBe(255);
  });
});

describe('defaultWindow', () => {
  it('uses the window the modality wrote', () => {
    expect(defaultWindow({ windowCenter: '40', windowWidth: '400' })).toEqual({ center: 40, width: 400 });
  });

  it('takes the first of a multi-valued window', () => {
    expect(defaultWindow({ windowCenter: '40\\800', windowWidth: '400\\1500' })).toEqual({ center: 40, width: 400 });
  });

  it('falls back to the stored range so an unwindowed study is not a black rectangle', () => {
    expect(defaultWindow({ minStored: 0, maxStored: 4095 })).toEqual({ center: 2047.5, width: 4095 });
    // rescale applies to the fallback too: a chest film stored 0-65535 with no rescale
    // is a different picture from one stored 0-4095 that means HU.
    expect(defaultWindow({ minStored: 0, maxStored: 100, rescaleSlope: 2, rescaleIntercept: -50 }))
      .toEqual({ center: 50, width: 200 });
  });

  it('refuses a zero-width window even when the study says so', () => {
    expect(defaultWindow({ windowCenter: '40', windowWidth: '0', minStored: 0, maxStored: 10 }))
      .toEqual({ center: 5, width: 10 });
  });

  it('returns a usable single level when there is nothing to work from', () => {
    expect(defaultWindow({})).toEqual({ center: 0, width: 1 });
  });
});

describe('tagValue', () => {
  const tags = {
    '0028,0010': { Name: 'Rows', Type: 'Integer', Value: 64 },
    '0028,0011': { Name: 'Columns', Type: 'Integer', Value: 64 },
    '0028,1050': { Name: 'WindowCenter', Type: 'String', Value: ['40', '800'] },
    '0028,0004': { Name: 'PhotometricInterpretation', Type: 'String', Value: 'MONOCHROME2' },
  };

  it('finds a tag by name, not by the group number remembered', () => {
    expect(tagValue(tags, 'Rows')).toBe('64');
    expect(tagValue(tags, 'PhotometricInterpretation')).toBe('MONOCHROME2');
  });

  it('joins a multi-valued tag the way DICOM writes it', () => {
    expect(tagValue(tags, 'WindowCenter')).toBe('40\\800');
  });

  it('says null for an absent tag', () => {
    expect(tagValue(tags, 'RescaleIntercept')).toBeNull();
  });
});
