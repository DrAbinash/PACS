import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyWindow, defaultWindow } from '@telrad/shared/pixels';
import ReportPanel from './Report';
import { api, ApiError, type ViewDescriptor, type ViewInstance } from './api';

type Slice = { pk: string; meta: ViewInstance | null; pixels: Int16Array | Uint16Array | null; jpegUrl: string | null };

/**
 * The case a reader accepted. It exists because the board's own promise — a case lands on
 * somebody's desk — was only half kept: an offer could be accepted and there was nothing to
 * open.
 *
 * There is no image toolkit here on purpose. The node in this deployment was measured to
 * ignore every window parameter it is offered (nine windows, one identical PNG), so the
 * stored values cross as numbers and the window is computed on this side. That is what
 * makes brightness and contrast adjustable at all, and it is also why this is a first
 * viewer rather than a diagnostic one: no measurement tools, no MPR, no pan.
 */
export default function Viewer({ studyId, onBack, onChanged }: {
  studyId: number;
  onBack: () => void;
  // The board and the desk both change when a report is signed: the case leaves the
  // reader's queue, the clock stops, and the panel colour moves. The viewer should not be
  // the only screen that still thinks the read is in progress.
  onChanged: () => void;
}) {
  const [descriptor, setDescriptor] = useState<ViewDescriptor | null>(null);
  const [seriesIndex, setSeriesIndex] = useState(0);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [slice, setSlice] = useState<Slice | null>(null);
  const [level, setLevel] = useState<{ center: number; width: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<{ x: number; y: number; center: number; width: number } | null>(null);
  const blobUrl = useRef<string | null>(null);

  const series = descriptor?.series ?? [];
  const current = series[seriesIndex] ?? null;
  const pk = current?.instances[sliceIndex] ?? null;

  useEffect(() => {
    let live = true;
    api.view(studyId)
      .then((d) => {
        if (!live) return;
        setDescriptor(d);
        if (d.purgedAt) {
          setError(`The images were deleted by the retention policy on ${new Date(d.purgedAt).toLocaleDateString()}. The report and the audit trail remain.`);
          return;
        }
        const first = d.series.find((s) => s.count > 0);
        if (!first) setError('The node reports no instances for this study.');
        setSeriesIndex(first ? first.index : 0);
        setSliceIndex(0);
      })
      .catch((err) => {
        if (!live) return;
        setError(err instanceof ApiError ? describe(err) : 'cannot reach the server');
      });
    return () => { live = false; };
  }, [studyId]);

  // The tags and the pixels are two reads: the first says what the numbers mean, the
  // second is the numbers. Asking for the pixels without the tags would draw a picture
  // whose brightness is a guess.
  useEffect(() => {
    if (!pk) return;
    let live = true;
    setBusy(true);
    void Promise.all([api.viewInstance(studyId, pk), api.viewFrame(studyId, pk, 0)])
      .then(([meta, { format, bytes }]) => {
        if (!live) return;
        // Two kinds of frame cross this route. A numeric one is read as an array of
        // stored values — PixelRepresentation says whether they are signed, and getting
        // that wrong turns a chest film inside out. A JPEG one is already a finished
        // picture — the node stores the JPG→DICOM uploads verbatim because it cannot
        // decode them — so it is kept as a blob URL and drawn as an image.
        let pixels: Int16Array | Uint16Array | null = null;
        let jpegUrl: string | null = null;
        if (format === 'jpeg') {
          if (blobUrl.current) URL.revokeObjectURL(blobUrl.current);
          jpegUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
          blobUrl.current = jpegUrl;
        } else {
          pixels = meta.pixelRepresentation === 1 ? new Int16Array(bytes) : new Uint16Array(bytes);
        }
        setSlice({ pk, meta, pixels, jpegUrl });
        if (pixels) {
          setLevel((old) => old ?? defaultWindow({
            windowCenter: meta.windowCenter,
            windowWidth: meta.windowWidth,
            minStored: 0,
            maxStored: (1 << (meta.bitsStored ?? 16)) - 1,
            rescaleSlope: meta.rescaleSlope ?? 1,
            rescaleIntercept: meta.rescaleIntercept ?? 0,
          }));
          setError(pixels.length !== (meta.rows ?? 0) * (meta.columns ?? 0)
            ? `the node sent ${pixels.length} values for a ${meta.rows}×${meta.columns} image`
            : null);
        } else {
          setError(null);
        }
      })
      .catch((err) => {
        if (!live) return;
        setSlice(null);
        setError(err instanceof ApiError ? describe(err) : 'cannot reach the server');
      })
      .finally(() => { if (live) setBusy(false); });
    return () => {
      live = false;
      if (blobUrl.current) { URL.revokeObjectURL(blobUrl.current); blobUrl.current = null; }
    };
  }, [studyId, pk]);

  const invert = slice?.meta?.photometric === 'MONOCHROME1';

  useEffect(() => {
    if (slice?.jpegUrl) return; // drawn as a finished image in the effect below
    const el = canvas.current;
    const meta = slice?.meta;
    const values = slice?.pixels;
    if (!el || !meta || !values || !level || !meta.rows || !meta.columns) return;
    const rgba = applyWindow(values, {
      level,
      rescaleSlope: meta.rescaleSlope ?? 1,
      rescaleIntercept: meta.rescaleIntercept ?? 0,
      invert,
    });
    el.width = meta.columns;
    el.height = meta.rows;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    // createImageData rather than new ImageData(...), because the buffer the window is
    // computed into is a plain ArrayBuffer-backed view and the canvas wants its own.
    const image = ctx.createImageData(meta.columns, meta.rows);
    image.data.set(rgba);
    ctx.putImageData(image, 0, 0);
  }, [slice, level, invert]);

  // A JPEG frame already carries its own rendering, so it is drawn as sent — the
  // level/window machinery has nothing to compute for it.
  useEffect(() => {
    const el = canvas.current;
    const url = slice?.jpegUrl;
    if (!el || !url) return;
    const img = new Image();
    img.onload = () => {
      el.width = img.naturalWidth;
      el.height = img.naturalHeight;
      const ctx = el.getContext('2d');
      if (ctx) ctx.drawImage(img, 0, 0);
    };
    img.src = url;
  }, [slice]);

  const go = useCallback((next: number) => {
    if (!current) return;
    setSliceIndex(Math.max(0, Math.min(current.count - 1, next)));
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onBack();
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); go(sliceIndex + 1); }
      if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); go(sliceIndex - 1); }
      if (e.key === 'PageDown') { e.preventDefault(); go(sliceIndex + 10); }
      if (e.key === 'PageUp') { e.preventDefault(); go(sliceIndex - 10); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, onBack, sliceIndex]);

  const total = useMemo(() => series.reduce((n, s) => n + s.count, 0), [series]);

  // The report belongs on the screen only for the people who can act on it: the reader
  // holding the case, the one being asked for a second name, and the author coming back to
  // what they signed. For a case merely offered it is noise — deciding whether to accept is
  // what that screen is for.
  const access = descriptor?.reportAccess ?? null;
  const showReport = descriptor !== null
    && ((descriptor.held?.state === 'accepted' || descriptor.held?.state === 'reading') || access !== null);

  return (
    <>
      <header className="bar">
        <h1>{descriptor?.study.accession ?? `study ${studyId}`}</h1>
        <span className="when">
          {descriptor
            ? `${descriptor.study.patient.name ?? 'name not carried'} · ${descriptor.study.modality ?? '?'} · ${descriptor.study.subSpecialty ?? 'not classified'}`
            : 'opening…'}
          {total > 0 && ` · ${total} instances`}
        </span>
        <button onClick={onBack} style={{ marginLeft: 'auto' }}>Back to the board</button>
      </header>

      <main>
        {error && <div className="banner">{error}</div>}
        {descriptor?.reportAccess && (
          <div className="notebar">{openNote(descriptor.reportAccess)}</div>
        )}

        <div className="reading">
          <div className="viewer">
            <div className="series">
              {series.map((s) => (
                <button
                  key={s.pk}
                  className={s.index === seriesIndex ? 'primary' : undefined}
                  disabled={s.count === 0}
                  onClick={() => { setSeriesIndex(s.index); setSliceIndex(0); }}
                >
                  {s.description || s.modality || `series ${s.index + 1}`}
                  <span className="sub"> {s.count}</span>
                </button>
              ))}
            </div>

            <div
              className="screen"
              onWheel={(e) => { e.preventDefault(); go(sliceIndex + (e.deltaY > 0 ? 1 : -1)); }}
              onPointerDown={(e) => {
                if (!level || slice?.jpegUrl) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, center: level.center, width: level.width };
              }}
              onPointerMove={(e) => {
                const start = drag.current;
                if (!start) return;
                // Drag is the interaction a reader already knows: horizontal for contrast,
                // vertical for brightness, both in the units the study itself used.
                setLevel({
                  center: Math.round(start.center - (e.clientY - start.y) / 2),
                  width: Math.max(1, Math.round(start.width + (e.clientX - start.x) / 2)),
                });
              }}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
            >
              <canvas ref={canvas} />
              {busy && <div className="overlay">loading</div>}
              {!slice && !busy && !error && <div className="overlay">no image</div>}
            </div>

            <div className="controls">
              <div className="row">
                <button onClick={() => go(sliceIndex - 1)}>◀</button>
                <input
                  type="range" min={0} max={Math.max(0, (current?.count ?? 1) - 1)}
                  value={sliceIndex} onChange={(e) => setSliceIndex(Number(e.target.value))}
                />
                <button onClick={() => go(sliceIndex + 1)}>▶</button>
                <span className="sub">slice {(current ? sliceIndex : 0) + 1} / {current?.count ?? 0}</span>
              </div>
              <div className="row">
                {slice?.jpegUrl ? (
                  <span className="sub">stored image — drawn as sent, no windowing applies</span>
                ) : (
                  <>
                    <label>level
                      <input type="number" value={level?.center ?? 0}
                        onChange={(e) => setLevel((l) => ({ center: Number(e.target.value), width: l?.width ?? 1 }))} />
                    </label>
                    <label>window
                      <input type="number" value={level?.width ?? 1} min={1}
                        onChange={(e) => setLevel((l) => ({ center: l?.center ?? 0, width: Math.max(1, Number(e.target.value)) }))} />
                    </label>
                  </>
                )}
                {invert && <span className="state amber">inverted (MONOCHROME1)</span>}
                <span className="sub">
                  {slice?.meta?.rows ?? '—'}×{slice?.meta?.columns ?? '—'}
                  {slice?.meta?.bitsStored ? ` · ${slice.meta.bitsStored}-bit` : ''}
                  {descriptor?.windowing === 'client' ? ' · windowed here' : ''}
                </span>
              </div>
              <div className="sub">
                Arrow keys or the wheel change the slice; drag on the image for level and window.
                No measurement tools, no multiplanar reconstruction — this is the first viewer,
                not the diagnostic one.
              </div>
            </div>
          </div>

          {showReport && <ReportPanel studyId={studyId} onChanged={onChanged} />}
        </div>
      </main>
    </>
  );
}

