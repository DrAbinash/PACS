import { sql } from 'drizzle-orm';
import {
  bigint, boolean, char, check, index, integer, jsonb, numeric, pgSchema,
  smallint, text, timestamp, uniqueIndex,
} from 'drizzle-orm/pg-core';

// One schema, never `public`, so a shared Postgres instance cannot be confused
// with another product's tables and so `search_path` is an enforceable boundary.
export const telrad = pgSchema('telrad');

const at = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' }).notNull().defaultNow();

// Every clinical row carries tenant_id. Reads are joined through it by the api,
// and a query that cannot name a tenant is a bug rather than a feature.
const tenantId = integer('tenant_id').notNull();

export const storageNodes = telrad.table('storage_nodes', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  dicomAet: text('dicom_aet'),
  dicomPort: integer('dicom_port'),
  role: text('role', { enum: ['ingest', 'archive', 'relay'] }).notNull().default('ingest'),
  state: text('state', { enum: ['active', 'draining', 'read_only', 'retired'] }).notNull().default('active'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
  createdAt: at('created_at'),
});

export const tenants = telrad.table('tenants', {
  id: serialId('id'),
  code: text('code').notNull(),
  legalName: text('legal_name').notNull(),
  billingName: text('billing_name'),
  country: text('country').notNull().default('IN'),
  stateCode: text('state_code'),
  gstin: text('gstin'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  status: text('status', { enum: ['trial', 'active', 'suspended', 'terminated'] }).notNull().default('trial'),
  trialExpiresAt: timestamp('trial_expires_at', { withTimezone: true, mode: 'date' }),
  // The contract term and the exit obligation live on the tenant, not in a note
  // elsewhere: retention pricing and the right of a center to walk away with its
  // own images are the same decision, and separating them is how a vendor ends up
  // holding a customer's archive hostage.
  agreementStartsOn: timestamp('agreement_starts_on', { withTimezone: false, mode: 'date' }),
  agreementEndsOn: timestamp('agreement_ends_on', { withTimezone: false, mode: 'date' }),
  exitExportObligated: boolean('exit_export_obligated').notNull().default(true),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  signatureLine: text('signature_line'),
  prepaidBalancePaise: integer('prepaid_balance_paise').notNull().default(0),
  createdAt: at('created_at'),
}, (t) => ({
  codeUq: uniqueIndex('tenants_code_uq').on(t.code),
}));

export const tenantSites = telrad.table('tenant_sites', {
  id: serialId('id'),
  tenantId: integer('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  aeTitle: text('ae_title'),
  allowedCidrs: jsonb('allowed_cidrs').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  defaultModality: text('default_modality'),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  createdAt: at('created_at'),
}, (t) => ({
  aeUq: uniqueIndex('tenant_sites_ae_uq').on(t.aeTitle).where(sql`${t.aeTitle} IS NOT NULL`),
  tenantIdx: index('tenant_sites_tenant_idx').on(t.tenantId),
}));

export const users = telrad.table('users', {
  id: serialId('id'),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', {
    enum: ['owner', 'console', 'center_staff', 'radiologist', 'reviewer', 'typist'],
  }).notNull(),
  tenantId: integer('tenant_id').references(() => tenants.id),
  passwordHash: text('password_hash'),
  passwordAlgo: text('password_algo'),
  status: text('status', { enum: ['invited', 'active', 'locked', 'disabled'] }).notNull().default('invited'),
  failedAttempts: smallint('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'date' }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
  createdAt: at('created_at'),
}, (t) => ({
  emailUq: uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
}));

export const sessions = telrad.table('sessions', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  createdAt: at('created_at'),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => ({
  tokenUq: uniqueIndex('sessions_token_uq').on(t.tokenHash),
}));

// Tamper-evident, not merely append-only: each row chains the previous hash, so a
// silent edit breaks the chain at a computable point. Retention floor is 180 days
// because that is the number the imaging-qc guidance this design borrows from
// requires an operator to be able to answer a query about.
export const auditLog = telrad.table('audit_log', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  actorUserId: integer('actor_user_id').references(() => users.id),
  actorKind: text('actor_kind', { enum: ['human', 'service', 'system'] }).notNull(),
  tenantId: integer('tenant_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  detail: jsonb('detail'),
  occurredAt: at('occurred_at'),
  prevHash: char('prev_hash', { length: 64 }),
  rowHash: char('row_hash', { length: 64 }),
}, (t) => ({
  entityIdx: index('audit_entity_idx').on(t.entity, t.entityId),
  tenantTimeIdx: index('audit_tenant_time_idx').on(t.tenantId, t.occurredAt),
}));

// Machine credentials for the two upload channels. Stored hashed and scoped to a
// site, because a single shared key that can write to every center's queue is the
// mistake `care-erp-sync` made with the literal "1234".
export const apiTokens = telrad.table('api_tokens', {
  id: serialId('id'),
  tenantId: integer('tenant_id').notNull().references(() => tenants.id),
  siteId: integer('site_id').references(() => tenantSites.id),
  label: text('label').notNull(),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default(sql`'["upload"]'::jsonb`),
  createdAt: at('created_at'),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
}, (t) => ({
  hashUq: uniqueIndex('api_tokens_hash_uq').on(t.tokenHash),
}));

// A batch is the unit a center thinks in: "the 14:20 spine case, 312 files". File
// rows alone cannot answer whether a study arrived whole, which is the question an
// incomplete upload turns into.
export const uploadBatches = telrad.table('upload_batches', {
  id: text('id').primaryKey(),
  tenantId: integer('tenant_id').references(() => tenants.id),
  siteId: integer('site_id').references(() => tenantSites.id),
  channel: text('channel', { enum: ['agent', 'browser'] }).notNull(),
  accessionHint: text('accession_hint'),
  patientHint: text('patient_hint'),
  modalityHint: text('modality_hint'),
  studyDateHint: text('study_date_hint'),
  status: text('status', {
    enum: ['open', 'sealed', 'processing', 'ingested', 'partial', 'rejected'],
  }).notNull().default('open'),
  filesExpected: integer('files_expected'),
  bytesDeclared: bigint('bytes_declared', { mode: 'number' }),
  bytesReceived: bigint('bytes_received', { mode: 'number' }).notNull().default(0),
  createdAt: at('created_at'),
  sealedAt: timestamp('sealed_at', { withTimezone: true, mode: 'date' }),
  processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  lastError: text('last_error'),
  attempts: smallint('attempts').notNull().default(0),
}, (t) => ({
  statusIdx: index('upload_batches_status_idx').on(t.status, t.createdAt),
}));

export const subSpecialties = telrad.table('sub_specialties', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  defaultPriority: text('default_priority', { enum: ['stat', 'urgent', 'routine'] }).notNull().default('routine'),
  defaultSlaMinutes: integer('default_sla_minutes').notNull().default(1440),
  requiresReviewer: boolean('requires_reviewer').notNull().default(true),
});

