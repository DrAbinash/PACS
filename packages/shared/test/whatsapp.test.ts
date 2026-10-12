import { describe, expect, it } from 'vitest';
import { normalisePhone, reportReadyTemplateParams } from '../src/whatsapp.js';

describe('reportReadyTemplateParams', () => {
  it('produces the four positional parameters in template order', () => {
    expect(reportReadyTemplateParams({
      centreName: 'Sparsh Diagnostic Centre',
      accession: 'ACC-REP-1',
      reportVersion: 2,
      portalUrl: 'https://telrad.example/portal',
    })).toEqual([
      'Sparsh Diagnostic Centre',
      'ACC-REP-1',
      '2',
      'https://telrad.example/portal',
    ]);
  });

  it('offers no field a patient name could travel in', () => {
    // The type is the control: anything not in the four fields above cannot reach the wire,
    // which is what makes a template edit the only way to leak, and template edits go through
    // Meta's review.
    const input = {
      centreName: 'Sparsh Diagnostic Centre',
      accession: 'ACC-REP-1',
      reportVersion: 2,
      portalUrl: 'https://telrad.example/portal',
    };
    expect(Object.keys(input)).toHaveLength(4);
  });
});

describe('normalisePhone', () => {
  it('accepts what a desk actually types and returns E.164', () => {
    expect(normalisePhone('+91 98450 12345')).toBe('+919845012345');
    expect(normalisePhone(' +91-98450-12345 ')).toBe('+919845012345');
    expect(normalisePhone('+91 (80) 2234-5678')).toBe('+918022345678');
    expect(normalisePhone('+14155551234')).toBe('+14155551234');
  });

  it('returns null for everything that cannot be a full international number', () => {
    expect(normalisePhone(null)).toBeNull();
    expect(normalisePhone(919845012345)).toBeNull();
    expect(normalisePhone('')).toBeNull();
    expect(normalisePhone('na')).toBeNull();
    expect(normalisePhone('98450 12345')).toBeNull();
    expect(normalisePhone('91-98450-12345')).toBeNull();
    expect(normalisePhone('+91')).toBeNull();
    expect(normalisePhone('+91984501234567890')).toBeNull();
    expect(normalisePhone('+91 98450 ABCDE')).toBeNull();
    expect(normalisePhone('+919845012345x7')).toBeNull();
  });
});
