import { and, eq, inArray } from 'drizzle-orm';
import { type Db, appendAudit, assignments, patients, reports, studies, storageNodes } from '@telrad/db';
import { currentVersion, frameToBytes, parseMatlabFrame, tagValue } from '@telrad/shared';
import { Router, type Response } from 'express';
import { OrthancError, type OrthancClient } from '../orthanc.js';
import { requireAuth, requireRole, scoped, scopeTenant, type Ctx } from '../auth.js';
import { ah } from '../handler.js';

const READER_ROLES = ['radiologist', 'reviewer'];
const BOARD_ROLES = ['owner', 'console', 'radiologist', 'reviewer'];

// Orthanc's own ids are UUID-shaped. They arrive from a client, so they are matched
// rather than trusted before being placed in a URL to the image node.
const NODE_ID = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/;

// Reading a study is one structure read followed by hundreds of slice reads. Asked for
// every time, the node would answer the same tree 300 times for one CT, so it is held
// briefly. A study worth opening is already complete — nothing dispatchable is still
// arriving — so sixty seconds of staleness is not a clinical risk.
const TREE_TTL_MS = 60_000;
const TREES_MAX = 32;

type SeriesTree = {
  fetchedAt: number;
  series: { pk: string; uid: string | null; description: string | null; modality: string | null; bodyPart: string | null; instances: string[] }[];
};

/**
 * The reader's view of the case on their desk. Every pixel byte in this product goes
 * through here, because the image node answers with one shared credential that says
 * nothing about who is asking: the assignment is the only thing separating a radiologist
 * reading their own case from anybody reading anybody else's.
 */