export const modalities = telrad.table('modalities', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  typicalBytes: bigint('typical_bytes', { mode: 'number' }),
});

// A clinician may only be assigned, or may only countersign, work their
// registration and grade cover. stateCodes is what a cross-state read turns on:
// nothing in this column is a legal opinion, it is an operator-maintained record
// of what the certificate says, and the guard test refuses an empty list.
export const clinicianProfiles = telrad.table('clinician_profiles', {
  userId: integer('user_id').primaryKey().references(() => users.id),
  registrationCouncil: text('registration_council').notNull(),
  registrationNumber: text('registration_number').notNull(),
  stateCodes: jsonb('state_codes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  grade: text('grade', { enum: ['junior', 'senior', 'chief'] }).notNull().default('junior'),
  subspecialtyCodes: jsonb('sub_specialty_codes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  modalityCodes: jsonb('modality_codes').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  maxQueueSize: smallint('max_queue_size').notNull().default(5),
  acceptsNight: boolean('accepts_night').notNull().default(false),
  reportLanguage: text('report_language').notNull().default('en'),
  payoutTierId: integer('payout_tier_id'),
  createdAt: at('created_at'),
});

export const readerAvailability = telrad.table('reader_availability', {
  userId: integer('user_id').primaryKey().references(() => users.id),
  state: text('state', { enum: ['receiving', 'paused', 'away', 'offline'] }).notNull().default('offline'),
  sinceAt: at('since_at'),
  // The heartbeat, kept separate from `state` because they answer different
  // questions: state is what the reader declared, last_seen_at is whether their
  // browser is still proving it. Green needs both.
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
  note: text('note'),
});

export const rosters = telrad.table('rosters', {
  id: serialId('id'),
  userId: integer('user_id').notNull().references(() => users.id),
  tenantId: integer('tenant_id').references(() => tenants.id),
  startsAt: timestamp('starts_at', { withTimezone: true, mode: 'date' }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true, mode: 'date' }).notNull(),
  kind: text('kind', { enum: ['day', 'night', 'on_call', 'clinically_awake'] }).notNull(),
  subspecialtyCodes: jsonb('sub_specialty_codes').$type<string[]>(),
  weight: smallint('weight').notNull().default(1),
  status: text('status', { enum: ['scheduled', 'active', 'cancelled'] }).notNull().default('scheduled'),
}, (t) => ({
  windowIdx: index('rosters_window_idx').on(t.startsAt, t.endsAt),
}));

export const patients = telrad.table('patients', {
  id: serialId('id'),
  tenantId: tenantId,
  mrn: text('mrn').notNull(),
  fullName: text('full_name').notNull(),
  gender: text('gender', { enum: ['M', 'F', 'X', 'U'] }).notNull().default('U'),
  dob: timestamp('dob', { withTimezone: false, mode: 'date' }),
  ageText: text('age_text'),
  phone: text('phone'),
  abdmAbhaId: text('abdm_abha_id'),
  createdAt: at('created_at'),
}, (t) => ({
  // Patient identity is per-tenant. Two centers' "Ramesh Kumar" are never merged,
  // because a cross-tenant merge would leak one center's history to the other.
  mrnUq: uniqueIndex('patients_tenant_mrn_uq').on(t.tenantId, t.mrn),
}));

export const orders = telrad.table('orders', {
  id: serialId('id'),
  tenantId: tenantId,
  siteId: integer('site_id').references(() => tenantSites.id),
  accessionNumber: text('accession_number').notNull(),
  patientId: integer('patient_id').references(() => patients.id),
  modalityCode: text('modality_code').references(() => modalities.code),
  bodyPartCode: text('body_part_code'),
  subSpecialtyCode: text('sub_specialty_code').references(() => subSpecialties.code),
  priority: text('priority', { enum: ['stat', 'urgent', 'routine'] }).notNull().default('routine'),
  clinicalIndication: text('clinical_indication'),
  referringName: text('referring_name'),
  referringPhone: text('referring_phone'),
  referringRegistration: text('referring_registration'),
  // The address a "your report is ready" message can be sent to. Nullable, and nullable on
  // purpose: a center that faxes or collects on the doorstep has one, and inventing an address
  // to satisfy a column is how a notice ends up in somebody else's inbox.
  referringEmail: text('referring_email'),
  studyDescription: text('study_description'),
  // Scheduled date is what the ingest candidate window should really use. Until
  // order entry collects it, apps/worker/store.ts falls back to ordered_at and says
  // so in a comment.
  scheduledDate: timestamp('scheduled_date', { withTimezone: false, mode: 'date' }),
  orderedAt: at('ordered_at'),
  status: text('status', { enum: ['open', 'scheduled', 'completed', 'cancelled'] }).notNull().default('open'),
  source: text('source', { enum: ['console', 'portal', 'api', 'hl7'] }).notNull().default('console'),
}, (t) => ({
  accUq: uniqueIndex('orders_tenant_accession_uq').on(t.tenantId, t.accessionNumber),
}));

export const studies = telrad.table('studies', {
  id: serialId('id'),
  // Location indirection: a study is identified by (node, that node's own primary
  // key). Moving images from the NAS to a cloud node is a row update here plus a
  // bulk copy — not a rewrite of clinical history, which is the property that
  // makes the first-customer migration a maintenance task. `node_pk` is opaque by
  // design: an Orthanc UUID today, whatever the next node calls it tomorrow.
  storageNodeId: text('storage_node_id').notNull().references(() => storageNodes.id),
  nodePk: text('node_pk'),
  // Not null, and uniqueness below depends on it: an instance row arriving with
  // no StudyInstanceUID is filed under a synthetic key and flagged, because two
  // NULL uids would not collide and would let the same study be filed twice.
  studyInstanceUid: text('study_instance_uid').notNull(),
  // Nullable by necessity: a study from an unknown AE title belongs to no tenant
  // yet, and inventing one would file it against a real center. Those rows land in
  // the orphan queue carrying quality_flags 'site_unresolved'.
  tenantId: integer('tenant_id').references(() => tenants.id),
  siteId: integer('site_id').references(() => tenantSites.id),
  orderId: integer('order_id').references(() => orders.id),
  patientId: integer('patient_id').references(() => patients.id),
  accessionNumber: text('accession_number'),
  // The date the modality wrote into the file, kept verbatim as DICOM YYYYMMDD.
  // receivedAt is when *we* stored it, which is a different fact and the wrong one
  // to score a patient match against.
  studyDate: text('study_date'),
  modalityCode: text('modality_code').references(() => modalities.code),
  subSpecialtyCode: text('sub_specialty_code').references(() => subSpecialties.code),
  studyDescription: text('study_description'),
  priority: text('priority', { enum: ['stat', 'urgent', 'routine'] }).notNull().default('routine'),
  linkState: text('link_state', {
    enum: ['linked', 'orphan', 'ambiguous', 'unlinked_read_only'],
  }).notNull().default('orphan'),
  matchMethod: text('match_method', { enum: ['accession', 'scored', 'manual', 'none'] }).notNull().default('none'),
  matchScore: numeric('match_score'),
  seriesCount: smallint('series_count'),
  instanceCount: integer('instance_count'),
  bytes: bigint('bytes', { mode: 'number' }),
  retentionTier: text('retention_tier', { enum: ['hot', 'online', 'archive', 'purged'] }).notNull().default('hot'),
  classification: jsonb('classification'),
  receivedAt: at('received_at'),
  linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }),
  qualityFlags: jsonb('quality_flags').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
}, (t) => ({
  nodeUq: uniqueIndex('studies_node_uid_uq').on(t.storageNodeId, t.studyInstanceUid),
  queueIdx: index('studies_queue_idx').on(t.tenantId, t.linkState, t.priority, t.receivedAt),
  tierIdx: index('studies_retention_idx').on(t.retentionTier, t.receivedAt),
}));

