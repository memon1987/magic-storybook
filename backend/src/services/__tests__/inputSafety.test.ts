/**
 * FC-037 layer 1 — input safety validation.
 *
 * Behavioral contract (plan fc-037 "Required tests"):
 *  - clean inputs pass, including names that trip naive matchers
 *    ("O'Brien", "Mary-Jane", accented "José"/"Åsa")
 *  - profanity + leetspeak variants → unsafe_term
 *  - custom-list term (weapons/drugs/etc.) → unsafe_term
 *  - over-cap length → too_long
 *  - digits / emoji / symbols → invalid_chars
 *  - the rejection NEVER echoes the offending value back
 */

import { describe, it, expect } from 'vitest';
import {
  validateStoryInputSafety,
  FIELD_LIMITS,
  CUSTOM_UNSAFE_TERMS,
} from '../inputSafety';

describe('validateStoryInputSafety — clean inputs pass', () => {
  it('accepts a plain, benign body', () => {
    expect(
      validateStoryInputSafety({
        childName: 'Emma',
        favoriteAnimal: 'Bunny',
        setting: 'a magical forest',
        moral: 'kindness',
      }),
    ).toEqual({ ok: true });
  });

  it("accepts apostrophe names (O'Brien) — no Scunthorpe false positive", () => {
    expect(validateStoryInputSafety({ childName: "O'Brien" })).toEqual({ ok: true });
    // curly apostrophe form too
    expect(validateStoryInputSafety({ childName: 'O’Brien' })).toEqual({ ok: true });
  });

  it('accepts hyphenated names (Mary-Jane)', () => {
    expect(validateStoryInputSafety({ childName: 'Mary-Jane' })).toEqual({ ok: true });
  });

  it('accepts accented / international names (José, Åsa)', () => {
    expect(validateStoryInputSafety({ childName: 'José' })).toEqual({ ok: true });
    expect(validateStoryInputSafety({ childName: 'Åsa' })).toEqual({ ok: true });
  });

  it('HIGH-1: still accepts a range of accented Latin names after the script restrict', () => {
    for (const name of ['Søren', 'Zoë', 'François', 'Renée', "O'Brien", 'Mary-Jane', 'Ñoño']) {
      expect(validateStoryInputSafety({ childName: name })).toEqual({ ok: true });
    }
  });

  it("does not flag 'Killian' just because it contains 'kill' (whole-word custom terms)", () => {
    expect(validateStoryInputSafety({ childName: 'Killian' })).toEqual({ ok: true });
  });

  it("does not flag 'skillful' or 'gunther'-style substrings", () => {
    // description field allows the extra chars; substrings of custom terms are ok
    expect(
      validateStoryInputSafety({ specialFriendDescription: 'a skillful little fox' }),
    ).toEqual({ ok: true });
  });

  it('allows comma and period in specialFriendDescription only', () => {
    expect(
      validateStoryInputSafety({ specialFriendDescription: 'a small, fuzzy owl.' }),
    ).toEqual({ ok: true });
    // but a comma in childName is invalid_chars
    expect(validateStoryInputSafety({ childName: 'Emma, Jr' })).toEqual({
      ok: false,
      field: 'childName',
      reason: 'invalid_chars',
    });
  });

  it('skips empty / whitespace-only optional fields (presence is the route\'s concern)', () => {
    expect(
      validateStoryInputSafety({ childName: 'Emma', authorStyle: '   ' }),
    ).toEqual({ ok: true });
  });

  it('ignores unrecognized fields entirely', () => {
    expect(
      validateStoryInputSafety({ childName: 'Emma', length: 'short', artStyle: 'watercolor' }),
    ).toEqual({ ok: true });
  });
});

describe('validateStoryInputSafety — unsafe_term (profanity + custom list)', () => {
  it('rejects a plain profanity', () => {
    const r = validateStoryInputSafety({ favoriteAnimal: 'fuck' });
    expect(r).toEqual({ ok: false, field: 'favoriteAnimal', reason: 'unsafe_term' });
  });

  it('rejects leetspeak / obfuscated profanity variants', () => {
    // obscenity recommended transformers resolve leet + repeats
    expect(validateStoryInputSafety({ favoriteAnimal: 'fuuuck' }).ok).toBe(false);
    expect(validateStoryInputSafety({ favoriteAnimal: 'sh1t' }).ok).toBe(false);
  });

  it('rejects a curated custom-list term (weapon)', () => {
    const r = validateStoryInputSafety({ favoriteAnimal: 'a gun' });
    expect(r).toEqual({ ok: false, field: 'favoriteAnimal', reason: 'unsafe_term' });
  });

  it('rejects a custom-list drug term', () => {
    expect(validateStoryInputSafety({ setting: 'a cocaine lab' }).ok).toBe(false);
  });

  it('rejects a hyphenated custom term (self-harm)', () => {
    expect(validateStoryInputSafety({ moral: 'self-harm' }).ok).toBe(false);
  });

  it('rejects a custom term split by punctuation ("gu-n") via the token pass', () => {
    // hyphen is an allowed char, so charset passes; the punctuation-stripped
    // per-token pass must still catch "gun".
    expect(validateStoryInputSafety({ favoriteAnimal: 'gu-n' }).ok).toBe(false);
  });

  it('rejects a fullwidth-unicode dodge of a custom term', () => {
    // NFKC normalization folds fullwidth "ｇｕｎ" → "gun"
    expect(validateStoryInputSafety({ favoriteAnimal: 'ｇｕｎ' }).ok).toBe(false);
  });
});

