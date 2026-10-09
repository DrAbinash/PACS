// Orthanc renders a frame to PNG, but this deployment's build was measured to ignore
// every window parameter it is given: eight different windows on the same study produced
// one identical 101-byte PNG, and `/preview` with size, min, max, modality and quality
// produced one identical 1054-byte PNG. A viewer that cannot change the window is not a
// radiology viewer, so the numbers have to come across and the window has to be applied
// here, in the browser.
//
// `/instances/{pk}/frames/{i}/matlab` is the only endpoint on that build that returns
// stored pixel values rather than a rendered picture, so the api reads it and ships the
// values as fixed-width binary. Kept pure — no I/O — so the parse is testable, including
// against Orthanc's real formatting of a negative and a large value.

export type PixelFormat = 'int16' | 'uint16';

/** Stored pixel values as the node reported them, before any window is applied. */
export type FramePixels = {
  values: Int16Array;
  /** True when any value was negative, i.e. the study stores signed pixels. */
  negativeSeen: boolean;
  /** True when a value fell outside 16 bits, which means this is not a 16-bit study. */
  overflowSeen: boolean;
};

/**
 * Parse `double([ v v v ; v v v ; ... ])` — the whole of what the node returns, including
 * the semicolons it puts between image rows (measured on 1.13.0: 63 separators in a
 * 64-row frame, no commas, no newlines). Returns null when the text is not that shape, so
 * a caller that met an error page or a frame without pixel data gets a refusal rather
 * than an empty image it would have to draw.
 */
export function parseMatlabFrame(text: string): FramePixels | null {
  const open = text.indexOf('([');
  const close = text.lastIndexOf('])');
  if (open < 0 || close <= open) return null;
  const body = text.slice(open + 2, close);
  const parts = body.split(/[\s,;]+/).filter((s) => s.length > 0);
  if (parts.length === 0) return null;

  const values = new Int16Array(parts.length);
  let negativeSeen = false;
  let overflowSeen = false;
  for (let i = 0; i < parts.length; i += 1) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n)) return null;
    if (n < 0) negativeSeen = true;
    // 16-bit storage holds the bits, not the interpretation: a value above 32767 is a
    // 16-bit unsigned number and the browser will read it as one. Anything outside 16
    // bits at all means this endpoint is not describing a 16-bit study.
    if (n > 65535 || n < -32768) overflowSeen = true;
    values[i] = n;
  }
  return { values, negativeSeen, overflowSeen };
}

/** Little-endian 16-bit values on the wire, so the browser can wrap them directly. */
export function frameToBytes(frame: FramePixels): Uint8Array {
  const bytes = new Uint8Array(frame.values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < frame.values.length; i += 1) {
    view.setInt16(i * 2, frame.values[i]!, true);
  }
  return bytes;
}

export type WindowLevel = { center: number; width: number };

/**
 * Map stored values to 0-255 with a linear window: the DICOM definition, with rescale
 * applied first because HU is what the window is written against, and Monochrome1
 * inverted because that photometric interpretation means the pixel is the *negative* of
 * the light.
 */
export function applyWindow(
  values: Int16Array | Uint16Array,
  opts: {
    level: WindowLevel;
    rescaleSlope: number;
    rescaleIntercept: number;
    invert: boolean;
  },
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length * 4);
  const low = opts.level.center - opts.level.width / 2;
  const span = opts.level.width <= 0 ? 1 : opts.level.width;
  for (let i = 0; i < values.length; i += 1) {
    const hu = values[i]! * opts.rescaleSlope + opts.rescaleIntercept;
    let grey = ((hu - low) / span) * 255;
    if (grey < 0) grey = 0;
    if (grey > 255) grey = 255;
    if (opts.invert) grey = 255 - grey;
    const g = Math.round(grey);
    const o = i * 4;
    out[o] = g;
    out[o + 1] = g;
    out[o + 2] = g;
    out[o + 3] = 255;
  }
  return out;
}

/**
 * The window to open a study with. `WindowCenter`/`WindowWidth` may be a list in real
 * DICOM — several windows for one image — and the first is the one the modality intended.
 * Falling back to the full range rather than a fixed number matters: a study with no
 * window tags drawn at 40/400 would be a black rectangle.
 */
export function defaultWindow(tags: {
  windowCenter?: string | null;
  windowWidth?: string | null;
  minStored?: number;
  maxStored?: number;
  rescaleSlope?: number;
  rescaleIntercept?: number;
}): WindowLevel {
  const center = firstNumber(tags.windowCenter);
  const width = firstNumber(tags.windowWidth);
  const slope = tags.rescaleSlope ?? 1;
  const intercept = tags.rescaleIntercept ?? 0;
  if (center !== null && width !== null && width > 0) {
    return { center, width };
  }
  const lo = (tags.minStored ?? 0) * slope + intercept;
  const hi = (tags.maxStored ?? 0) * slope + intercept;
  if (hi > lo) return { center: (lo + hi) / 2, width: hi - lo };
  return { center: 0, width: 1 };
}

function firstNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).split('\\')[0]?.trim());
  return Number.isFinite(n) ? n : null;
}

/** Orthanc's tag dictionary is keyed by group,element with a Name beside it. */
export function tagValue(
  tags: Record<string, { Name?: string; Value?: unknown }>,
  name: string,
): string | null {
  for (const entry of Object.values(tags)) {
    if (entry?.Name === name) {
      const value = entry.Value;
      if (value === undefined || value === null) return null;
      return Array.isArray(value) ? value.join('\\') : String(value);
    }
  }
  return null;
}