export const ingestCursors = telrad.table('ingest_cursors', {
  // The cursor is the whole continuity story: a worker that crashes mid-poll must
  // resume from the stored touchstone instead of rescanning or, worse, skipping.
  storageNodeId: text('storage_node_id').primaryKey().references(() => storageNodes.id),
  since: text('since'),
  instancesSeen: bigint('instances_seen', { mode: 'number' }).notNull().default(0),
  lastRunAt: timestamp('last_run_at', { withTimezone: true, mode: 'date' }),
  lastError: text('last_error'),
  lastErrorAt: timestamp('last_error_at', { withTimezone: true, mode: 'date' }),
});

export const ingestEvents = telrad.table('ingest_events', {
  id: bigint('id', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  studyId: integer('study_id').references(() => studies.id),
  kind: text('kind', {
    enum: ['received', 'classified', 'linked', 'orphaned', 'rejected', 'node_moved'],
  }).notNull(),
  detail: jsonb('detail'),
  occurredAt: at('occurred_at'),
}, (t) => ({
  studyIdx: index('ingest_events_study_idx').on(t.studyId, t.occurredAt),
}));

// One row per file inside a batch. `storedPath` is relative to the inbox root and
// is never a client-supplied string, which is the whole difference between a
// staging directory and a path-traversal hole.
export const uploadFiles = telrad.table('upload_files', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull().references(() => uploadBatches.id),
  filename: text('filename').notNull(),
  storedPath: text('stored_path').notNull(),
  bytes: bigint('bytes', { mode: 'number' }),
  sha256: text('sha256'),
  kind: text('kind', { enum: ['dcm', 'zip', 'non_dicom'] }).notNull().default('dcm'),
  status: text('status', {
    enum: ['received', 'stored', 'pushed', 'rejected', 'quarantined', 'duplicate'],
  }).notNull().default('received'),
  orthancInstanceId: text('orthanc_instance_id'),
  errorCode: text('error_code'),
  createdAt: at('created_at'),
  pushedAt: timestamp('pushed_at', { withTimezone: true, mode: 'date' }),
}, (t) => ({
  batchIdx: index('upload_files_batch_idx').on(t.batchId, t.status),
  batchFileUq: uniqueIndex('upload_files_batch_name_uq').on(t.batchId, t.filename),
}));

