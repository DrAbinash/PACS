import type { DicomTags } from '@telrad/shared';

// The contract below was read off a running Orthanc 1.13.0, not off a doc page.
// Each line is what the server actually answers, because the obvious guesses were
// wrong: /changes uses ChangeType/ResourceType/Seq (not Change/LastTouchstone),
// /instances/{id}/metadata answers a LIST of metadata names (not a tag map),
// /instances/{id} has no Path field, and StudyInstanceUID is not on the instance.
//
//   GET  /changes?limit=N[&since=SEQ]   -> { Changes: [{ChangeType,ResourceType,ID,Seq,Date,Path}], First, Last, Done }
//   GET  /instances/{id}                -> { ID, ParentSeries, MainDicomTags, FileSize, Labels, Type }
//   GET  /instances/{id}/metadata/RemoteAET  -> "TELRAD_TEST"
//   GET  /instances/{id}/metadata/RemoteIP   -> "172.19.0.4"
//   GET  /series/{pk}                   -> { ParentStudy, IsStable, Status, MainDicomTags{Modality, SeriesDescription, BodyPartExamined, ...} }
//   GET  /studies/{pk}                  -> { ID, IsStable, MainDicomTags{AccessionNumber, InstitutionName, StudyDate, StudyTime, StudyDescription, StudyInstanceUID}, PatientMainDicomTags{PatientName, PatientID, PatientBirthDate, PatientSex} }
//   POST /instances  (application/dicom)-> { ID, ParentPatient, ParentSeries, ParentStudy, Path,
//                                            Status: "Success" | "AlreadyStored" }
//                                          Re-pushing the same bytes is not a duplicate
//                                          archive row, which is what makes a drained
//                                          batch safe to retry.
//   PUT  /instances/{id}/labels/{name}  -> 200;  DELETE for the same path removes it.
//                                          POST on that path is 405, and a name with a
//                                          character outside [A-Za-z0-9_-] is 400.
//   GET  /instances/{id}                -> Labels is a JSON ARRAY of names, not a map.

export type InstanceRead = {
  instanceId: string;
  nodeStudyPk: string;
  studyInstanceUid: string | null;
  tags: DicomTags;
  provenance: { remoteAet: string | null; remoteIp: string | null; stable: boolean; labels: string[] };
  bytes: number | null;
  seq: number;
};

export type ChangeEntry = { id: string; seq: number };

export type OrthancReader = {
  /** @returns new instances plus the sequence high-water mark to store as the cursor */
  changes(since: number | null, limit: number): Promise<{ entries: ChangeEntry[]; cursor: number }>;
  read(instanceId: string, seq: number): Promise<InstanceRead>;
  /** Whether the node considers that study finished arriving. Orthanc flips this about
   * two minutes after the last instance lands and emits **no change event** for the
   * flip, so a poller that only reads what `/changes` reports would leave the study
   * flagged incomplete forever. That is why `recheckStalled` has to ask. */
  studyStable(nodeStudyPk: string): Promise<boolean>;
};

const str = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.replace(/\0+/g, '').trim() : '';
  return s ? s : undefined;
};

