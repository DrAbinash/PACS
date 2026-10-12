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
  actionNeeded: boolean;
  actionNeededMessage: string | null;
  gaps: ReportSection[];
  // The server's own answer about what this reader may do to this document, so the panel
  // cannot offer a button the route is going to refuse. `deliver` is role-gated: releasing
  // the report to the clinic is a desk act, not a reading act.
  can: {
    edit: boolean; sign: boolean; countersign: boolean; amend: boolean; withdraw: boolean;
    deliver: boolean; download: boolean; showDelivery: boolean; declareCritical: boolean;
  };
  delivery: {
    channel: 'portal';
    recipient: string;
    // The refusal the desk would get, so the button can be labelled with its reason instead
    // of being hidden — a row that silently has no button is a row nobody chases.
    decision: string | null;
    pdfSha256: string | null;
    openCriticals: number;
    // One row per channel this version was released on, with what the queue thinks about it.
    outbox: OutboxRow[];
  };
  // The critical loops on this study, in whatever state the server just computed them in.
  // The report panel and the desk board read the same object.
  criticals: CriticalItem[];
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

// The critical-finding loop as the server states it. `state` and `minutesLeft` are computed
// per read, so a board that has not been refreshed in an hour cannot show a waiting row as
// still waiting once its window has run out — the refresh interval is the only thing between
// this and a lie.
export type CriticalState = 'acknowledged' | 'waiting' | 'breached';

export type CriticalItem = {
  id: number;
  studyId: number;
  reportId: number | null;
  conditionCode: string;
  detail: string | null;
  /** The catalogue label with the reader's own words after it — what the board prints. */
  text: string;
  detectedByName: string | null;
  notifiedAt: string | null;
  channel: string | null;
  receiverName: string | null;
  receiverRole: string | null;
  receiverPhone: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  slaMinutes: number;
  breached: boolean;
  deadlineAt: string;
  state: CriticalState;
  minutesLeft: number | null;
  late: boolean;
  mayAcknowledge: boolean;
  accession: string | null;
  patientName: string | null;
  modality: string | null;
};

export type CriticalCondition = { code: string; label: string; slaMinutes: number };

// One queued notice. `sent` means a mail relay took the message — not that a human read it,
// which is the distinction the whole notification design rests on.
export type OutboxRow = {
  id: number;
  channel: 'portal' | 'email' | 'whatsapp' | 'hl7' | 'pdf_link';
  recipient: string;
  status: 'pending' | 'sent' | 'failed' | 'dead';
  attemptNo: number;
  nextAttemptAt: string | null;
  sentAt: string | null;
  errorCode: string | null;
};

export type NoticeItem = OutboxRow & {
  reportId: number;
  studyId: number;
  version: number;
  state: ReportState;
  accession: string | null;
  tenantCode: string | null;
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
  openCriticals: number;
};

export type Invoice = {
  id: number;
  number: string;
  status: 'draft' | 'issued';
  periodStart: string;
  periodEnd: string;
  grossPaise: number;
  taxPaise: number;
  totalPaise: number;
  totalRupees: string;
  issuedAt: string | null;
  lineCount: number;
};

export type InvoiceLine = {
  id: number;
  studyId: number;
  description: string;
  modalityCode: string | null;
  tariffCode: string | null;
  quantity: number;
  unitPaise: number;
  night: boolean;
  amountPaise: number;
};

export type InvoiceDetail = {
  invoice: Invoice;
  lines: InvoiceLine[];
};

export type PreviewLine = {
  studyId: number;
  description: string;
  modalityCode: string | null;
  tariffCode: string | null;
  quantity: number;
  unitPaise: number;
  night: boolean;
  amountPaise: number;
};