export function viewRouter(db: Db, orthanc: OrthancClient): Router {
  const r = Router();
  const trees = new Map<number, SeriesTree>();
  r.use(scoped(['/view'], requireAuth(db)));

  async function loadCase(studyId: number) {
    const [row] = await db.select({
      id: studies.id,
      tenantId: studies.tenantId,
      nodePk: studies.nodePk,
      baseUrl: storageNodes.baseUrl,
      nodeState: storageNodes.state,
      accession: studies.accessionNumber,
      modality: studies.modalityCode,
      subSpecialty: studies.subSpecialtyCode,
      priority: studies.priority,
      studyDescription: studies.studyDescription,
      studyDate: studies.studyDate,
      receivedAt: studies.receivedAt,
      linkState: studies.linkState,
      patientName: patients.fullName,
      patientMrn: patients.mrn,
      patientGender: patients.gender,
      patientDob: patients.dob,
    }).from(studies)
      .innerJoin(storageNodes, eq(storageNodes.id, studies.storageNodeId))
      .leftJoin(patients, eq(patients.id, studies.patientId))
      .where(eq(studies.id, studyId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Who may open this study. A reader must hold it — offered counts, because looking is
   * how a reader decides whether to accept, and refusing that would push them to accept
   * blind. An operator may open anything in their own tenant. Everyone else gets a 404
   * unless they are holding the wrong case, which is a 403: the study is theirs to know
   * about, it is just not on their desk.
   */
  async function authorize(studyId: number, ctx: Ctx) {
    const principal = ctx.principal!;
    const row = await loadCase(studyId);
    if (!row || row.tenantId === null || !row.nodePk || !NODE_ID.test(row.nodePk)) {
      return { row: null, status: 404 as const, hold: null, access: null };
    }
    const scope = scopeTenant(principal);
    if (scope !== null && row.tenantId !== scope) {
      await appendAudit(db, {
        actorUserId: principal.userId, actorKind: 'human', tenantId: row.tenantId,
        action: 'view.denied_cross_tenant', entity: 'studies', entityId: String(studyId),
      });
      return { row: null, status: 404 as const, hold: null, access: null };
    }
    if (READER_ROLES.includes(principal.role)) {
      const [held] = await db.select({ id: assignments.id, state: assignments.state }).from(assignments)
        .where(and(
          eq(assignments.studyId, studyId),
          eq(assignments.clinicianUserId, principal.userId),
          inArray(assignments.state, ['offered', 'accepted', 'reading']),
        )).limit(1);
      if (held) return { row, status: 200 as const, hold: held, access: null };
      // Two clinical reasons to see the pixels without holding the case, and they are the
      // same fact from either side of a signature: the reader who wrote a report has to be
      // able to look at what they described — including after signing, which completes the
      // read and takes the case off their desk — and the reader being asked for a second
      // name must be able to check it before giving it. One live lock per study is a
      // routing rule, and neither of these may steal it.
      const versions = await db.select({
        reportId: reports.id,
        version: reports.version,
        state: reports.state,
        author: reports.authorUserId,
      }).from(reports).where(eq(reports.studyId, studyId));
      const live = currentVersion(versions);
      if (live && live.author === principal.userId) {
        return { row, status: 200 as const, hold: null, access: { ...live, as: 'author' as const } };
      }
      if (live && live.state === 'signed') {
        return { row, status: 200 as const, hold: null, access: { ...live, as: 'review' as const } };
      }
      return { row, status: 403 as const, hold: null, access: null };
    }
    return { row, status: 200 as const, hold: null, access: null };
  }

  function denied(res: Response, status: number) {
    return res.status(status).json({ ok: false, error: status === 403 ? 'not_your_case' : 'not_found' });
  }

  async function treeFor(studyId: number, baseUrl: string, nodePk: string): Promise<SeriesTree> {
    const cached = trees.get(studyId);
    if (cached && Date.now() - cached.fetchedAt < TREE_TTL_MS) return cached;
    if (trees.size >= TREES_MAX) trees.clear();
    // `/studies/{pk}/series` was measured to answer each series with its Instances list
    // already expanded, which is the whole structure a viewer needs in one call.
    const raw = await orthanc.nodeJson<Record<string, unknown>[]>(baseUrl, `/studies/${nodePk}/series`);
    const fresh: SeriesTree = {
      fetchedAt: Date.now(),
      series: raw.map((s) => {
        const tags = (s['MainDicomTags'] ?? {}) as Record<string, string>;
        return {
          pk: String(s['ID'] ?? ''),
          uid: tags['SeriesInstanceUID'] ?? null,
          description: tags['SeriesDescription'] ?? null,
          modality: tags['Modality'] ?? null,
          bodyPart: tags['BodyPartExamined'] ?? null,
          instances: Array.isArray(s['Instances']) ? (s['Instances'] as string[]) : [],
        };
      }).filter((s) => NODE_ID.test(s.pk)),
    };
    trees.set(studyId, fresh);
    return fresh;
  }

  function belongsTo(tree: SeriesTree, instancePk: string): boolean {
    return tree.series.some((s) => s.instances.includes(instancePk));
  }

  /**
   * A refusal from the node is reported as what it was, not dressed up as an empty
   * image: 404 here means the case is genuinely not at the node, and 401 from the node
   * means the deployment's credential is wrong — two different faults an operator has to
   * be able to tell apart without reading logs.
   */
  function refuse(res: Response, err: unknown, studyId: number) {
    if (err instanceof OrthancError && err.status === 404) {
      return res.status(404).json({ ok: false, error: 'not_at_node', studyId });
    }
    if (err instanceof OrthancError && (err.status === 401 || err.status === 403)) {
      return res.status(502).json({ ok: false, error: 'node_rejected_credentials' });
    }
    throw err;
  }

  r.get('/view/:studyId', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const studyId = Number(req.params.studyId);
    if (!Number.isInteger(studyId)) return res.status(400).json({ ok: false, error: 'bad_id' });
    const auth = await authorize(studyId, req);
    if (!auth.row || auth.status !== 200) return denied(res, auth.status);
    const row = auth.row;

    let tree: SeriesTree;
    try {
      tree = await treeFor(studyId, row.baseUrl, row.nodePk!);
    } catch (err) {
      return refuse(res, err, studyId);
    }

    await appendAudit(db, {
      actorUserId: req.principal!.userId, actorKind: 'human', tenantId: row.tenantId,
      action: 'view.open', entity: 'studies', entityId: String(studyId),
      detail: {
        accession: row.accession,
        series: tree.series.length,
        instances: tree.series.reduce((n, s) => n + s.instances.length, 0),
        held: auth.hold?.state ?? (auth.access ? auth.access.as : 'operator'),
      },
    });

    res.json({
      ok: true,
      generatedAt: new Date(),
      study: {
        id: row.id,
        accession: row.accession,
        modality: row.modality,
        subSpecialty: row.subSpecialty,
        priority: row.priority,
        studyDescription: row.studyDescription,
        studyDate: row.studyDate,
        receivedAt: row.receivedAt,
        linkState: row.linkState,
        nodeState: row.nodeState,
        patient: {
          name: row.patientName, mrn: row.patientMrn, gender: row.patientGender, dob: row.patientDob,
        },
      },
      held: auth.hold ? { assignmentId: auth.hold.id, state: auth.hold.state } : null,
      // Said out loud, because the screen has to distinguish "reading" from "being asked
      // to put a second name on somebody else's reading", and neither from "opening the
      // case I already signed".
      reportAccess: auth.access,
      series: tree.series.map((s, index) => ({
        index,
        pk: s.pk,
        uid: s.uid,
        description: s.description,
        modality: s.modality ?? row.modality ?? null,
        bodyPart: s.bodyPart,
        count: s.instances.length,
        // Returned once, in the node's own order, so a slice request can name the
        // instance it wants without the api re-reading the tree for every scroll.
        instances: s.instances,
      })),
      // Said out loud rather than assumed: this node was measured to ignore min/max/size
      // on every rendering endpoint, so window and level are computed here, in the
      // browser, from the numbers.
      windowing: 'client',
      pixelFormat: 'int16-le',
    });
  }));

  async function instanceTags(req: Ctx, res: Response, orthancPath: (pk: string) => string) {
    const studyId = Number(req.params.studyId);
    const instancePk = String(req.params.instancePk);
    if (!Number.isInteger(studyId) || !NODE_ID.test(instancePk)) {
      return { error: res.status(400).json({ ok: false, error: 'bad_id' }) } as const;
    }
    const auth = await authorize(studyId, req);
    if (!auth.row || auth.status !== 200) return { error: denied(res, auth.status) } as const;
    const row = auth.row;
    try {
      const tree = await treeFor(studyId, row.baseUrl, row.nodePk!);
      if (!belongsTo(tree, instancePk)) {
        return { error: res.status(404).json({ ok: false, error: 'not_in_this_study' }) } as const;
      }
      const tags = await orthanc.nodeJson<Record<string, { Name?: string; Value?: unknown }>>(
        row.baseUrl, orthancPath(instancePk));
      return { row, tags } as const;
    } catch (err) {
      return { error: refuse(res, err, studyId) } as const;
    }
  }

  r.get('/view/:studyId/instances/:instancePk', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const out = await instanceTags(req, res, (pk) => `/instances/${pk}/tags`);
    if ('error' in out) return undefined;
    const t = (name: string) => tagValue(out.tags, name);
    const n = (name: string) => {
      const v = t(name);
      if (v === null) return null;
      const first = Number(v.split('\\')[0]);
      return Number.isFinite(first) ? first : null;
    };
    res.json({
      ok: true,
      instanceId: String(req.params.instancePk),
      rows: n('Rows'),
      columns: n('Columns'),
      bitsStored: n('BitsStored'),
      bitsAllocated: n('BitsAllocated'),
      pixelRepresentation: n('PixelRepresentation') ?? 0,
      photometric: t('PhotometricInterpretation'),
      windowCenter: t('WindowCenter'),
      windowWidth: t('WindowWidth'),
      rescaleSlope: n('RescaleSlope') ?? 1,
      rescaleIntercept: n('RescaleIntercept') ?? 0,
      instanceNumber: n('InstanceNumber'),
      // Ordering while scrolling: the physical slice position when the study carries one,
      // otherwise the instance number the scanner wrote.
      sliceLocation: n('SliceLocation'),
      pixelSpacing: t('PixelSpacing'),
      seriesDescription: t('SeriesDescription'),
      contentDate: t('ContentDate'),
      patientOrientation: t('PatientOrientation'),
    });
  }));

  r.get('/view/:studyId/instances/:instancePk/frames/:frameIndex', ah(async (req: Ctx, res) => {
    if (!requireRole(req.principal, BOARD_ROLES, res)) return undefined;
    const frameIndex = Number(req.params.frameIndex);
    if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > 999) {
      return res.status(400).json({ ok: false, error: 'bad_frame_index' });
    }
    const studyId = Number(req.params.studyId);
    const instancePk = String(req.params.instancePk);
    if (!Number.isInteger(studyId) || !NODE_ID.test(instancePk)) {
      return res.status(400).json({ ok: false, error: 'bad_id' });
    }
    const auth = await authorize(studyId, req);
    if (!auth.row || auth.status !== 200) return denied(res, auth.status);
    const row = auth.row;

    let text: string;
    try {
      const tree = await treeFor(studyId, row.baseUrl, row.nodePk!);
      if (!belongsTo(tree, instancePk)) {
        return res.status(404).json({ ok: false, error: 'not_in_this_study' });
      }
      // The only endpoint on this build that answers with stored values rather than a
      // rendered picture; `/frames/{i}/image-uint8` was measured to ignore every window
      // parameter, so it cannot be the source of a changeable image.
      text = await orthanc.nodeText(row.baseUrl, `/instances/${instancePk}/frames/${frameIndex}/matlab`);
    } catch (err) {
      return refuse(res, err, studyId);
    }

    const frame = parseMatlabFrame(text);
    if (!frame) {
      // A frame with no numbers is a real state — a localizer or a dose report stored
      // without pixel data — and it must arrive as a refusal, not as a black image a
      // reader would otherwise have to interpret.
      return res.status(422).json({ ok: false, error: 'no_pixels_in_frame' });
    }
    if (frame.overflowSeen) {
      return res.status(422).json({ ok: false, error: 'frame_not_16_bit' });
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Telrad-Pixel-Format', 'int16-le');
    res.setHeader('X-Telrad-Pixel-Count', String(frame.values.length));
    // Patient data, and a cached frame would outlive the assignment that made it readable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(frameToBytes(frame)));
  }));

  return r;
}
