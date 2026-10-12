/**
 * The WhatsApp half of the notification outbox.
 *
 * The Cloud API has no free text for business-initiated messages: a message to a clinic can only
 * be a **pre-approved template**, submitted to Meta with its parameters filled in. That
 * constraint is adopted here as the PHI control rather than fought — the template is fixed text
 * approved by a third party, and this code can only supply the four parameters below. There is
 * deliberately no field for a patient name, MRN, date of birth, study date or finding, for the
 * same reason the email message is built from a type that has none: the control is the shape of
 * the input, not a scrub run over somebody's prose afterwards.
 *
 * Before the first message can be sent, one template must be created in the Meta Business
 * Manager whose body uses placeholders in exactly this order — the parameter order *is* the
 * contract, and a template approved with the placeholders in any other order will deliver
 * sentences that make no sense:
 *
 *     A radiology report from {{1}} has been released for referral {{2}}.
 *     Version {{3}}. Read it in the portal: {{4}}.
 *     This message contains no clinical information and no patient identifiers
 *     other than the referral number.
 *
 * The template's name goes in TR_WHATSAPP_TEMPLATE and its approved language in
 * TR_WHATSAPP_LANGUAGE; no code changes when the credentials arrive.
 */
export type WhatsAppTemplateMessage = {
  centreName: string;
  accession: string;
  reportVersion: number;
  portalUrl: string;
};

/**
 * The positional parameters for the report-ready template, in the order the approved template's
 * placeholders must appear. Returned as strings because the API accepts nothing else.
 */
export function reportReadyTemplateParams(input: WhatsAppTemplateMessage): string[] {
  return [input.centreName, input.accession, String(input.reportVersion), input.portalUrl];
}

/**
 * A full international phone number, or nothing.
 *
 * The desk-shaped pragmatism of `normaliseEmail`, for the same two reasons: `+91 98450 12345`
 * and `(080) 2234-5678` are what desks actually type, and the answer when the result does not
 * look like a number the Cloud API can deliver to is `null`, which queues nothing rather than
 * failing the save. Spaces, hyphens, dots and parentheses are stripped; what must survive is a
 * leading `+` and 8–15 digits, which is the E.164 envelope.
 *
 * A number without a country code is refused outright rather than completed with a guessed one.
 * Prefixing the operator's own country code onto a bare local number is how a notice ends up in
 * somebody else's phone — and unlike a wrong email address, which bounces, a wrong WhatsApp
 * number can deliver.
 */
export function normalisePhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (value.length === 0 || value.length > 25) return null;
  if (!value.startsWith('+')) return null;
  const digits = value.slice(1).replace(/[\s().-]/g, '');
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