// The assignment row is the padlock. acceptedAt is set once, lockToken is
// presented on every read/submit, and a return always writes a reason — the
// three facts that make "who had this case and when" answerable without archaeology.
export const assignments = telrad.table('assignments', {
  id: serialId('id'),
  studyId: integer('study_id').notNull().references(() => studies.id),
  tenantId: tenantId,
  clinicianUserId: integer('clinician_user_id').notNull().references(() => users.id),
  state: text('state', {
    enum: ['offered', 'accepted', 'reading', 'returned', 'completed', 'reassigned'],
  }).notNull().default('offered'),
  lockToken: text('lock_token'),
  offeredAt: at('offered_at'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  returnedAt: timestamp('returned_at', { withTimezone: true, mode: 'date' }),
  returnReason: text('return_reason'),
  attemptNo: smallint('attempt_no').notNull().default(1),
  escalatedBy: integer('escalated_by').references(() => users.id),
}, (t) => ({
  // Exactly one live lock per study, for any non-terminal state.
  liveLockUq: uniqueIndex('assignments_live_lock_uq')
    .on(t.studyId)
    .where(sql`${t.state} IN ('offered','accepted','reading')`),
  openIdx: index('assignments_clinician_open_idx').on(t.clinicianUserId, t.state),
}));

export const slaClocks = telrad.table('sla_clocks', {
  id: serialId('id'),
  studyId: integer('study_id').notNull().references(() => studies.id),
  tenantId: tenantId,
  priority: text('priority', { enum: ['stat', 'urgent', 'routine'] }).notNull(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),
  signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  escalationStage: smallint('escalation_stage').notNull().default(0),
  lastEscalatedAt: timestamp('last_escalated_at', { withTimezone: true, mode: 'date' }),
  breached: boolean('breached').notNull().default(false),
  breachedAt: timestamp('breached_at', { withTimezone: true, mode: 'date' }),
}, (t) => ({
  studyUq: uniqueIndex('sla_clocks_study_uq').on(t.studyId),
  openIdx: index('sla_clocks_open_idx').on(t.breached, t.deadlineAt),
}));

export const escalationRules = telrad.table('escalation_rules', {
  id: serialId('id'),
  tenantId: integer('tenant_id').references(() => tenants.id),
  priority: text('priority', { enum: ['stat', 'urgent', 'routine'] }).notNull(),
  stage: smallint('stage').notNull(),
  // Stages are fractions of the SLA window, not absolute minutes, so widening the
  // contract does not require editing every timer.
  atElapsedPct: smallint('at_elapsed_pct').notNull(),
  action: text('action', {
    enum: ['widen_pool', 'alert_ops', 'manual_assign', 'notify_center'],
  }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
}, (t) => ({
  stageUq: uniqueIndex('escalation_rule_stage_uq').on(t.tenantId, t.priority, t.stage),
}));

export const reports = telrad.table('reports', {
  id: serialId('id'),
  studyId: integer('study_id').notNull().references(() => studies.id),
  tenantId: tenantId,
  version: smallint('version').notNull().default(1),
  state: text('state', {
    enum: ['draft', 'signed', 'verified', 'delivered', 'amended', 'withdrawn'],
  }).notNull().default('draft'),
  authorUserId: integer('author_user_id').notNull().references(() => users.id),
  reviewerUserId: integer('reviewer_user_id').references(() => users.id),
  sections: jsonb('sections').$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
  structured: jsonb('structured'),
  authorName: text('author_name').notNull(),
  authorRegistration: text('author_registration').notNull(),
  reviewerName: text('reviewer_name'),
  reviewerRegistration: text('reviewer_registration'),
  signedAt: timestamp('signed_at', { withTimezone: true, mode: 'date' }),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
  supersedesReportId: integer('supersedes_report_id'),
  amendmentReason: text('amendment_reason'),
  pdfSha256: text('pdf_sha256'),
  actionNeeded: boolean('action_needed').notNull().default(false),
  actionNeededMessage: text('action_needed_message'),
  createdAt: at('created_at'),
}, (t) => ({
  // An amendment is a new version, never an edit. The old row keeps its
  // signature pair so the audit question "who signed what on 14 March" is
  // answerable from data rather than from a log rotation that may have expired.
  versionUq: uniqueIndex('reports_version_uq').on(t.studyId, t.version),
  // Structural, not advisory: one name cannot both sign and countersign.
  notSelfReview: check('reports_not_self_review', sql`${t.authorUserId} <> ${t.reviewerUserId}`),
  stateIdx: index('reports_state_idx').on(t.tenantId, t.state, t.createdAt),
}));

// A rating is the site's answer to "was this report useful". One row per delivered report,
// so a radiologist's average is a real signal rather than a popularity contest. The desk
// submits it; the reader never rates themselves.
export const reportRatings = telrad.table('report_ratings', {
  id: serialId('id'),
  reportId: integer('report_id').notNull().references(() => reports.id),
  tenantId: tenantId,
  authorUserId: integer('author_user_id').notNull().references(() => users.id),
  rating: smallint('rating').notNull(),
  comment: text('comment'),
  createdAt: at('created_at'),
}, (t) => ({
  reportUq: uniqueIndex('report_ratings_report_uq').on(t.reportId),
}));

// The closed loop: a critical finding is not a notification until a named
// receiver has acknowledged it, and both signatures are stored. This is the one
// feature in the study set that neither the US nor the Indian products encode.
// `notified_at` is written by the server at declaration and never taken from the
// caller, `acknowledged_at` by the desk, and an unacknowledged row holds the
// report undelivered (`deliverDecision` in `@telrad/shared`) until it is answered.
export const criticalEvents = telrad.table('critical_events', {
  id: serialId('id'),
  studyId: integer('study_id').notNull().references(() => studies.id),
  reportId: integer('report_id').references(() => reports.id),
  tenantId: tenantId,
  conditionCode: text('condition_code').notNull(),
  // The reader's own words. Required when `condition_code` is `other`, and kept beside the
  // catalogue label the whole time otherwise: the closed list decides the SLA, and this is
  // what the finding actually was.
  detail: text('detail'),
  detectedByUserId: integer('detected_by_user_id').references(() => users.id),
  detectedAt: at('detected_at'),
  notifiedAt: timestamp('notified_at', { withTimezone: true, mode: 'date' }),
  channel: text('channel', { enum: ['phone', 'sms', 'whatsapp', 'portal', 'email'] }),
  receiverName: text('receiver_name'),
  receiverRole: text('receiver_role'),
  receiverPhone: text('receiver_phone'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
  acknowledgedByName: text('acknowledged_by_name'),
  acknowledgedByUserId: integer('acknowledged_by_user_id').references(() => users.id),
  slaMinutes: smallint('sla_minutes').notNull().default(10),
  breached: boolean('breached').notNull().default(false),
}, (t) => ({
  // Both board questions are open-loop questions, and both are asked oldest-first by the
  // desk and by the worker sweep on the same tick.
  openIdx: index('critical_events_open_idx').on(t.acknowledgedAt, t.notifiedAt),
  reportIdx: index('critical_events_report_idx').on(t.reportId),
}));

export const reportDeliveries = telrad.table('report_deliveries', {
  id: serialId('id'),
  reportId: integer('report_id').notNull().references(() => reports.id),
  tenantId: tenantId,
  channel: text('channel', { enum: ['portal', 'email', 'whatsapp', 'hl7', 'pdf_link'] }).notNull(),
  recipient: text('recipient').notNull(),
  status: text('status', { enum: ['pending', 'sent', 'failed', 'dead'] }).notNull().default('pending'),
  attemptNo: smallint('attempt_no').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }),
  errorCode: text('error_code'),
  idempotencyKey: text('idempotency_key').notNull(),
}, (t) => ({
  idemUq: uniqueIndex('report_deliveries_idem_uq').on(t.idempotencyKey),
}));

export const retentionPolicies = telrad.table('retention_policies', {
  id: serialId('id'),
  tenantId: integer('tenant_id').references(() => tenants.id),
  modalityCode: text('modality_code'),
  onlineMonths: smallint('online_months').notNull().default(12),
  archiveYears: smallint('archive_years').notNull().default(7),
  purgeAfterYears: smallint('purge_after_years'),
  legalBasis: text('legal_basis'),
  note: text('note'),
  enabled: boolean('enabled').notNull().default(true),
});

export const tariffs = telrad.table('tariffs', {
  id: serialId('id'),
  tenantId: integer('tenant_id').notNull().references(() => tenants.id),
  modalityCode: text('modality_code').notNull(),
  subSpecialtyCode: text('sub_specialty_code'),
  priority: text('priority', { enum: ['stat', 'urgent', 'routine'] }).notNull().default('routine'),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  unitPaise: integer('unit_paise').notNull(),
  nightMultiplierPct: smallint('night_multiplier_pct').notNull().default(0),
  effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
  effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
  status: text('status', { enum: ['draft', 'active', 'retired'] }).notNull().default('draft'),
}, (t) => ({
  rateUq: uniqueIndex('tariffs_rate_uq')
    .on(t.tenantId, t.modalityCode, t.subSpecialtyCode, t.priority, t.effectiveFrom),
}));

export const payoutRates = telrad.table('payout_rates', {
  id: serialId('id'),
  tierId: integer('tier_id').notNull(),
  modalityCode: text('modality_code').notNull(),
  subSpecialtyCode: text('sub_specialty_code'),
  unitPaise: integer('unit_paise').notNull(),
  nightMultiplierPct: smallint('night_multiplier_pct').notNull().default(10),
  effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' }).notNull(),
});

export const invoices = telrad.table('invoices', {
  id: serialId('id'),
  number: text('number').notNull(),
  tenantId: tenantId,
  periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  grossPaise: bigint('gross_paise', { mode: 'number' }).notNull().default(0),
  taxPaise: bigint('tax_paise', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['draft', 'issued', 'paid', 'disputed'] }).notNull().default('draft'),
  issuedAt: timestamp('issued_at', { withTimezone: true, mode: 'date' }),
}, (t) => ({
  numberUq: uniqueIndex('invoices_number_uq').on(t.number),
}));

