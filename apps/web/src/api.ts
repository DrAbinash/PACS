export type PresenceColor = 'green' | 'amber' | 'red';

export type PanelRow = {
  userId: number;
  name: string;
  role: string;
  grade: 'junior' | 'senior' | 'chief';
  registration: string;
  subspecialtyCodes: string[];
  modalityCodes: string[];
  tenantId: number | null;
  openCases: number;
  maxQueueSize: number;
  declaredState: 'receiving' | 'paused' | 'away' | 'offline';
  declaredSince: string | null;
  lastSeenAt: string | null;
  color: PresenceColor;
  code: string;
  label: string;
  routable: boolean;
  sinceSeenSeconds: number | null;
  onShift: { kind: string; startsAt: string; endsAt: string } | null;
};

export type Panel = {
  generatedAt: string;
  counts: { green: number; amber: number; red: number };
  panel: PanelRow[];
};

export type Session = {
  ok: boolean;
  user: { id: number; role: string; name?: string; tenantId: number | null };
  clinician: unknown;
};

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    throw new ApiError(res.status, String(body.error ?? res.statusText), String(body.error ?? ''));
  }
  return body as T;
}

export type WorkCase = {
  assignmentId: number;
  studyId: number;
  state: 'offered' | 'accepted' | 'reading';
  offeredAt: string;
  acceptedAt: string | null;
  expiresAt: string | null;
  attemptNo: number;
  priority: 'stat' | 'urgent' | 'routine';
  modality: string | null;
  subSpecialty: string | null;
  accession: string | null;
  patientName: string | null;
  patientMrn: string | null;
  studyDescription: string | null;
  receivedAt: string;
  waitingMinutes: number;
  report: { id: number; version: number; state: ReportState } | null;
};

export type LateCase = {
  clockId: number;
  studyId: number;
  tenant: string | null;
  accession: string | null;
  modality: string | null;
  subSpecialty: string | null;
  priority: 'stat' | 'urgent' | 'routine';
  deadlineAt: string;
  minutesToDeadline: number;
  elapsedPct: number;
  stage: number;
  lastEscalatedAt: string | null;
  breached: boolean;
  holder: { studyId: number; userId: number; name: string; state: string } | null;
};

export type BlockedCase = {
  studyId: number;
  tenantId: number;
  priority: 'stat' | 'urgent' | 'routine';
  modality: string | null;
  subSpecialty: string | null;
  waitingMinutes: number;
  escalationStage: number;
  elapsedPct: number | null;
  poolWidened: boolean;
  status: 'waiting_for_sweep' | 'blocked';
  blockedBecause: string | null;
  nearestReader: { userId: number; name: string; missing: string[] } | null;
};

export type ViewDescriptor = {
  ok: boolean;
  generatedAt: string;
  study: {
    id: number;
    accession: string | null;
    modality: string | null;
    subSpecialty: string | null;
    priority: string;
    studyDescription: string | null;
    studyDate: string | null;
    receivedAt: string;
    linkState: string;
    nodeState: string;
    patient: { name: string | null; mrn: string | null; gender: string | null; dob: string | null };
  };
  held: { assignmentId: number; state: string } | null;
  // Present when a reader may see this study without holding it: either a signed report is
  // waiting for their second name, or the report on it is their own. A reviewer holds no
  // assignment — routing keeps exactly one live lock per study — and signing completes the
  // read, so without this an author could not look again at what they described.
  reportAccess: {
    reportId: number; version: number; state: ReportState; author: number;
    as: 'author' | 'review' | 'read';
  } | null;
  series: {
    index: number;
    pk: string;
    uid: string | null;
    description: string | null;
    modality: string | null;
    bodyPart: string | null;
    count: number;
    instances: string[];
  }[];
  windowing: 'client';
  pixelFormat: 'int16-le';
};

export type ViewInstance = {
  ok: boolean;
  instanceId: string;
  rows: number | null;
  columns: number | null;
  bitsStored: number | null;
  bitsAllocated: number | null;
  pixelRepresentation: number;
  photometric: string | null;
  windowCenter: string | null;
  windowWidth: string | null;
  rescaleSlope: number | null;
  rescaleIntercept: number | null;
  instanceNumber: number | null;
  sliceLocation: number | null;
  pixelSpacing: string | null;
  seriesDescription: string | null;
  contentDate: string | null;
  patientOrientation: string | null;
};