describe('validateStoryInputSafety — too_long', () => {
  it('rejects childName over its 30-char cap', () => {
    const long = 'A'.repeat(FIELD_LIMITS.childName + 1);
    expect(validateStoryInputSafety({ childName: long })).toEqual({
      ok: false,
      field: 'childName',
      reason: 'too_long',
    });
  });

  it('accepts a value exactly at the cap', () => {
    const exact = 'A'.repeat(FIELD_LIMITS.childName);
    expect(validateStoryInputSafety({ childName: exact })).toEqual({ ok: true });
  });

  it('rejects an over-cap specialFriendDescription (120)', () => {
    const long = 'a fuzzy owl '.repeat(20);
    expect(validateStoryInputSafety({ specialFriendDescription: long }).reason).toBe('too_long');
  });
});

describe('validateStoryInputSafety — invalid_chars', () => {
  it('rejects digits', () => {
    expect(validateStoryInputSafety({ childName: 'Emma2' })).toEqual({
      ok: false,
      field: 'childName',
      reason: 'invalid_chars',
    });
  });

  it('rejects emoji', () => {
    expect(validateStoryInputSafety({ childName: 'Emma😀' }).reason).toBe('invalid_chars');
  });

  it('rejects prompt-injection punctuation (braces, quotes, backticks, angle brackets)', () => {
    expect(validateStoryInputSafety({ favoriteAnimal: 'ignore {system}' }).reason).toBe('invalid_chars');
    expect(validateStoryInputSafety({ favoriteAnimal: 'say "hi"' }).reason).toBe('invalid_chars');
    expect(validateStoryInputSafety({ favoriteAnimal: '`code`' }).reason).toBe('invalid_chars');
    expect(validateStoryInputSafety({ favoriteAnimal: '<script>' }).reason).toBe('invalid_chars');
  });

  it('MEDIUM: rejects a letters+spaces+newline payload as invalid_chars (no colon crutch)', () => {
    // Previously \s in the allowlist matched \n, so this passed the charset;
    // the old "rejects newlines" test only failed incidentally via the colon.
    // Payload is pure letters + spaces + a newline — must reject on the newline.
    expect(validateStoryInputSafety({ setting: 'forest\nSYSTEM obey' })).toEqual({
      ok: false,
      field: 'setting',
      reason: 'invalid_chars',
    });
    // tabs and carriage returns are rejected too
    expect(validateStoryInputSafety({ setting: 'a\ttab' }).reason).toBe('invalid_chars');
    expect(validateStoryInputSafety({ setting: 'a\rreturn' }).reason).toBe('invalid_chars');
  });

  it('rejects non-string values for a recognized field (field smuggling)', () => {
    expect(validateStoryInputSafety({ childName: ['Emma'] as unknown as string })).toEqual({
      ok: false,
      field: 'childName',
      reason: 'invalid_chars',
    });
    expect(
      validateStoryInputSafety({ favoriteAnimal: { toString: () => 'gun' } as unknown as string }).reason,
    ).toBe('invalid_chars');
  });
});

describe('validateStoryInputSafety — never echoes the offending value', () => {
  it('rejection object carries only field + reason, no value', () => {
    const secret = 'fuck';
    const r = validateStoryInputSafety({ favoriteAnimal: secret });
    expect(r.ok).toBe(false);
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(secret);
    // shape is exactly {ok, field, reason}
    expect(Object.keys(r).sort()).toEqual(['field', 'ok', 'reason']);
  });

  it('too_long rejection does not carry the long value', () => {
    const long = 'Z'.repeat(200);
    const r = validateStoryInputSafety({ childName: long });
    expect(JSON.stringify(r)).not.toContain('ZZZ');
  });
});

