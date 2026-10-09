import { sql } from 'drizzle-orm';
import {
  auditLog,
  clinicianProfiles,
  escalationRules,
  modalities,
  openDb,
  storageNodes,
  subSpecialties,
  tenants,
  users,
} from '@telrad/db';
import { auditRowHash, hashPassword } from '@telrad/shared';

type Args = Record<string, string | boolean>;

function parse(argv: string[]): Args {
  const out: Args = {};
  const stray: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a?.startsWith('--')) { stray.push(a ?? ''); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  // An unquoted `--name Dr Second` otherwise arrives as name="Dr" and the account is
  // created with a truncated name that nobody notices until a board reads it wrong.
  if (stray.length > 0) {
    throw new Error(`unexpected argument(s): ${stray.join(' ')} — quote a value with spaces or put it directly after its --flag`);
  }
  return out;
}

function need(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v) throw new Error(`--${key} is required`);
  return v;
}

function dbUrl(): string {
  const url = process.env.TR_DB_URL;
  if (!url) throw new Error('TR_DB_URL is required');
  return url;
}

// Refusing a weak password here is the only gate that exists: there is no UI in
// front of this command, and an owner account with a short password is an entry
// point into every tenant at once.
function checkPasswordStrength(pw: string): void {
  if (pw.length < 14) throw new Error('password shorter than 14 characters');
  if (/^(changeme|password|1234)/i.test(pw)) throw new Error('password is a known default');
}

const DEFAULT_MODALITIES: [string, string][] = [
  ['CR', 'Computed radiography'], ['DX', 'Digital radiography'], ['US', 'Ultrasound'],
  ['CT', 'Computed tomography'], ['MR', 'Magnetic resonance'], ['MG', 'Mammography'],
  ['NM', 'Nuclear medicine'], ['OT', 'Other'],
];

const DEFAULT_SUB_SPECIALTIES: [string, string, 'routine' | 'urgent', number][] = [
  // Codes are `${modality}-${region}`, exactly what classifyStudy() derives, so a
  // study that classifies always has a row to be priced and clocked against.
  ['dr-chest', 'Chest radiograph', 'routine', 240],
  ['dx-chest', 'Chest radiograph (digital)', 'routine', 240],
  ['dr-extremity', 'Extremity radiograph', 'routine', 240],
  ['dx-extremity', 'Extremity radiograph (digital)', 'routine', 240],
  ['ct-head', 'CT head', 'urgent', 120],
  ['ct-chest', 'CT chest', 'urgent', 240],
  ['ct-abdomen', 'CT abdomen or pelvis', 'urgent', 240],
  ['ct-vascular', 'CT angiography', 'urgent', 120],
  ['ct-spine', 'CT spine', 'routine', 480],
  ['mr-head', 'MRI brain', 'urgent', 1440],
  ['mr-spine', 'MRI spine', 'routine', 1440],
  ['mr-extremity', 'MRI extremity', 'routine', 1440],
  ['us-abdomen', 'Ultrasound abdomen', 'routine', 360],
  ['us-obstetric', 'Obstetric ultrasound', 'routine', 360],
  ['mg-chest', 'Mammography', 'routine', 1440],
];

// Stage thresholds are fractions of the SLA window, so widening a contract does
// not require editing every timer — which is how escalation rot begins.
const DEFAULT_ESCALATION: { stage: number; pct: number; action: 'widen_pool' | 'alert_ops' | 'manual_assign' }[] = [
  { stage: 1, pct: 55, action: 'widen_pool' },
  { stage: 2, pct: 75, action: 'alert_ops' },
  { stage: 3, pct: 92, action: 'manual_assign' },
];