export const invoiceLines = telrad.table('invoice_lines', {
  id: serialId('id'),
  invoiceId: integer('invoice_id').notNull().references(() => invoices.id),
  studyId: integer('study_id').notNull().references(() => studies.id),
  description: text('description').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  tariffId: integer('tariff_id').references(() => tariffs.id),
  taxable: boolean('taxable').notNull().default(false),
});

export const payoutStatements = telrad.table('payout_statements', {
  id: serialId('id'),
  clinicianUserId: integer('clinician_user_id').notNull().references(() => users.id),
  periodStart: timestamp('period_start', { withTimezone: true, mode: 'date' }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true, mode: 'date' }).notNull(),
  currency: char('currency', { length: 3 }).notNull().default('INR'),
  grossPaise: bigint('gross_paise', { mode: 'number' }).notNull().default(0),
  tdsPaise: bigint('tds_paise', { mode: 'number' }).notNull().default(0),
  status: text('status', { enum: ['draft', 'approved', 'paid'] }).notNull().default('draft'),
});

export const payoutLines = telrad.table('payout_lines', {
  id: serialId('id'),
  statementId: integer('statement_id').notNull().references(() => payoutStatements.id),
  reportId: integer('report_id').notNull().references(() => reports.id),
  amountPaise: integer('amount_paise').notNull(),
  isNight: boolean('is_night').notNull().default(false),
});

export const settings = telrad.table('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: at('updated_at'),
});

function serialId(name: string) {
  // Identity + primary key in one place, because every use of this helper in this
  // file is a table's id. Without the primary key, Postgres refuses any foreign
  // key pointing at the table — which is exactly what a first deploy discovered.
  return integer(name).generatedByDefaultAsIdentity().primaryKey();
}

export type StorageNode = typeof storageNodes.$inferSelect;
export type Tenant = typeof tenants.$inferSelect;
export type Study = typeof studies.$inferSelect;
export type StudyNew = typeof studies.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type SlaClock = typeof slaClocks.$inferSelect;