export type PreviewResult = {
  ok: boolean;
  periodStart: string;
  periodEnd: string;
  lines: PreviewLine[];
  unpriced: { studyId: number; reason: string }[];
  grossPaise: number;
  taxPaise: number;
  totalPaise: number;
  totalRupees: string;
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
  // Up to 50 offers in one go: a reader coming back from a break should not click through
  // the backlog one accept at a time, and each accept is still audited on its own row.
  bulkAccept: (ids: number[]) =>
    call<{ ok: boolean; accepted: number; failed: number; results: { id: number; ok: boolean; error?: string }[] }>(
      '/v1/assignments/bulk-accept', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkAssign: (studyIds: number[], clinicianUserId: number) =>
    call<{ ok: boolean; assigned: number; failed: number; results: { studyId: number; ok: boolean; error?: string }[] }>(
      '/v1/assignments/bulk-assign', { method: 'POST', body: JSON.stringify({ studyIds, clinicianUserId }) }),
  accept: (id: number) =>
    call<{ ok: boolean; studyId: number; lockToken: string }>(`/v1/assignments/${id}/accept`, { method: 'POST', body: '{}' }),
  decline: (id: number, reason: string) =>
    call<{ ok: boolean; studyId: number }>(`/v1/assignments/${id}/decline`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),
  escalations: () =>
    call<{
      late: LateCase[];
      counts: { open: number; late: number; breached: number; unheld: number; reviewWaiting: number };
      reviewWaiting: {
        reportId: number; studyId: number; tenant: string | null; accession: string | null;
        modality: string | null; subSpecialty: string | null; signedAt: string | null;
        authorName: string; waitingMinutes: number | null;
      }[];
    }>('/v1/escalations'),
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
    generatedAt: string;
    counts: { total: number; ready: number; blockedByCritical: number };
    awaiting: DeliveryItem[];
  }>('/v1/reports/awaiting-delivery'),
  criticals: (studyId?: number) => call<{
    generatedAt: string; counts: { open: number; breached: number }; criticals: CriticalItem[];
  }>(`/v1/criticals${studyId === undefined ? '' : `?studyId=${studyId}`}`),
  criticalCatalogue: () =>
    call<{ conditions: CriticalCondition[]; channels: string[] }>('/v1/criticals/catalogue'),
  // A declaration is made by the reader who found the thing, and it is not a note on the
  // report: it is a second gate on the document, so the response says so rather than letting
  // the desk discover it as a refusal two clicks later.
  declareCritical: (input: {
    studyId: number; condition: string; channel: string; detail?: string | null;
    receiverName: string; receiverRole?: string | null; receiverPhone?: string | null;
  }) => call<{ critical: CriticalItem; blocksDelivery: boolean }>('/v1/criticals', {
    method: 'POST', body: JSON.stringify(input),
  }),
  ackCritical: (id: number, acknowledgedByName: string, acknowledgedByRole?: string | null) =>
    call<{ critical: CriticalItem; openForStudy: number }>(`/v1/criticals/${id}/ack`, {
      method: 'POST', body: JSON.stringify({ acknowledgedByName, acknowledgedByRole }),
    }),
  // What the queue still holds: notices that have not reached a relay. `dead` rows sit here
  // until a person notices them, which is the point of the board rather than a bug in it.
  notices: () => call<{
    generatedAt: string;
    counts: { queued: number; dead: number };
    outbox: NoticeItem[];
  }>('/v1/reports/outbox'),
  // Not a fetch: the browser takes the bytes and honours the Content-Disposition the route
  // sets, so the filename is decided by the server that knows the accession.
  pdfHref: (id: number) => `/v1/reports/${id}/pdf`,

  // Billing: the operator's view of what the center earned and what the clinic owes.
  invoices: (tenantId: number) =>
    call<{ ok: boolean; invoices: Invoice[] }>(`/v1/billing/invoices?tenantId=${tenantId}`),
  invoice: (id: number) =>
    call<{ ok: boolean; invoice: Invoice; lines: InvoiceLine[] }>(`/v1/billing/invoices/${id}`),
  previewBilling: (tenantId: number, periodStart: string, periodEnd: string) =>
    call<PreviewResult>('/v1/billing/preview', {
      method: 'POST',
      body: JSON.stringify({ tenantId, periodStart, periodEnd }),
    }),
  createInvoice: (tenantId: number, periodStart: string, periodEnd: string) =>
    call<{ ok: boolean; invoice: Invoice; lines: InvoiceLine[] }>('/v1/billing/invoices', {
      method: 'POST',
      body: JSON.stringify({ tenantId, periodStart, periodEnd }),
    }),
  issueInvoice: (id: number) =>
    call<{ ok: boolean; invoice: Invoice }>(`/v1/billing/invoices/${id}/issue`, {
      method: 'POST',
      body: '{}',
    }),
  deleteInvoice: (id: number) =>
    call<{ ok: boolean; dropped: boolean }>(`/v1/billing/invoices/${id}`, { method: 'DELETE' }),
  invoiceCsvHref: (id: number) => `/v1/billing/invoices/${id}/export.csv`,

  // Action-needed flag: the desk marking a report as needing clinic attention before release.
  setActionNeeded: (id: number, message?: string) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/action-needed`, {
      method: 'POST', body: JSON.stringify({ set: true, message: message ?? null }),
    }),
  clearActionNeeded: (id: number) =>
    call<{ report: ReportView }>(`/v1/reports/${id}/action-needed`, {
      method: 'POST', body: JSON.stringify({ set: false }),
    }),

  // A rating the desk leaves on a delivered report. One per report, updatable.
  rateReport: (id: number, rating: number, comment?: string) =>
    call<{ ok: boolean; reportId: number; rating: number; comment: string | null }>(
      `/v1/reports/${id}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating, comment: comment ?? null }),
      }),

  // Prepaid balance: what the center has credit for, and adding to it.
  billingBalance: (tenantId: number) =>
    call<{
      ok: boolean; tenantId: number; tenantCode: string; tenantName: string;
      balancePaise: number; balanceRupees: string;
    }>(`/v1/billing/balance?tenantId=${tenantId}`),
  billingTopup: (tenantId: number, amountRupees: number, method?: string, reference?: string) =>
    call<{
      ok: boolean; tenantId: number; amountPaise: number; amountRupees: string;
      method: string; reference: string | null;
      newBalancePaise: number; newBalanceRupees: string;
    }>('/v1/billing/topup', {
      method: 'POST',
      body: JSON.stringify({ tenantId, amountRupees, method: method ?? 'upi', reference: reference ?? null }),
    }),

  // Reader performance: who is carrying weight, over a window the desk chooses.
  performance: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    return call<{ ok: boolean; from: string; to: string; readers: ReaderPerf[] }>(
      `/v1/performance/readers${qs ? `?${qs}` : ''}`);
  },

  slaTargets: () =>
    call<{ ok: boolean; targets: SlaTarget[] }>('/v1/sla/targets'),
  createSlaTarget: (input: { modalityCode: string; priority: string; slaMinutes: number; tenantId?: number }) =>
    call<{ ok: boolean; target: SlaTarget }>('/v1/sla/targets', {
      method: 'POST', body: JSON.stringify(input),
    }),
  deactivateSlaTarget: (id: number) =>
    call<{ ok: boolean }>(`/v1/sla/targets/${id}`, { method: 'DELETE' }),

  filmExports: () =>
    call<{ ok: boolean; exports: FilmExport[] }>('/v1/film/exports'),
  createFilmExport: (studyId: number, medium: string, quantity: number) =>
    call<{ ok: boolean; filmExportId: number; unitPaise: number; totalPaise: number }>(
      '/v1/film/exports', { method: 'POST', body: JSON.stringify({ studyId, medium, quantity }) }),

  auditLatest: () =>
    call<{ ok: boolean; entries: AuditEntry[] }>('/v1/audit/latest'),
  auditExportHref: (format: 'csv' | 'json') =>
    `/v1/audit/export?format=${format}`,
};