export type ReportState = 'draft' | 'signed' | 'verified' | 'delivered' | 'amended' | 'withdrawn';

export type ReportSection =
  'clinicalHistory' | 'technique' | 'findings' | 'impression' | 'recommendation';

export type ReportView = {
  id: number;
  studyId: number;
  version: number;
  state: ReportState;
  sections: Partial<Record<ReportSection, string>>;
  author: { userId: number; name: string; registration: string };
  reviewer: { userId: number; name: string | null; registration: string | null } | null;
  signedAt: string | null;
  verifiedAt: string | null;
  deliveredAt: string | null;
  supersedesReportId: number | null;
  supersedesVersion: number | null;
  // Which later version replaced this one, when it was superseded. The row itself only
  // points backwards, so the screen needs the forward link to say "v1, replaced by v2".
  supersededByVersion: number | null;
  amendmentReason: string | null;
  createdAt: string;
  gaps: ReportSection[];
  // The server's own answer about what this reader may do to this document, so the panel
  // cannot offer a button the route is going to refuse. `deliver` is role-gated: releasing
  // the report to the clinic is a desk act, not a reading act.
  can: {
    edit: boolean; sign: boolean; countersign: boolean; amend: boolean; withdraw: boolean;
    deliver: boolean; download: boolean; showDelivery: boolean;
  };
  delivery: {
    channel: 'portal';
    recipient: string;
    // The refusal the desk would get, so the button can be labelled with its reason instead
    // of being hidden — a row that silently has no button is a row nobody chases.
    decision: string | null;
    pdfSha256: string | null;
  };
  history: {
    id: number; version: number; state: ReportState; authorName: string;
    supersedesReportId: number | null;
    signedAt: string | null; verifiedAt: string | null;
  }[];
  study: {
    accession: string | null; modality: string | null; subSpecialty: string | null;
    priority: string | null; studyDate: string | null; tenantCode: string | null;
    centreName: string | null; requiresReviewer: boolean; needsSecondName: boolean;
  };
  patient: {
    name: string | null; mrn: string | null; dob: string | null;
    age: string | null; gender: string | null;
  };
};

export type MyReportItem = {
  reportId: number;
  studyId: number;
  version: number;
  state: ReportState;
  accession: string | null;
  modality: string | null;
  subSpecialty: string | null;
  patientName: string | null;
  signedAt: string | null;
  verifiedAt: string | null;
  reviewerName: string | null;
  amendmentReason: string | null;
  tenantCode: string | null;
};

export type ReviewItem = {
  reportId: number;
  studyId: number;
  version: number;
  authorName: string;
  authorGrade: string | null;
  signedAt: string | null;
  accession: string | null;
  modality: string | null;
  requiresReviewer: boolean | null;
  mayClear: boolean;
  reason: string | null;
};

// The desk's list. Every row carries the reason it is still here, which is the whole
// point: "signed and waiting for a second name" and "signed, ready to go" look identical
// to a center until someone says so.
export type DeliveryItem = {
  reportId: number;
  studyId: number;
  version: number;
  state: ReportState;
  signedAt: string | null;
  verifiedAt: string | null;
  reviewerUserId: number | null;
  accession: string | null;
  modality: string | null;
  subSpecialty: string | null;
  priority: string | null;
  requiresReviewer: boolean | null;
  patientName: string | null;
  patientMrn: string | null;
  referringName: string | null;
  tenantCode: string | null;
  deliverable: boolean;
  reason: string | null;
  needsSecondName: boolean;
};