export function createOrthancReader(opts: { baseUrl: string; user: string; password: string }): OrthancReader {
  const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');

  async function text(path: string): Promise<string> {
    const res = await fetch(`${opts.baseUrl}${path}`, {
      headers: { Authorization: auth },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`orthanc ${res.status} for ${path}`);
    return await res.text();
  }

  async function json<T>(path: string): Promise<T> {
    return JSON.parse(await text(path)) as T;
  }

  return {
    async changes(since, limit) {
      const q = since === null ? `?limit=${limit}` : `?since=${since}&limit=${limit}`;
      const raw = await json<{
        Changes: { ChangeType: string; ResourceType: string; ID: string; Seq: number }[];
        Last: number;
      }>(`/changes${q}`);
      const entries = raw.Changes
        .filter((c) => c.ResourceType === 'Instance' && c.ChangeType === 'NewInstance')
        .map((c) => ({ id: c.ID, seq: c.Seq }));
      // The cursor is the sequence high-water mark of everything seen, not of the
      // instances kept: filtering to Instance rows and storing only those would
      // re-read every NewPatient/NewStudy row on each poll.
      return { entries, cursor: raw.Last };
    },

    async read(instanceId, seq) {
      const inst = await json<{ ParentSeries: string; FileSize?: number; Labels?: string[] }>(`/instances/${instanceId}`);
      const ser = await json<{
        ParentStudy: string;
        IsStable: boolean;
        MainDicomTags: Record<string, string>;
      }>(`/series/${inst.ParentSeries}`);
      const stu = await json<{
        ID: string;
        IsStable: boolean;
        MainDicomTags: Record<string, string>;
        PatientMainDicomTags: Record<string, string>;
      }>(`/studies/${ser.ParentStudy}`);

      let remoteAet: string | null = null;
      let remoteIp: string | null = null;
      try {
        remoteAet = (await text(`/instances/${instanceId}/metadata/RemoteAET`)).trim() || null;
        remoteIp = (await text(`/instances/${instanceId}/metadata/RemoteIP`)).trim() || null;
      } catch {
        // A node that does not expose provenance is a configuration fault to be
        // seen, so the caller gets nulls and the study lands in the orphan queue.
      }

      const s = stu.MainDicomTags ?? {};
      const p = stu.PatientMainDicomTags ?? {};
      const c = ser.MainDicomTags ?? {};
      const tags: DicomTags = {
        Modality: str(c.Modality),
        StudyDescription: str(s.StudyDescription),
        SeriesDescription: str(c.SeriesDescription),
        BodyPartExamined: str(c.BodyPartExamined),
        InstitutionName: str(s.InstitutionName),
        AccessionNumber: str(s.AccessionNumber),
        PatientID: str(p.PatientID),
        PatientName: str(p.PatientName),
        PatientBirthDate: str(p.PatientBirthDate),
        PatientSex: str(p.PatientSex),
        StudyDate: str(s.StudyDate),
        StudyTime: str(s.StudyTime),
        StudyInstanceUID: str(s.StudyInstanceUID),
      };

      return {
        instanceId,
        nodeStudyPk: stu.ID,
        studyInstanceUid: tags.StudyInstanceUID ?? null,
        tags,
        provenance: {
          remoteAet,
          remoteIp,
          stable: stu.IsStable === true,
          // Files pushed in over REST carry no sending AE title, so the batch label
          // attached at push time is what ties them back to a site.
          labels: inst.Labels ?? [],
        },
        bytes: typeof inst.FileSize === 'number' ? inst.FileSize : null,
        seq,
      };
    },

    async studyStable(nodeStudyPk) {
      const stu = await json<{ IsStable: boolean }>(`/studies/${nodeStudyPk}`);
      return stu.IsStable === true;
    },
  };
}

export type PushResult = { instanceId: string; labelError: string | null };

export type OrthancWriter = {
  /** Stores one Part-10 instance and attaches labels. A label that the node refuses
   * is reported, never thrown: the bytes are archived either way, and failing the
   * file would misrecord a successful ingest as a rejection. */
  pushInstance(bytes: Buffer, labels: string[]): Promise<PushResult>;
};

export function createOrthancWriter(opts: { baseUrl: string; user: string; password: string }): OrthancWriter {
  const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');

  return {
    async pushInstance(bytes, labels) {
      const res = await fetch(`${opts.baseUrl}/instances`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/dicom' },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`orthanc POST /instances ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const created = (await res.json()) as { ID: string };

      // A file pushed over REST carries no DICOM-network provenance, so the batch
      // label attached here is what lets the poller name the sending center.
      for (const label of labels) {
        const put = await fetch(`${opts.baseUrl}/instances/${created.ID}/labels/${label}`, {
          method: 'PUT',
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(15_000),
        });
        if (!put.ok) {
          return { instanceId: created.ID, labelError: `label ${label} refused: ${put.status}` };
        }
      }
      return { instanceId: created.ID, labelError: null };
    },
  };
}
