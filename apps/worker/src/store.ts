import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit, assignments, criticalEvents, dispatchableStudies, escalationRules, ingestCursors, ingestEvents, offerHistory, orders,
  panelReaders, patients, slaClocks, studies, subSpecialties, tenantSites, uploadBatches, uploadFiles,
} from '@telrad/db';
import { LIMITS, type EscalationRule, type Priority } from '@telrad/shared';
import type { EscalatableClock, EscalationPort } from './escalate.js';
import type { CriticalPort } from './criticals.js';
import type { DispatchPort } from './dispatch.js';
import type { OrderCandidate, StorePort } from './ingest.js';
import type { InboxStore } from './inbox.js';
import { attributeByBatch, batchIdsFromLabels } from './labels.js';

export function createStore(db: Db, nodeId: string): StorePort {
  return {
    async cursor() {
      const [row] = await db.select().from(ingestCursors).where(eq(ingestCursors.storageNodeId, nodeId));
      return { nodeId, since: row?.since === null || row?.since === undefined ? null : Number(row.since) };
    },

    async saveCursor(cursor, seen) {
      await db.insert(ingestCursors)
        .values({ storageNodeId: nodeId, since: String(cursor), instancesSeen: seen, lastRunAt: new Date(), lastError: null })
        .onConflictDoUpdate({
          target: ingestCursors.storageNodeId,
          set: {
            since: String(cursor),
            instancesSeen: sql`${ingestCursors.instancesSeen} + ${seen}`,
            lastRunAt: new Date(),
            lastError: null,
          },
        });
    },

    async failCursor(message) {
      await db.insert(ingestCursors)
        .values({ storageNodeId: nodeId, since: null, lastError: message.slice(0, 500), lastErrorAt: new Date() })
        .onConflictDoUpdate({
          target: ingestCursors.storageNodeId,
          set: { lastError: message.slice(0, 500), lastErrorAt: new Date() },
        });
    },

    async resolveSite(prov) {
      // The AE title that matters is the one Orthanc recorded as having SENT the
      // study (metadata/RemoteAET), which is evidence about the network peer, not a
      // string a modality can forge inside a data element.
      // An uploaded file arrives with no DICOM-network provenance at all: the batch
      // label written at push time is the only evidence of which center sent it, and
      // it is stronger than any tag inside the file because the center did not write it.
      const batchIds = batchIdsFromLabels(prov.labels);
      if (batchIds.length > 0) {
        const rows = await db.select({ tenantId: uploadBatches.tenantId, siteId: uploadBatches.siteId })
          .from(uploadBatches).where(inArray(uploadBatches.id, batchIds));
        const claimed = attributeByBatch(rows);
        // Two tenants claiming one instance is a contradiction, and breaking the tie
        // by label order would put a center's pixels in another center's queue.
        if (claimed.kind === 'tenant') return { tenantId: claimed.tenantId, siteId: claimed.siteId };
        if (claimed.kind === 'conflict') return null;
      }

      if (!prov.remoteAet) return null;
      const rows = await db.select({ tenantId: tenantSites.tenantId, siteId: tenantSites.id })
        .from(tenantSites)
        .where(and(
          sql`lower(${tenantSites.aeTitle}) = lower(${prov.remoteAet})`,
          eq(tenantSites.status, 'active'),
        ))
        .limit(2);
      // Two sites claiming one sending AE title is a configuration fault, not a tie
      // to break: refuse, and let the operator count the resulting orphans.
      if (rows.length !== 1) return null;
      const hit = rows[0]!;
      return { tenantId: hit.tenantId, siteId: hit.siteId };
    },

    async candidateOrders(tenantId, tags) {
      // ordered_at is the only date an order carries at P0, so the candidate window
      // is measured around it; a scheduled study date belongs to P1 order entry and
      // this window should move to it rather than stay here.
      const modality = tags.Modality ?? null;
      const from = shiftDate(tags.StudyDate, -7);
      const to = shiftDate(tags.StudyDate, 7);

      const rows = await db.select({
        orderId: orders.id,
        accessionNumber: orders.accessionNumber,
        patientId: patients.id,
        patientName: patients.fullName,
        patientMrn: patients.mrn,
        dob: patients.dob,
        orderedAt: orders.orderedAt,
        modalityCode: orders.modalityCode,
        siteId: orders.siteId,
      }).from(orders)
        .leftJoin(patients, eq(patients.id, orders.patientId))
        .where(and(
          eq(orders.tenantId, tenantId),
          or(modality ? eq(orders.modalityCode, modality) : undefined, sql`${orders.modalityCode} is null`),
          from ? gte(orders.orderedAt, from) : undefined,
          to ? lte(orders.orderedAt, to) : undefined,
        ))
        .limit(50);

      return rows.map((r) => ({
        orderId: r.orderId,
        // A candidate order with no patient record is still valid for the accession
        // path, so this is a sentinel rather than a person id.
        patientId: r.patientId ?? -1,
        accessionNumber: r.accessionNumber,
        patientName: r.patientName ?? null,
        patientMrn: r.patientMrn ?? null,
        dob: r.dob ? ymd(r.dob) : null,
        studyDate: r.orderedAt ? ymd(r.orderedAt) : null,
        modalityCode: r.modalityCode ?? null,
        siteId: r.siteId,
      })) satisfies OrderCandidate[];
    },

    async slaMinutesFor(code, priority) {
      if (!code) return null;
      const [row] = await db.select({ minutes: subSpecialties.defaultSlaMinutes })
        .from(subSpecialties).where(eq(subSpecialties.code, code)).limit(1);
      if (!row) return null;
      // A STAT contract is a stated fraction of the routine window rather than a
      // separate number per tenant, which is how two clocks drift apart.
      if (priority === 'stat') return Math.max(Math.round(row.minutes * 0.1), 30);
      if (priority === 'urgent') return Math.max(Math.round(row.minutes * 0.5), 60);
      return row.minutes;
    },

    async write(draft) {
      const rows = await db.insert(studies)
        .values({
          storageNodeId: draft.storageNodeId,
          nodePk: draft.nodePk,
          studyInstanceUid: draft.studyInstanceUid,
          tenantId: draft.tenantId,
          siteId: draft.siteId,
          orderId: draft.orderId,
          patientId: draft.patientId,
          accessionNumber: draft.accessionNumber,
          studyDate: draft.studyDate,
          modalityCode: draft.modalityCode,
          subSpecialtyCode: draft.subSpecialtyCode,
          studyDescription: draft.studyDescription,
          priority: draft.priority,
          linkState: draft.linkState,
          matchMethod: draft.matchMethod,
          matchScore: draft.matchScore.toFixed(3),
          receivedAt: draft.receivedAt,
          classification: draft.classification,
          qualityFlags: draft.qualityFlags,
        })
        .onConflictDoUpdate({
          target: [studies.storageNodeId, studies.studyInstanceUid],
          set: {
            nodePk: sql`coalesce(excluded.node_pk, ${studies.nodePk})`,
            tenantId: sql`coalesce(excluded.tenant_id, ${studies.tenantId})`,
            siteId: sql`coalesce(excluded.site_id, ${studies.siteId})`,
            orderId: sql`coalesce(excluded.order_id, ${studies.orderId})`,
            patientId: sql`coalesce(excluded.patient_id, ${studies.patientId})`,
            // A study already linked to an order does not get re-decided by a later
            // instance of the same study; a human change is the only thing that may.
            linkState: sql`case when ${studies.linkState} = 'linked' then ${studies.linkState} else excluded.link_state end`,
            matchMethod: sql`case when ${studies.linkState} = 'linked' then ${studies.matchMethod} else excluded.match_method end`,
            matchScore: sql`case when ${studies.linkState} = 'linked' then ${studies.matchScore} else excluded.match_score end`,
            classification: draft.classification,
            qualityFlags: draft.qualityFlags,
            instanceCount: sql`coalesce(${studies.instanceCount}, 0) + 1`,
            bytes: sql`coalesce(${studies.bytes}, 0) + ${draft.instanceBytes ?? 0}`,
          },
        })
        .returning({
          id: studies.id,
          isNew: sql<boolean>`xmax = 0`,
          // Not in the update set above, so on an update pass this reads the original
          // first-sight time — which is what an SLA deadline has to be measured from.
          receivedAt: studies.receivedAt,
        });

      const row = rows[0]!;
      return { id: row.id, created: row.isNew === true, receivedAt: row.receivedAt };
    },

    async event(studyId, kind, detail) {
      await db.insert(ingestEvents).values({ studyId, kind, detail });
    },

    async openSlaClock(studyId, tenantId, priority, deadlineAt) {
      const inserted = await db.insert(slaClocks)
        .values({ studyId, tenantId, priority: priority as Priority, deadlineAt })
        .onConflictDoNothing()
        .returning({ id: slaClocks.id });
      return inserted.length > 0;
    },

    async stalledStudies(nodeId, limit) {
      return db.select({
        id: studies.id,
        nodePk: studies.nodePk,
        tenantId: studies.tenantId,
        linkState: studies.linkState,
        priority: studies.priority,
        subSpecialtyCode: studies.subSpecialtyCode,
        qualityFlags: studies.qualityFlags,
        receivedAt: studies.receivedAt,
      }).from(studies)
        .where(and(
          eq(studies.storageNodeId, nodeId),
          sql`${studies.qualityFlags} @> '["study_not_complete"]'::jsonb`,
        ))
        .orderBy(studies.receivedAt)
        .limit(limit);
    },

    async clearStalledFlag(studyId) {
      // Rebuilds the array without the one flag rather than clearing the column: a
      // study can be incomplete *and* carry a human's quality flag, and the second
      // one is clinical information that this housekeeping pass must not touch.
      const rows = await db.update(studies)
        .set({
          qualityFlags: sql`(select coalesce(jsonb_agg(f.value), '[]'::jsonb)
                              from jsonb_array_elements_text(${studies.qualityFlags}) f
                             where f.value <> 'study_not_complete')`,
        })
        .where(and(
          eq(studies.id, studyId),
          sql`${studies.qualityFlags} @> '["study_not_complete"]'::jsonb`,
        ))
        .returning({ id: studies.id });
      return rows.length > 0;
    },
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// Orthanc dates are DICOM "YYYYMMDD". A null or malformed value returns null so the
// caller omits the filter entirely rather than matching nothing at all.
function shiftDate(dicom: string | undefined, days: number): Date | null {
  if (!dicom || dicom.length < 8) return null;
  const base = Date.parse(`${dicom.slice(0, 4)}-${dicom.slice(4, 6)}-${dicom.slice(6, 8)}T00:00:00Z`);
  if (Number.isNaN(base)) return null;
  return new Date(base + days * 86_400_000);
}

export function createDispatchStore(db: Db): DispatchPort {
  return {
    // The queue and the panel are read through @telrad/db because the console answers
    // "why is this case unassigned" with the same two reads, and the two must not be
    // able to disagree about what the queue is.
    async queue(limit) {
      return dispatchableStudies(db, { limit });
    },

    async panel(tenantIds, now) {
      return panelReaders(db, tenantIds, now);
    },

    async rules() {
      return enabledRules(db);
    },

    async offersByStudy(studyIds) {
      return offerHistory(db, studyIds);
    },

    async offer(studyId, tenantId, userId, attemptNo, now) {
      const inserted = await db.insert(assignments)
        .values({ studyId, tenantId, clinicianUserId: userId, state: 'offered', attemptNo, offeredAt: now })
        .onConflictDoNothing()
        .returning({ id: assignments.id });
      return inserted.length > 0;
    },

    async expireUnaccepted(cutoff) {
      // The row is kept rather than deleted, and the reason is written: "who was
      // offered this at 02:10 and did not take it" is a question whose answer is
      // already in the table, and a re-offer that overwrote it would lose it.
      const rows = await db.execute<{ id: number }>(sql`
        update telrad.assignments set state = 'returned', returned_at = now(), return_reason = 'offer_expired'
         where id in (
           select id from telrad.assignments
            where state = 'offered' and offered_at < ${cutoff.toISOString()}::timestamptz
            for update skip locked
         )
        returning id`);
      return rows.length;
    },
  };
}

export function createInboxStore(db: Db): InboxStore {
  return {
    // One batch at a time, claimed by moving it out of `sealed`. Without the claim
    // two overlapping ticks could push the same file twice.
    async claimBatch() {
      const claimed = await db.execute<{ id: string; tenant_id: number | null }>(sql`
        update telrad.upload_batches b
           set status = 'processing', attempts = attempts + 1, last_error = null
         where b.id = (
           select id from telrad.upload_batches
            where status = 'sealed'
            order by created_at
            for update skip locked
            limit 1
         )
        returning id, tenant_id`);
      const row = claimed[0];
      if (!row) return null;

      const files = await db.select({
        id: uploadFiles.id,
        filename: uploadFiles.filename,
        storedPath: uploadFiles.storedPath,
        kind: uploadFiles.kind,
        status: uploadFiles.status,
      }).from(uploadFiles).where(eq(uploadFiles.batchId, row.id)).orderBy(uploadFiles.filename).limit(LIMITS.batchFilesMax);

      return { batchId: row.id, tenantId: row.tenant_id, files };
    },

    async markFile(id, status, orthancInstanceId, errorCode) {
      await db.update(uploadFiles)
        .set({ status, orthancInstanceId, errorCode, pushedAt: status === 'pushed' ? new Date() : undefined })
        .where(eq(uploadFiles.id, id));
    },

    async finishBatch(batchId, status, error) {
      await db.update(uploadBatches)
        .set({ status, processedAt: new Date(), lastError: error })
        .where(eq(uploadBatches.id, batchId));
    },
  };
}

export async function enabledRules(db: Db): Promise<EscalationRule[]> {
  const rows = await db.select({
    tenantId: escalationRules.tenantId,
    priority: escalationRules.priority,
    stage: escalationRules.stage,
    atElapsedPct: escalationRules.atElapsedPct,
    action: escalationRules.action,
  }).from(escalationRules).where(eq(escalationRules.enabled, true))
    .orderBy(escalationRules.tenantId, escalationRules.priority, escalationRules.stage);
  return rows.map((row) => ({ ...row, action: row.action as EscalationRule['action'] }));
}

export function createEscalationStore(db: Db): EscalationPort {
  return {
    async openClocks(limit) {
      // Deliberately not filtered on `breached`: a case that has already blown its
      // deadline still has stages left to fire, and stopping the sweep at the breach is
      // how a product ends up with a breach nobody was ever told about.
      const rows = await db.select({
        id: slaClocks.id,
        studyId: slaClocks.studyId,
        tenantId: slaClocks.tenantId,
        priority: slaClocks.priority,
        startedAt: studies.receivedAt,
        deadlineAt: slaClocks.deadlineAt,
        stage: slaClocks.escalationStage,
        signedAt: slaClocks.signedAt,
        accessionNumber: studies.accessionNumber,
      }).from(slaClocks)
        .innerJoin(studies, eq(studies.id, slaClocks.studyId))
        .where(isNull(slaClocks.deliveredAt))
        .orderBy(slaClocks.deadlineAt)
        .limit(limit);

      return rows.map((row) => ({
        ...row,
        priority: row.priority as EscalatableClock['priority'],
        accessionNumber: row.accessionNumber ?? null,
      })) satisfies EscalatableClock[];
    },

    rules: () => enabledRules(db),

    async applyStage(clockId, stage, now) {
      await db.update(slaClocks)
        .set({ escalationStage: stage, lastEscalatedAt: now })
        .where(eq(slaClocks.id, clockId));
    },

    async markBreached(clockId, now) {
      const rows = await db.update(slaClocks)
        .set({ breached: true, breachedAt: now })
        .where(and(eq(slaClocks.id, clockId), eq(slaClocks.breached, false)))
        .returning({ id: slaClocks.id });
      return rows.length > 0;
    },

    async record(input) { await appendAudit(db, input); },
  };
}

export function createCriticalStore(db: Db): CriticalPort {
  return {
    async eventsToSettle(limit) {
      // The filter is the whole design. A loop acknowledged inside its own deadline is left out
      // rather than fetched and skipped, so the set this sweep walks stays the size of the
      // problem (unanswered calls, and calls answered late) instead of growing with every
      // critical finding the service has ever handled.
      const rows = await db.select({
        id: criticalEvents.id,
        studyId: criticalEvents.studyId,
        tenantId: criticalEvents.tenantId,
        conditionCode: criticalEvents.conditionCode,
        notifiedAt: criticalEvents.notifiedAt,
        detectedAt: criticalEvents.detectedAt,
        slaMinutes: criticalEvents.slaMinutes,
        acknowledgedAt: criticalEvents.acknowledgedAt,
        accession: studies.accessionNumber,
        receiverName: criticalEvents.receiverName,
      }).from(criticalEvents)
        .innerJoin(studies, eq(studies.id, criticalEvents.studyId))
        .where(and(
          eq(criticalEvents.breached, false),
          or(
            isNull(criticalEvents.acknowledgedAt),
            sql`${criticalEvents.acknowledgedAt} > coalesce(${criticalEvents.notifiedAt}, ${criticalEvents.detectedAt})
                   + (${criticalEvents.slaMinutes} * interval '1 minute')`,
          ),
        ))
        .orderBy(asc(criticalEvents.notifiedAt))
        .limit(limit);

      return rows.map((row) => ({ ...row, accession: row.accession ?? null }));
    },

    async markBreached(id) {
      // Conditional on the flag still being false: two workers on the same tick, or a worker
      // and a verification script, must produce one breach row and not one audit line each.
      const rows = await db.update(criticalEvents)
        .set({ breached: true })
        .where(and(eq(criticalEvents.id, id), eq(criticalEvents.breached, false)))
        .returning({ id: criticalEvents.id });
      return rows.length > 0;
    },

    async record(input) { await appendAudit(db, input); },
  };
}