export type ReaderPerf = {
  userId: number;
  name: string;
  offered: number;
  accepted: number;
  declined: number;
  completed: number;
  acceptanceRate: number;
  avgAcceptSeconds: number | null;
  avgReadSeconds: number | null;
  studiesPerDay: number;
};

export type SlaTarget = {
  id: number;
  tenantId: number;
  modalityCode: string;
  priority: 'stat' | 'urgent' | 'routine';
  slaMinutes: number;
  effectiveFrom: string;
  effectiveTo: string | null;
};

export type FilmExport = {
  id: number;
  studyId: number;
  medium: string;
  quantity: number;
  unitPaise: number;
  totalPaise: number;
  requestedByName: string;
  patientName: string | null;
  studyDescription: string | null;
  exportedAt: string;
};

export type AuditEntry = {
  id: number;
  action: string;
  entity: string;
  entityId: string;
  actorUserId: number | null;
  occurredAt: string;
  rowHash: string;
  prevHash: string;
  detail?: unknown;
};

export type FrameBytes = {
  // A numeric frame is a little-endian sample array the browser windows itself; a JPEG
  // frame is a finished image the node stored but cannot decode.
  format: 'int16-le' | 'jpeg';
  bytes: ArrayBuffer;
};

async function frame(studyId: number, pk: string, index: number): Promise<FrameBytes> {
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
  const format = res.headers.get('X-Telrad-Pixel-Format') === 'jpeg' ? 'jpeg' as const : 'int16-le' as const;
  return { format, bytes: await res.arrayBuffer() };
}
