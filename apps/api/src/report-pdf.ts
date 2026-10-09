import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFPageDrawTextOptions } from 'pdf-lib';

// The delivered record. A signed report is a row of jsonb in our database; what the
// referring clinic keeps is this document, and it has to stand on its own without a
// browser, a session, or this repository. So everything a reader would need to
// challenge it is printed on it: both names with their registration numbers, the
// timestamps, the version, and which version it replaced.
//
// pdf-lib is a deliberate choice over a headless browser or a native binding: pure
// JavaScript, no compile step, and the same bytes here on a laptop are the bytes in a
// cloud container. Deterministic output is not a nicety — `reports.pdf_sha256` is the
// value a center can quote when someone claims the document they were sent is not the
// one that was signed, and a hash that moved between renders would answer nothing.
// That is why the creation date is pinned to the signature and the object streams are
// turned off.

const PAGE = { width: 595.28, height: 841.89 } as const; // A4 portrait, points
const MARGIN = 48;
const BOTTOM = 74;
const BODY_SIZE = 11;
const LEAD = 15;
const LABEL_SIZE = 8.5;

const INK = rgb(0.11, 0.12, 0.14);
const RULE = rgb(0.62, 0.65, 0.69);
const MUTED = rgb(0.36, 0.39, 0.43);
const ALERT = rgb(0.55, 0.13, 0.13);

const SECTION_TITLES: [string, string][] = [
  ['clinicalHistory', 'Clinical history'],
  ['technique', 'Technique'],
  ['findings', 'Findings'],
  ['impression', 'Impression'],
  ['recommendation', 'Recommendation'],
];

export type ReportPdfInput = {
  centreName: string;
  tenantCode: string;
  accession: string;
  modality: string | null;
  subSpecialty: string | null;
  priority: string;
  studyDate: string | null;
  receivedAt: string | null;
  patient: { name: string; mrn: string; sex: string; age: string | null; dob: string | null };
  referring: { name: string | null; registration: string | null; phone: string | null };
  version: number;
  state: string;
  requiresReviewer: boolean;
  supersedesVersion: number | null;
  supersededByVersion: number | null;
  amendmentReason: string | null;
  sections: Record<string, string>;
  author: { name: string; registration: string };
  reviewer: { name: string; registration: string } | null;
  signedAt: string | null;
  verifiedAt: string | null;
  // Who was told, and whether they said they heard it. Both halves belong on the document: the
  // clinic reading it back needs to know which of its own staff the finding landed on, and the
  // line "not yet acknowledged" is the one that turns a missing call into something visible on
  // paper rather than only on a board.
  criticals: {
    code: string;
    label: string;
    told: string | null;
    acknowledgedAt: string | null;
    deadlineAt: string | null;
  }[];
};

// Wrapping is measured with the font that will draw it, not assumed from a character
// count: a report line is mostly names and measurements, and 80 characters of "S1 T2
// FLAIR" is half the width of 80 characters of a surname.
export function wrapText(text: string, width: (chunk: string) => number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    if (paragraph.trim() === '') { out.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= maxWidth) { line = candidate; continue; }
      if (line) out.push(line);
      // A single token wider than the column — a long accession, a base64 fragment in
      // a paste — is broken rather than allowed to run off the page and be unreadable
      // on paper.
      let rest = word;
      while (width(rest) > maxWidth) {
        let cut = rest.length;
        while (cut > 1 && width(rest.slice(0, cut)) > maxWidth) cut -= 1;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    if (line) out.push(line);
  }
  return out;
}

const stamp = (value: string | null): string => value ?? '—';

// The built-in Helvetica is a WinAnsi font: it carries Latin-1 plus a fixed set of
// typographic marks, and nothing else. A Devanagari patient name, a Chinese radiologist
// signature, or any emoji pasted out of a WhatsApp thread is not encodable, and pdf-lib
// throws on it — which in a download route would mean the clinic cannot get the report
// that was already signed. So the text is made printable here, and a name that cannot be
// printed arrives as `?` characters the reader can see and complain about, rather than as
// a 500 nobody can explain. The real fix is embedding a Unicode TTF through fontkit, and
// that is an open item, not a secret one.
const WINANSI_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122,
  0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function printable(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n') { out += ch; continue; }
    if (ch === '\t') { out += '  '; continue; }
    const code = ch.codePointAt(0) ?? 0;
    const encodable = (code >= 0x20 && code <= 0x7e)
      || (code >= 0xa0 && code <= 0xff)
      || WINANSI_EXTRA.has(code);
    out += encodable ? ch : '?';
  }
  return out;
}

