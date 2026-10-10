import { describe, expect, it } from 'vitest';
import { hasValidEvidenceCitations } from '../src/lib/citations';

const knownIds = new Set(['G01-E01', 'G01-R01', 'G01-C01']);

describe('AI evidence citation validation', () => {
  it.each([
    'The amounts differ [G01-E01] [G01-R01].',
    'The receipt agrees with the charge [G01-R01, G01-C01].',
    'The receipt agrees with the charge [ G01-R01 ; G01-C01 ].',
    'Compare all records [G01-E01, G01-R01; G01-C01].',
    'Compare the same record again [G01-R01] [G01-R01].',
  ])('accepts known citations: %s', text => {
    expect(hasValidEvidenceCitations(text, knownIds)).toBe(true);
  });

  it.each([
    'The amounts differ, but no evidence is cited.',
    'This cites another case [G02-R01].',
    'A valid reference cannot hide an unknown one [G01-R01] [G02-R01].',
    'An unknown ID inside a group is still invalid [G01-R01, G02-R01].',
    'Prefixes are not exact IDs [G01-R].',
    'Labels are not record IDs [Receipt G01-R01].',
    'Empty references are invalid [].',
    'Empty items are invalid [G01-R01, ].',
    'Whitespace cannot imply multiple IDs [G01-R01 G01-C01].',
    'A valid citation does not excuse an unfinished one [G01-R01] [G02-R01.',
    'Nested brackets are not citations [[G01-R01]].',
  ])('rejects missing or invalid citations: %s', text => {
    expect(hasValidEvidenceCitations(text, knownIds)).toBe(false);
  });

  it('rejects all references when no evidence was provided', () => {
    expect(hasValidEvidenceCitations('A finding [G01-R01].', new Set())).toBe(false);
  });
});