export const api = {
  session: () => call<Session>('/v1/auth/session'),
  login: (email: string, password: string) =>
    call<Session>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => call<{ ok: boolean }>('/v1/auth/logout', { method: 'POST', body: '{}' }),
  heartbeat: () =>
    call<{ color: PresenceColor; code: string; label: string; routable: boolean; openCases: number; maxQueueSize: number }>(
      '/v1/presence/heartbeat', { method: 'POST', body: '{}' }),
  declare: (state: string) =>
    call<{ ok: boolean; state: string }>('/v1/presence', { method: 'PATCH', body: JSON.stringify({ state }) }),
  panel: () => call<Panel>('/v1/panel'),
  myWork: () => call<{ cases: WorkCase[]; offerWindowSeconds: number }>('/v1/my/work'),
  accept: (id: number) =>
    call<{ ok: boolean; studyId: number; lockToken: string }>(`/v1/assignments/${id}/accept`, { method: 'POST', body: '{}' }),
  decline: (id: number, reason: string) =>
    call<{ ok: boolean; studyId: number }>(`/v1/assignments/${id}/decline`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  escalations: () =>
    call<{ late: LateCase[]; counts: { open: number; late: number; breached: number; unheld: number } }>(
      '/v1/escalations'),
  blocked: () =>
    call<{ unassigned: BlockedCase[]; counts: { unassigned: number; blocked: number } }>('/v1/dispatch/unassigned'),
  view: (studyId: number) => call<ViewDescriptor>(`/v1/view/${studyId}`),
  viewInstance: (studyId: number, pk: string) =>
    call<ViewInstance>(`/v1/view/${studyId}/instances/${encodeURIComponent(pk)}`),
  // Pixels, not JSON: a 16-bit frame is two bytes a pixel and a study is hundreds of
  // frames, so the base of the image arrives as the bytes the node measured.
  viewFrame: (studyId: number, pk: string, index: number) => frame(studyId, pk, index),
  report: (id: number) => call<{ report: ReportView }>(`/v1/reports/${id}`),
  // A study with no report answers 404 `no_report`, which is the normal state of a case
  // that has just been accepted, so the caller asks rather than catches.
  reportFor: async (studyId: number): Promise<ReportView | null> => {
    try {
      return (await call<{ report: ReportView }>(`/v1/reports/current?studyId=${studyId}`)).report;
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'no_report' || err.code === 'not_found')) return null;
      throw err;
    }
  },
  startReport: (studyId: number) =>
    call<{ report: ReportView }>('/v1/reports', { method: 'POST', body: JSON.stringify({ studyId }) }),
  saveReport: (id: number, sections: Partial<Record<ReportSection, string>>) =>
    call<{ report: ReportView }>(`/v1/reports/${id}`, { method: 'PATCH', body: JSON.stringify({ sections }) }),
  signReport: (id: number) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/sign`, { method: 'POST', body: '{}' }),
  countersignReport: (id: number) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/countersign`, { method: 'POST', body: '{}' }),
  amendReport: (id: number, reason: string) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/amend`, { method: 'POST', body: JSON.stringify({ reason }) }),
  withdrawReport: (id: number) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/withdraw`, { method: 'POST', body: '{}' }),
  awaitingReview: () =>
    call<{ generatedAt: string; myGrade: string | null; awaiting: ReviewItem[] }>('/v1/reports/awaiting-review'),
  myReports: () => call<{ generatedAt: string; reports: MyReportItem[] }>('/v1/reports/mine'),
  deliverReport: (id: number) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/deliver`, { method: 'POST', body: '{}' }),
  awaitingDelivery: () => call<{
    generatedAt: string; counts: { total: number; ready: number }; awaiting: DeliveryItem[];
  }>('/v1/reports/awaiting-delivery'),
  // Not a fetch: the browser takes the bytes and honours the Content-Disposition the route
  // sets, so the filename is decided by the server that knows the accession.
  pdfHref: (id: number) => `/v1/reports/${id}/pdf`,
};

async function frame(studyId: number, pk: string, index: number): Promise<ArrayBuffer> {
  const res = await fetch(`/v1/view/${studyId}/instances/${encodeURIComponent(pk)}/frames/${index}`, {
    credentials: 'same-origin',
  });
  if (!res.ok) {
    // The failure is JSON even though success is not, because "no pixels in this frame"
    // has to reach the reader as a reason and not as a black square.
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* an html error page */ }
    throw new ApiError(res.status, String(body.error ?? res.statusText), String(body.error ?? ''));
  }
  return await res.arrayBuffer();
}