// Why the images opened for somebody who is not holding the case. Three different
// permissions, and a reader who is not told which one they are using cannot tell a review
// from a read-back from an operator's look.
function openNote(access: NonNullable<ViewDescriptor['reportAccess']>): string {
  if (access.as === 'review') {
    return `You are not holding this case. It opened because version ${access.version} of its report is waiting for a second name, and nobody should sign what they cannot see.`;
  }
  if (access.as === 'author') {
    return `You are reading this back as the author of version ${access.version}. The case left your desk when you signed it, so the panel no longer lists it.`;
  }
  return `You are opening this as the desk, not as a reader. Version ${access.version} of its report is ${access.state}.`;
}

function describe(err: ApiError): string {
  switch (err.code) {
    case 'not_your_case': return 'This case is not on your desk, so its images are not readable here.';
    case 'not_at_node': return 'The study is filed in the database but the image node does not have it.';
    case 'node_rejected_credentials': return 'The image node refused the api\'s credential. Nothing is wrong with this case.';
    case 'not_in_this_study': return 'That image is not part of this study.';
    case 'no_pixels_in_frame': return 'This instance carries no pixel data — a localizer or a dose page, not an image.';
    case 'frame_not_16_bit': return 'This frame is not 16-bit, and the viewer refuses to guess at its scale.';
    default: return `${err.status} ${err.message}`;
  }
}