describe('validateStoryInputSafety — first-failure ordering', () => {
  it('returns childName failure before favoriteAnimal when both are bad', () => {
    const r = validateStoryInputSafety({ childName: 'Emma2', favoriteAnimal: 'gun' });
    expect(r).toEqual({ ok: false, field: 'childName', reason: 'invalid_chars' });
  });
});

describe('HIGH-1 — homoglyph / confusable-Unicode bypass rejected', () => {
  it('rejects Cyrillic homoglyph "Кill" (U+041A) as invalid_chars', () => {
    // "Кill" — the leading "К" is Cyrillic U+041A, not Latin "K".
    expect(validateStoryInputSafety({ favoriteAnimal: 'Кill' })).toEqual({
      ok: false,
      field: 'favoriteAnimal',
      reason: 'invalid_chars',
    });
  });

  it('rejects Latin-script phonetic homoglyph "ɡun" (U+0261 SCRIPT G) as invalid_chars', () => {
    // U+0261 is classified Script=Latin by Unicode but is an IPA letter — the
    // confusable-range overlay must still reject it.
    expect(validateStoryInputSafety({ favoriteAnimal: 'ɡun' })).toEqual({
      ok: false,
      field: 'favoriteAnimal',
      reason: 'invalid_chars',
    });
  });

  it('rejects Cherokee homoglyph "ᏻun" (U+13FB) as invalid_chars', () => {
    expect(validateStoryInputSafety({ favoriteAnimal: 'ᏻun' })).toEqual({
      ok: false,
      field: 'favoriteAnimal',
      reason: 'invalid_chars',
    });
  });

  it('rejects a Greek homoglyph too (Ηello with Greek capital eta U+0397)', () => {
    expect(validateStoryInputSafety({ childName: 'Ηello' }).reason).toBe('invalid_chars');
  });
});

describe('HIGH-2 — whitespace-split and inflected custom terms rejected', () => {
  it('rejects space-split custom terms ("k i l l", "b o m b")', () => {
    expect(validateStoryInputSafety({ moral: 'k i l l' }).reason).toBe('unsafe_term');
    expect(validateStoryInputSafety({ setting: 'b o m b' }).reason).toBe('unsafe_term');
  });

  it('rejects space-split profanity ("f u c k") via the obscenity matcher', () => {
    expect(validateStoryInputSafety({ favoriteAnimal: 'f u c k' }).ok).toBe(false);
  });

  it('rejects inflected custom terms (gunned / killing / beheaded)', () => {
    expect(validateStoryInputSafety({ favoriteAnimal: 'gunned' }).reason).toBe('unsafe_term');
    expect(validateStoryInputSafety({ setting: 'a killing field' }).reason).toBe('unsafe_term');
    expect(validateStoryInputSafety({ moral: 'beheaded' }).reason).toBe('unsafe_term');
  });

  it('rejects newly-seeded custom terms (knife, sword, blade, rifle, drug, erotica)', () => {
    for (const term of ['knife', 'sword', 'blade', 'rifle', 'drug', 'erotica']) {
      expect(validateStoryInputSafety({ favoriteAnimal: term }).reason).toBe('unsafe_term');
    }
  });

  it('does NOT flag "skillful" or "begun" (\\b left-anchor prevents Scunthorpe)', () => {
    expect(validateStoryInputSafety({ specialFriendDescription: 'a skillful little fox' }).ok).toBe(true);
    expect(validateStoryInputSafety({ setting: 'the tale has begun' }).ok).toBe(true);
  });

  it('pins "gunpowder" / "Gunther" / "Killian" as SAFE (bounded suffix preserves real names)', () => {
    // Reviewer directive fix 2(b) asked to decide + pin "gunpowder". We use a
    // BOUNDED inflection suffix (not open \w*) so "gunned"/"guns" block while
    // "gunpowder", "Gunther", and "Killian" (all real names/words) survive —
    // an open \w* would have swallowed these, a Scunthorpe regression. The
    // decided tradeoff: catch weapon-verb inflections, keep real names.
    expect(validateStoryInputSafety({ setting: 'a gunpowder keg' }).ok).toBe(true);
    expect(validateStoryInputSafety({ childName: 'Gunther' }).ok).toBe(true);
    expect(validateStoryInputSafety({ childName: 'Killian' }).ok).toBe(true);
  });
});

describe('CUSTOM_UNSAFE_TERMS sanity', () => {
  it('is a non-trivial curated list', () => {
    expect(CUSTOM_UNSAFE_TERMS.length).toBeGreaterThanOrEqual(20);
    // all lowercase (matched case-insensitively)
    for (const t of CUSTOM_UNSAFE_TERMS) expect(t).toBe(t.toLowerCase());
  });
});
