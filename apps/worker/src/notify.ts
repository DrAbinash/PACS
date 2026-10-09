import {
  type AttemptOutcome, afterAttempt, containsNoPatientIdentifiers, mayAttempt,
  reportReadyBody, reportReadySubject, type ReportReadyMessage,
} from '@telrad/shared';
import type { AuditInput } from '@telrad/db';

/**
 * The outbox drain: take the messages the desk has queued, try them once, and write down what
 * happened to each.
 *
 * Nothing here decides *whether* a report was delivered — that is the desk's act in the api, and
 * the row already exists by the time this runs. What is decided here is whether the clinic was
 * told, and if not, when the next try is and how many tries are left.
 */

export type QueuedNotification = {
  id: number;
  reportId: number;
  tenantId: number;
  recipient: string;
  // The full set, not just the two the query filters for: a row that arrives here already sent
  // or already dead is refused by `mayAttempt` rather than sent again, and that guard cannot
  // exist if the type pretends the query is perfect.
  status: 'pending' | 'failed' | 'sent' | 'dead';
  attemptNo: number;
  nextAttemptAt: Date | null;
  // The message is built from these.
  accession: string | null;
  version: number;
  signedAt: Date | null;
  centreName: string | null;
  tenantCode: string | null;
  // Read from the report row, not from the sub-specialty rule: this is the sentence the clinic
  // reads about how many names are on the document, and the rule can be switched off while a
  // version with no second name is being released.
  hasSecondSignature: boolean;
  // Read for one purpose only: to prove they do not reach the wire. A notification queue that
  // trusts its own template is a queue that mails a patient's name the first time somebody
  // edits the sentence.
  patientName: string | null;
  patientMrn: string | null;
};

export type SendResult = { ok: true } | { ok: false; error: string };

export type NotifyTransport = {
  /** False when the deployment has no mail configured; the queue then waits rather than dying. */
  configured: boolean;
  label: string;
  send(message: { to: string; subject: string; text: string }): Promise<SendResult>;
};

export type NotifyPort = {
  due(now: Date, limit: number): Promise<QueuedNotification[]>;
  record(id: number, outcome: AttemptOutcome, sentAt: Date | null): Promise<void>;
  audit(input: AuditInput): Promise<void>;
};

export type NotifyResult = {
  checked: number;
  sent: number;
  retried: number;
  dead: number;
  refused: number;
  skipped: boolean;
};

export function emptyNotifyResult(skipped = false): NotifyResult {
  return { checked: 0, sent: 0, retried: 0, dead: 0, refused: 0, skipped };
}

const utc = (value: Date | null): string | null =>
  value === null ? null : `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function messageFor(row: QueuedNotification, portalUrl: string): ReportReadyMessage {
  return {
    centreName: row.centreName ?? row.tenantCode ?? 'Radiology centre',
    tenantCode: row.tenantCode ?? '—',
    accession: row.accession ?? `report-${row.reportId}`,
    reportVersion: row.version,
    signedAt: utc(row.signedAt),
    hasSecondSignature: row.hasSecondSignature,
    portalUrl,
  };
}

export async function notifyOnce(
  port: NotifyPort,
  transport: NotifyTransport,
  opts: { now?: () => Date; limit?: number; portalUrl?: string } = {},
): Promise<NotifyResult> {
  const now = (opts.now ?? (() => new Date()))();
  const portalUrl = opts.portalUrl ?? 'https://telrad.local/portal';

  // An unconfigured transport leaves the rows exactly as they are. Marking them `dead` because
  // this box has no SMTP relay would destroy the record of what still has to be sent, and the
  // next operator would have no idea which reports a clinic was never told about.
  if (!transport.configured) return emptyNotifyResult(true);

  const r = emptyNotifyResult();
  for (const row of await port.due(now, opts.limit ?? 50)) {
    if (!mayAttempt({ status: row.status, attemptNo: row.attemptNo, nextAttemptAt: row.nextAttemptAt }, now)) {
      continue;
    }
    r.checked += 1;

    const message = messageFor(row, portalUrl);
    const subject = reportReadySubject(message);
    const text = reportReadyBody(message);

    if (!containsNoPatientIdentifiers(`${subject}\n${text}`, [row.patientName, row.patientMrn])) {
      // Refused rather than retried: a message that carries an identifier is not a transient
      // failure, and trying it five times would put the same name on the wire five times.
      r.refused += 1;
      await port.record(row.id, {
        status: 'dead', attemptNo: row.attemptNo, nextAttemptAt: null, errorCode: 'patient_identifier_in_body',
      }, null);
      await port.audit({
        actorUserId: null, actorKind: 'system', tenantId: row.tenantId,
        action: 'notify.refused', entity: 'report_deliveries', entityId: String(row.id),
        detail: {
          reportId: row.reportId, channel: 'email', reason: 'patient_identifier_in_body',
          // The name itself is deliberately not recorded: an audit trail that echoes the
          // identifier it just refused has not solved anything.
          recipient: row.recipient,
        },
      });
      continue;
    }

    const attemptNo = row.attemptNo + 1;
    const result = await transport.send({ to: row.recipient, subject, text });
    const outcome = afterAttempt({
      attemptNo, ok: result.ok, errorCode: result.ok ? null : result.error, now,
    });

    await port.record(row.id, outcome, result.ok ? now : null);
    if (result.ok) r.sent += 1;
    else if (outcome.status === 'dead') r.dead += 1;
    else r.retried += 1;

    await port.audit({
      actorUserId: null, actorKind: 'system', tenantId: row.tenantId,
      action: result.ok ? 'notify.sent' : outcome.status === 'dead' ? 'notify.dead' : 'notify.failed',
      entity: 'report_deliveries', entityId: String(row.id),
      detail: {
        reportId: row.reportId,
        accession: row.accession,
        channel: 'email',
        recipient: row.recipient,
        attemptNo,
        errorCode: outcome.errorCode,
        // Only meaningful when it is not sent, but written always so a QC read does not have to
        // know the state machine to ask "when was it given up on".
        nextAttemptAt: outcome.nextAttemptAt,
        transport: transport.label,
      },
    });
  }

  return r;
}