const sanitize = (input: ReportPdfInput): ReportPdfInput => JSON.parse(
  JSON.stringify(input, (_k, v) => (typeof v === 'string' ? printable(v) : v)),
) as ReportPdfInput;

export async function renderReportPdf(source: ReportPdfInput): Promise<{
  bytes: Uint8Array; sha256: string; pages: number; lines: string[];
}> {
  const input = sanitize(source);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const contentWidth = PAGE.width - MARGIN * 2;

  // Pinned to the signature so re-rendering the same report years later produces the
  // same file. A report signed at 12:51 that hashes differently on Thursday is a
  // document nobody can vouch for.
  doc.setTitle(`Report ${input.accession} v${input.version}`);
  doc.setAuthor(`${input.author.name} (${input.author.registration})`);
  doc.setCreator(`telrad ${input.tenantCode}`);
  doc.setProducer('telrad');
  const pinned = input.signedAt ? new Date(input.signedAt) : new Date(0);
  doc.setCreationDate(pinned);
  doc.setModificationDate(pinned);

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  let pageCount = 1;

  // Every string that reaches the page is recorded here as well as drawn. pdf-lib
  // compresses the content stream, so a test cannot read the document back without
  // pulling in a PDF parser; what it can do is assert the words a clinic would see —
  // the patient, both registrations, the superseded banner — from the same list the
  // renderer drew from.
  const drawn: string[] = [];
  const draw = (text: string, options: PDFPageDrawTextOptions) => {
    drawn.push(text);
    page.drawText(text, options);
  };

  const newPage = () => {
    page = doc.addPage([PAGE.width, PAGE.height]);
    pageCount += 1;
    y = PAGE.height - MARGIN;
    drawFooter();
  };

  const rule = () => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE.width - MARGIN, y }, thickness: 0.6, color: RULE });
    y -= 14;
  };

  const need = (rows: number) => {
    if (y - rows * LEAD < BOTTOM) newPage();
  };

  const heading = (text: string, size = 10, color = INK) => {
    need(1);
    draw(text, { x: MARGIN, y: y - size, size, font: bold, color });
    y -= size + 6;
  };

  const body = (text: string, size = BODY_SIZE, color = INK) => {
    for (const line of wrapText(text, (s) => font.widthOfTextAtSize(s, size), contentWidth)) {
      need(1);
      draw(line, { x: MARGIN, y: y - size, size, font, color });
      y -= LEAD;
    }
  };

  const field = (label: string, value: string) => {
    const lines = wrapText(value, (s) => font.widthOfTextAtSize(s, BODY_SIZE), contentWidth - 120);
    need(lines.length);
    draw(label.toUpperCase(), { x: MARGIN, y: y - LABEL_SIZE - 1, size: LABEL_SIZE, font: bold, color: MUTED });
    lines.forEach((line) => {
      draw(line, { x: MARGIN + 120, y: y - BODY_SIZE, size: BODY_SIZE, font });
      y -= LEAD;
    });
  };

  const drawFooter = () => {
    draw(
      `${input.accession} · version ${input.version} · page ${pageCount} · generated by telrad for ${input.tenantCode}`,
      { x: MARGIN, y: 34, size: 8, font, color: MUTED },
    );
    draw('This document is the delivered record of a radiology report and contains patient data.',
      { x: MARGIN, y: 22, size: 8, font, color: MUTED });
  };

  drawFooter();

  draw(input.centreName, { x: MARGIN, y: y - 15, size: 15, font: bold, color: INK });
  y -= 22;
  draw('Diagnostic imaging report', { x: MARGIN, y: y - 10, size: 10, font, color: MUTED });
  draw(`REPORT ${input.accession}`, {
    x: PAGE.width - MARGIN - bold.widthOfTextAtSize(`REPORT ${input.accession}`, 11),
    y: y - 10, size: 11, font: bold, color: INK,
  });
  y -= 14;
  rule();

  if (input.state === 'amended') {
    heading(`SUPERSEDED by version ${input.supersededByVersion ?? 'a later one'} — this version is retained for the record and is not the current answer`, 9.5, ALERT);
  }
  if (input.state === 'withdrawn') {
    heading('WITHDRAWN — this report must not be relied on', 9.5, ALERT);
  }
  if (input.requiresReviewer && !input.reviewer && input.state === 'signed') {
    heading('Signed, and awaiting a second name. Not yet cleared for release.', 9.5, ALERT);
  }

  heading('Patient and study', 11);
  field('Patient', input.patient.name);
  field('Identifier', `${input.patient.mrn}${input.patient.dob ? ` · dob ${input.patient.dob}` : ''} · ${input.patient.sex}${input.patient.age ? `, ${input.patient.age}` : ''}`);
  field('Modality', `${input.modality ?? '—'}${input.subSpecialty ? ` · ${input.subSpecialty}` : ''}`);
  field('Study date', `${stamp(input.studyDate)} · received ${stamp(input.receivedAt)}`);
  field('Priority', input.priority);
  field('Referring', `${input.referring.name ?? 'not recorded'}${input.referring.registration ? ` · reg ${input.referring.registration}` : ''}${input.referring.phone ? ` · ${input.referring.phone}` : ''}`);
  y -= 6;

  if (input.criticals.length > 0) {
    heading('Critical findings communicated', 11, ALERT);
    for (const c of input.criticals) {
      body(`${c.label} (${c.code})`, BODY_SIZE, ALERT);
      // Who was told, and whether they said they heard it. A document that printed only the
      // finding would look like a notification while carrying none of the evidence — and this
      // line is the half a referring clinic cannot reconstruct from anything else.
      body(`${c.told ?? 'Receiver not recorded'} · ${c.acknowledgedAt
        ? `acknowledged ${c.acknowledgedAt}`
        : `acknowledgement NOT YET RECEIVED (was due ${stamp(c.deadlineAt)})`}`, 9, MUTED);
    }
    y -= 6;
  }

  if (input.supersedesVersion !== null) {
    heading(`Amendment of version ${input.supersedesVersion}`, 11);
    body(input.amendmentReason ?? 'no reason recorded');
    y -= 6;
  }

  heading('Report', 11);
  for (const [key, title] of SECTION_TITLES) {
    const text = (input.sections[key] ?? '').trim();
    heading(title, 10, MUTED);
    body(text === '' ? 'not recorded' : text);
    y -= 6;
  }

  heading('Signatures', 11);
  rule();
  const signature = (role: string, name: string, registration: string, when: string | null, grade?: string) => {
    need(2);
    draw(name, { x: MARGIN, y: y - BODY_SIZE, size: BODY_SIZE, font: bold, color: INK });
    draw(`${role} · ${registration}${grade ? ` · ${grade}` : ''}`, {
      x: MARGIN, y: y - BODY_SIZE - 13, size: 9, font, color: MUTED,
    });
    if (when) {
      draw(when, {
        x: PAGE.width - MARGIN - font.widthOfTextAtSize(when, 9), y: y - BODY_SIZE - 13, size: 9, font, color: MUTED,
      });
    }
    y -= 34;
  };
  signature('Reporting radiologist', input.author.name, input.author.registration, input.signedAt);
  signature('Reviewing radiologist', input.reviewer?.name ?? 'No second name recorded',
    input.reviewer?.registration ?? '—', input.verifiedAt);

  // Nothing operational is printed here. When the desk pressed "deliver" is a fact about
  // the sending, and it lives in the audit chain and `report_deliveries`; the moment it was
  // written into the page, the delivered document's own hash would have stopped matching
  // the bytes a clinic can download afterwards — which is the one claim `pdf_sha256` makes.

  const bytes = await doc.save({ useObjectStreams: false });
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pages: pageCount,
    lines: drawn,
  };
}

// A filename a clinic can keep. The patient's name is never in it: these files are
// downloaded onto shared reception machines and forwarded by hand, and a filename is
// indexed by everything between the clinic and the court.
export function reportPdfFilename(accession: string, version: number): string {
  const safe = accession.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'report';
  return `telrad-${safe}-v${version}.pdf`;
}
