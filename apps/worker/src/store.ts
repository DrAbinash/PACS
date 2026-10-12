import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import {
  appendAudit, assignments, auditLog, criticalEvents, dispatchableStudies, escalationRules, ingestCursors, ingestEvents, offerHistory, orders,
  panelReaders, patients, reports, reportDeliveries, slaClocks, slaTargets, studies, subSpecialties, tenants, tenantSites, uploadBatches, uploadFiles,
} from '@telrad/db';
import { LIMITS, type EscalationRule, type Priority } from '@telrad/shared';
import type { EscalatableClock, EscalationPort } from './escalate.js';
import type { CriticalPort } from './criticals.js';
import type { NotifyPort, QueuedNotification } from './notify.js';
import type { DispatchPort } from './dispatch.js';
import type { OrderCandidate, StorePort } from './ingest.js';
import type { InboxStore } from './inbox.js';
import { DIGEST_ACTION, OPS_ALERT_ACTIONS, type OpsPort } from './ops.js';
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
        priority: orders.priority,
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
        priority: r.priority,
      })) satisfies OrderCandidate[];
    },

    async slaMinutesFor(tenantId, modalityCode, subSpecialtyCode, priority) {
      // A tenant's own target wins outright: it was set per modality and priority by
      // someone who read the contract, so the stat/urgent fractions below must not
      // dilute it. Targets only ever apply at a tenant, never to the platform default.
      if (tenantId !== null && modalityCode) {
        const [target] = await db.select({ minutes: slaTargets.slaMinutes })
          .from(slaTargets)
          .where(and(
            eq(slaTargets.tenantId, tenantId),
            eq(slaTargets.modalityCode, modalityCode),
            eq(slaTargets.priority, priority),
            isNull(slaTargets.effectiveTo),
          ))
          .limit(1);
        if (target) return target.minutes;
      }
      if (!subSpecialtyCode) return null;
      const [row] = await db.select({ minutes: subSpecialties.defaultSlaMinutes })
        .from(subSpecialties).where(eq(subSpecialties.code, subSpecialtyCode)).limit(1);
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
          // The instance that created the row is an instance. Leaving these out and letting the
          // update branch add from zero is what made every study on this channel one short.
          instanceCount: 1,
          bytes: draft.instanceBytes ?? 0,
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
        modalityCode: studies.modalityCode,
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

    async recordNodeCounts(studyId, counts) {
      await db.update(studies)
        .set({
          instanceCount: counts.instances,
          seriesCount: counts.series,
          // Only overwritten when the node gave a number: a null here would erase the size of a
          // study that is otherwise perfectly filed.
          ...(counts.bytes === null ? {} : { bytes: counts.bytes }),
        })
        .where(eq(studies.id, studyId));
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

    async ladderExhausted(study, attemptNo, reason, gap) {
      // One exhausted row per attempt count, keyed on what the audit index already
      // covers plus the attempt inside the detail. A sweep every ten seconds against a
      // case that will sit all night must not write the same page all night.
      const existing = await db.select({ id: auditLog.id })
        .from(auditLog)
        .where(and(
          eq(auditLog.action, 'dispatch.exhausted'),
          eq(auditLog.entity, 'studies'),
          eq(auditLog.entityId, String(study.id)),
          sql`${auditLog.detail}->>'attemptNo' = ${String(attemptNo)}`,
        ))
        .limit(1);
      if (existing.length > 0) return false;
      await appendAudit(db, {
        actorUserId: null, actorKind: 'system', tenantId: study.tenantId,
        action: 'dispatch.exhausted', entity: 'studies', entityId: String(study.id),
        detail: { accession: study.accessionNumber, attemptNo, reason, gap },
      });
      return true;
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

export function createNotifyStore(db: Db): NotifyPort {
  return {
    async due(now, limit) {
      // The queue is joined here rather than assembled in the sweep, because the message needs
      // the centre's name and the version the clinic is being told about, and a sweep that read
      // one row per message would be a sweep that slows down as the backlog grows.
      const rows = await db.select({
        id: reportDeliveries.id,
        reportId: reportDeliveries.reportId,
        tenantId: reportDeliveries.tenantId,
        recipient: reportDeliveries.recipient,
        channel: reportDeliveries.channel,
        status: reportDeliveries.status,
        attemptNo: reportDeliveries.attemptNo,
        nextAttemptAt: reportDeliveries.nextAttemptAt,
        accession: studies.accessionNumber,
        version: reports.version,
        signedAt: reports.signedAt,
        centreName: tenants.legalName,
        tenantCode: tenants.code,
        // The second name on the row, not the sub-specialty's rule. The message the clinic reads
        // says how many signatures the document carries, and a case released with the rule
        // switched off carries one whatever the catalogue demands.
        hasSecondSignature: reports.reviewerUserId,
        patientName: patients.fullName,
        patientMrn: patients.mrn,
      }).from(reportDeliveries)
        .innerJoin(reports, eq(reports.id, reportDeliveries.reportId))
        .innerJoin(studies, eq(studies.id, reports.studyId))
        .leftJoin(tenants, eq(tenants.id, reports.tenantId))
        .leftJoin(patients, eq(patients.id, studies.patientId))
        .where(and(
          // Both wired channels; the sweep gates each row on its own transport, so a whatsapp
          // row here with no Meta credentials waits rather than dies.
          inArray(reportDeliveries.channel, ['email', 'whatsapp']),
          inArray(reportDeliveries.status, ['pending', 'failed']),
          or(isNull(reportDeliveries.nextAttemptAt), lte(reportDeliveries.nextAttemptAt, now)),
        ))
        // Oldest scheduled first: a backlog should drain in the order it was created, and a
        // message that has been waiting since 02:00 should not lose to one queued at 03:59.
        .orderBy(reportDeliveries.nextAttemptAt)
        .limit(limit);

      return rows.map((row) => ({
        ...row,
        accession: row.accession ?? null,
        centreName: row.centreName ?? null,
        tenantCode: row.tenantCode ?? null,
        hasSecondSignature: row.hasSecondSignature !== null,
        patientName: row.patientName ?? null,
        patientMrn: row.patientMrn ?? null,
      })) satisfies QueuedNotification[];
    },

    async record(id, outcome, sentAt) {
      await db.update(reportDeliveries)
        .set({
          status: outcome.status,
          attemptNo: outcome.attemptNo,
          nextAttemptAt: outcome.nextAttemptAt,
          errorCode: outcome.errorCode,
          ...(sentAt === null ? {} : { sentAt }),
        })
        .where(eq(reportDeliveries.id, id));
    },

    async audit(input) { await appendAudit(db, input); },
  };
}

export function createOpsStore(db: Db): OpsPort {
  return {
    async alertsSince(sinceAuditId, limit) {
      const rows = await db.select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        detail: auditLog.detail,
      })
        .from(auditLog)
        // Ordered by id, not time: the digest prints what happened in chain order, and the
        // id is also the cursor, so a row can never be skipped and re-read in the same pass.
        .where(and(gt(auditLog.id, sinceAuditId), inArray(auditLog.action, [...OPS_ALERT_ACTIONS])))
        .orderBy(asc(auditLog.id))
        .limit(limit);
      return rows.map((row) => ({
        ...row,
        detail: (row.detail ?? null) as Record<string, unknown> | null,
      }));
    },

    async digestState() {
      const [latest] = await db.select({ detail: auditLog.detail, occurredAt: auditLog.occurredAt })
        .from(auditLog)
        .where(eq(auditLog.action, DIGEST_ACTION))
        .orderBy(desc(auditLog.id))
        .limit(1);
      if (!latest) return { cursor: 0, cursorAt: null, lastAttemptAt: null };
      const detail = latest.detail as { ok?: unknown; lastAuditId?: unknown } | null;
      if (detail?.ok === true && typeof detail.lastAuditId === 'number') {
        return { cursor: detail.lastAuditId, cursorAt: latest.occurredAt, lastAttemptAt: latest.occurredAt };
      }
      // The latest attempt failed. The cursor is still the last digest somebody actually
      // received, so it is read from further back rather than reset to zero — resetting would
      // re-mail the operator every alert the log has ever held.
      const [lastOk] = await db.select({ detail: auditLog.detail, occurredAt: auditLog.occurredAt })
        .from(auditLog)
        .where(and(
          eq(auditLog.action, DIGEST_ACTION),
          sql`(${auditLog.detail} ->> 'ok') = 'true'`,
        ))
        .orderBy(desc(auditLog.id))
        .limit(1);
      if (!lastOk) return { cursor: 0, cursorAt: null, lastAttemptAt: latest.occurredAt };
      const okDetail = lastOk.detail as { lastAuditId?: unknown } | null;
      const cursor = typeof okDetail?.lastAuditId === 'number' ? okDetail.lastAuditId : 0;
      return { cursor, cursorAt: lastOk.occurredAt, lastAttemptAt: latest.occurredAt };
    },

    // A platform-level row (tenantId null): the digest is the operator's own channel, and
    // filing it under a tenant would make one center's audit trail carry every center's
    // failures.
    async recordDigest(record) {
      await appendAudit(db, {
        actorUserId: null, actorKind: 'system', tenantId: null,
        action: DIGEST_ACTION, entity: 'ops', entityId: null,
        detail: record,
      });
    },
  };
}
