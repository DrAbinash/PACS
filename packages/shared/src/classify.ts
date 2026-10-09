import type { Priority } from './enums.js';

export type DicomTags = {
  Modality?: string;
  StudyDescription?: string;
  SeriesDescription?: string;
  BodyPartExamined?: string;
  InstitutionName?: string;
  StationAETitle?: string;
  AccessionNumber?: string;
  PatientID?: string;
  PatientName?: string;
  PatientBirthDate?: string;
  PatientSex?: string;
  StudyDate?: string;
  StudyTime?: string;
  StudyInstanceUID?: string;
  ReferringPhysicianName?: string;
};

export type Classification = {
  modalityCode: string;
  subSpecialtyCode: string | null;
  bodyPartCode: string | null;
  priority: Priority;
  needsHumanReview: boolean;
  reasons: string[];
};

// Sub-specialty codes are derived from (modality, region) rather than looked up in
// a keyword list that assumes a modality. An earlier draft mapped "CT HEAD" to
// mri-brain, which is the kind of error that quietly routes a trauma head CT to
// the wrong reader pool.
const REGION_PATTERNS: { re: RegExp; region: string }[] = [
  { re: /\b(brain|head|hemi|orbit|ear|nasopharynx|neck|face|sinus|temporal)\b/i, region: 'head' },
  { re: /\b(c[- ]?spine|cervical|dorsal|t[- ]?spine|lumbar|l[- ]?sacral|sacrum|spine|myelogram)\b/i, region: 'spine' },
  { re: /\b(angio|mra|mrv|cta|carotid|aortic|pulmonary embol|coronary|vessel)\b/i, region: 'vascular' },
  { re: /\b(chest|thorax|rib|lung|pleura|mammo|breast)\b/i, region: 'chest' },
  // Obstetric is tested before abdomen: an obstetric study routinely says "pelvis",
  // and filing it as an abdomen study would route a pregnancy scan to the general
  // pool instead of the one with PCPNDT obligations attached to it.
  { re: /\b(obstetric|antenatal|fetal|anomaly scan|growth scan|dating scan|tvs|uterus|gravid)\b/i, region: 'obstetric' },
  { re: /\b(abdomen|pelvis|kub|renal|liver|gallbladder|prostate|colon)\b/i, region: 'abdomen' },
  { re: /\b(hip|knee|shoulder|ankle|wrist|elbow|forearm|tibia|fibula|clavicle|scaphoid|foot|hand|arm|leg)\b/i, region: 'extremity' },
];

const STAT_HINTS = [/\bstat\b/i, /\bemergency\b/i, /\btrauma\b/i, /\bcode stroke\b/i, /\bacute\b/i];

// The tags that actually describe what was scanned live at study level and series
// level; institution is excluded because a center name is not a body part.
function haystackOf(tags: DicomTags): string {
  return [tags.StudyDescription, tags.SeriesDescription, tags.BodyPartExamined]
    .filter(Boolean)
    .join(' ');
}

export function classifyStudy(tags: DicomTags): Classification {
  const modality = (tags.Modality ?? '').trim().toUpperCase();
  const haystack = haystackOf(tags);
  const reasons: string[] = [];

  if (!modality) {
    reasons.push('modality_missing');
    return {
      modalityCode: 'OT', subSpecialtyCode: null, bodyPartCode: null,
      priority: 'routine', needsHumanReview: true, reasons,
    };
  }

  let priority: Priority = 'routine';
  for (const hint of STAT_HINTS) {
    if (hint.test(haystack)) { priority = 'stat'; reasons.push('priority_inferred_from_text'); break; }
  }

  const region = REGION_PATTERNS.find((p) => p.re.test(haystack))?.region ?? null;
  if (!region) {
    // A study whose region cannot be resolved stays readable but cannot be
    // auto-assigned: the second rung of the routing ladder would be a guess.
    reasons.push('region_unresolved');
    return { modalityCode: modality, subSpecialtyCode: null, bodyPartCode: null, priority, needsHumanReview: true, reasons };
  }

  return {
    modalityCode: modality,
    subSpecialtyCode: `${modality.toLowerCase()}-${region}`,
    bodyPartCode: region.toUpperCase(),
    priority,
    needsHumanReview: false,
    reasons,
  };
}