async function bootstrap(args: Args) {
  const handle = openDb(dbUrl());
  const { db } = handle;
  try {
    const email = need(args, 'email').toLowerCase();
    const displayName = need(args, 'name');
    const password = need(args, 'password');
    checkPasswordStrength(password);

    const clash = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from telrad.users where lower(email) = ${email}`,
    );
    if (clash[0]?.n !== '0') {
      throw new Error(`${email} already exists; bootstrap never resets a password`);
    }

    const node = need(args, 'node-id');
    await db.insert(storageNodes).values({
      id: node,
      label: displayName,
      baseUrl: need(args, 'node-url'),
      dicomAet: args['node-aet'] ? String(args['node-aet']) : null,
      dicomPort: args['node-dicom-port'] ? Number(args['node-dicom-port']) : null,
      role: 'ingest',
      state: 'active',
    });

    const [tenant] = await db.insert(tenants).values({
      code: need(args, 'tenant-code'),
      legalName: need(args, 'tenant-name'),
      status: 'trial',
    }).returning();
    if (!tenant) throw new Error('tenant insert returned nothing');

    for (const [code, name] of DEFAULT_MODALITIES) {
      await db.insert(modalities).values({ code, name }).onConflictDoNothing();
    }
    for (const [code, name, priority, minutes] of DEFAULT_SUB_SPECIALTIES) {
      await db.insert(subSpecialties).values({
        code, name, defaultPriority: priority, defaultSlaMinutes: minutes,
      }).onConflictDoNothing();
    }
    for (const priority of ['stat', 'urgent', 'routine'] as const) {
      for (const rule of DEFAULT_ESCALATION) {
        await db.insert(escalationRules).values({
          tenantId: tenant.id, priority, stage: rule.stage,
          atElapsedPct: rule.pct, action: rule.action,
        }).onConflictDoNothing();
      }
    }

    const [owner] = await db.insert(users).values({
      email,
      displayName,
      role: 'owner',
      tenantId: tenant.id,
      passwordHash: await hashPassword(password),
      passwordAlgo: 'scrypt',
      status: 'active',
    }).returning();
    if (!owner) throw new Error('owner insert returned nothing');

    // The chain starts with the bootstrap line itself. A genesis row carrying a
    // placeholder hash would break verification at exactly the row an investigator
    // reads first.
    const occurredAt = new Date();
    const rowHash = auditRowHash({
      prevHash: null,
      actorUserId: owner.id,
      actorKind: 'service',
      tenantId: tenant.id,
      action: 'system.bootstrap',
      entity: 'users',
      entityId: String(owner.id),
      detail: { tenantCode: tenant.code, node },
      occurredAt,
    });
    await db.insert(auditLog).values({
      actorUserId: owner.id,
      actorKind: 'service',
      tenantId: tenant.id,
      action: 'system.bootstrap',
      entity: 'users',
      entityId: String(owner.id),
      detail: { tenantCode: tenant.code, node },
      occurredAt,
      prevHash: null,
      rowHash,
    });

    console.log(`bootstrapped tenant=${tenant.code} owner=${email} node=${node}`);
  } finally {
    await handle.close();
  }
}

// Recomputes each row's hash against its stored predecessor and names the first
// row that does not chain. This detects an edit or a deletion-with-rewritten
// hashes only if the reader also compares against an exported copy, which is why
// README-FIRST-DEPLOY.md requires an offsite export of this table.
async function verifyAudit() {
  const handle = openDb(dbUrl());
  const { db } = handle;
  try {
    const rows = await db.select().from(auditLog).orderBy(auditLog.id);
    let prev: string | null = null;
    let broken = 0;
    for (const row of rows) {
      const recomputed = auditRowHash({
        prevHash: row.prevHash,
        actorUserId: row.actorUserId,
        actorKind: row.actorKind,
        tenantId: row.tenantId,
        action: row.action,
        entity: row.entity,
        entityId: row.entityId,
        detail: row.detail,
        occurredAt: row.occurredAt,
      });
      if (recomputed !== row.rowHash) {
        broken += 1;
        console.error(`audit hash mismatch at id=${row.id} action=${row.action}`);
        break;
      }
      if (prev !== null && row.prevHash !== prev) {
        broken += 1;
        console.error(`audit predecessor mismatch at id=${row.id}`);
        break;
      }
      prev = row.rowHash;
    }
    console.log(`audit rows=${rows.length} broken=${broken}`);
    if (broken > 0) process.exitCode = 1;
  } finally {
    await handle.close();
  }
}

// A reader who cannot be provisioned cannot be routed to, so this is the second half
// of the dispatcher rather than a convenience. Coverage is required: the routing rule
// reads an empty list as "covers nothing", and an account created that way would sit on
// the panel looking green and never receive a case.
function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim().toUpperCase() === 'ALL' ? '*' : s.trim()).filter((s) => s.length > 0);
}

const READER_ROLES = ['radiologist', 'reviewer'];

async function addReader(args: Args) {
  const handle = openDb(dbUrl());
  const { db } = handle;
  try {
    const email = need(args, 'email').toLowerCase();
    const displayName = need(args, 'name');
    const password = need(args, 'password');
    checkPasswordStrength(password);

    const role = String(args.role ?? 'radiologist');
    if (!READER_ROLES.includes(role)) throw new Error(`role must be one of ${READER_ROLES.join(', ')}`);
    const subs = splitList(need(args, 'subs'));
    const mods = splitList(need(args, 'mods'));
    if (subs.length === 0 || mods.length === 0) throw new Error('--subs and --mods must each list at least one code (or *)');
    const maxQueue = Number(args['max-queue'] ?? 5);
    if (!Number.isInteger(maxQueue) || maxQueue < 1 || maxQueue > 50) throw new Error('--max-queue must be an integer from 1 to 50');
    const grade = String(args.grade ?? 'junior');
    if (!['junior', 'senior', 'chief'].includes(grade)) throw new Error('--grade must be junior, senior or chief');
    const tenantId = args.tenant === undefined ? null : Number(args.tenant);
    if (tenantId !== null && !Number.isInteger(tenantId)) throw new Error('--tenant must be an id or omitted for a platform reader');

    const clash = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from telrad.users where lower(email) = ${email}`,
    );
    if (clash[0]?.n !== '0') throw new Error(`${email} already exists; add-reader never resets a password`);

    const [reader] = await db.insert(users).values({
      email,
      displayName,
      role: role as 'radiologist' | 'reviewer',   // narrowed by the check above
      tenantId,
      passwordHash: await hashPassword(password),
      passwordAlgo: 'scrypt',
      status: 'active',
    }).returning();
    if (!reader) throw new Error('user insert returned nothing');

    await db.insert(clinicianProfiles).values({
      userId: reader.id,
      registrationCouncil: need(args, 'council'),
      registrationNumber: need(args, 'reg-no'),
      stateCodes: splitList(need(args, 'states')),
      grade: grade as 'junior' | 'senior' | 'chief',
      subspecialtyCodes: subs,
      modalityCodes: mods,
      maxQueueSize: maxQueue,
      acceptsNight: args['no-night'] ? false : true,
    });

    console.log(`reader ${email} id=${reader.id} role=${role} tenant=${tenantId ?? 'platform'} `
      + `subs=${subs.join('|')} mods=${mods.join('|')} max=${maxQueue} night=${args['no-night'] ? 'no' : 'yes'}`);
  } finally {
    await handle.close();
  }
}

const command = process.argv[2];
if (command === 'bootstrap') {
  await bootstrap(parse(process.argv.slice(3)));
} else if (command === 'add-reader') {
  await addReader(parse(process.argv.slice(3)));
} else if (command === 'verify-audit') {
  await verifyAudit();
} else {
  console.error('usage: telrad-api <bootstrap|add-reader|verify-audit> [--flags]');
  process.exitCode = 2;
}
