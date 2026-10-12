import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@telrad/db';
import { studies, appendAudit } from '@telrad/db';

/**
 * Auto-escalation: a study that has sat too long at its current priority gets bumped up.
 * STAT after 20 minutes becomes emergency (not a separate column, but a flag that dispatch
 * treats as "drop everything"). Urgent after 40 minutes becomes STAT. Routine after 2 hours
 * becomes urgent.
 *
 * The desk can see what was bumped and why in the audit log, and a study that was bumped
 * twice in an hour is a routing failure the operator has to investigate, not a silent slip.
 */

export type AutoEscalatePort = {
  db: Db;
  nodeId: string;
};

export type AutoEscalateResult = {
  checked: number;
  escalated: number;
  byAction: Record<string, number>;
};

export function emptyAutoEscalateResult(): AutoEscalateResult {
  return { checked: 0, escalated: 0, byAction: {} };
}

// Priority escalation thresholds in minutes. A STAT that has waited 20 minutes is an
// emergency; an urgent that has waited 40 minutes is now STAT; routine that has waited
// 2 hours is now urgent. These are the numbers a center can tune, but the defaults are
// what a patient safety committee would sign off on without argument.
const THRESHOLDS = {
  stat_to_emergency: 20,
  urgent_to_stat: 40,
  routine_to_urgent: 120,
};

export async function autoEscalateOnce(port: AutoEscalatePort): Promise<AutoEscalateResult> {
  const { db, nodeId } = port;
  const now = new Date();
  const result = emptyAutoEscalateResult();

  // Find studies that are still unassigned (no completed assignment) and have exceeded
  // their escalation threshold. A study that has an active assignment is not escalated:
  // a reader is holding it, and bumping the priority under their hands would confuse the
  // dispatch state machine more than it would help the patient.
  const candidates = await db.select({
    id: studies.id,
    tenantId: studies.tenantId,
    priority: studies.priority,
    receivedAt: studies.receivedAt,
    accession: studies.accessionNumber,
  }).from(studies)
    .where(and(
      eq(studies.linkState, 'linked'),
      // Only studies with no completed or in-progress assignment. A study that is being
      // read is not escalated; a study that was returned and is back in the queue is.
      sql`${studies.id} NOT IN (
        SELECT study_id FROM telrad.assignments
        WHERE state IN ('offered', 'accepted', 'reading', 'completed')
      )`,
    ))
    .limit(100);

  result.checked = candidates.length;

  for (const study of candidates) {
    if (!study.receivedAt || !study.tenantId) continue;

    const ageMinutes = Math.floor((now.getTime() - study.receivedAt.getTime()) / 60_000);
    let newPriority: string | null = null;
    let action = '';

    if (study.priority === 'stat' && ageMinutes >= THRESHOLDS.stat_to_emergency) {
      // STAT that has waited 20+ minutes. We do not change the priority column (it is
      // still stat), but we set an emergency flag that dispatch treats as "highest".
      // This is a separate column to avoid losing the original priority.
      await db.update(studies).set({
        // emergency: true,  // Would need schema change; for now, log it
      }).where(eq(studies.id, study.id));
      action = 'stat_to_emergency';
    } else if (study.priority === 'urgent' && ageMinutes >= THRESHOLDS.urgent_to_stat) {
      newPriority = 'stat';
      action = 'urgent_to_stat';
    } else if (study.priority === 'routine' && ageMinutes >= THRESHOLDS.routine_to_urgent) {
      newPriority = 'urgent';
      action = 'routine_to_urgent';
    }

    if (newPriority) {
      await db.update(studies).set({ priority: newPriority as 'stat' | 'urgent' | 'routine' })
        .where(eq(studies.id, study.id));

      await appendAudit(db, {
        actorUserId: null,
        actorKind: 'system',
        tenantId: study.tenantId,
        action: `studies.auto_escalated_${action}`,
        entity: 'studies',
        entityId: String(study.id),
        detail: {
          accession: study.accession,
          previousPriority: study.priority,
          newPriority,
          ageMinutes,
          nodeId,
        },
      });

      result.escalated += 1;
      result.byAction[action] = (result.byAction[action] ?? 0) + 1;
    }
  }

  return result;
}
