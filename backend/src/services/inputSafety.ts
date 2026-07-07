/**
 * FC-037 layer 1 — kid-safe input validation.
 *
 * Server-side gate for every free-text field a parent can type on the
 * create-story form (plus the legacy / API-only fields). Runs in
 * POST /api/stories/generate BEFORE the story doc is created, so rejected
 * input never reaches a Gemini prompt, Firestore, or the worker.
 *
 * Three checks per present field, first failure wins:
 *   1. Length cap        → 'too_long'
 *   2. Charset allowlist → 'invalid_chars'  (Unicode letters/marks, spaces,
 *      hyphen, apostrophe; description additionally allows , and .)
 *   3. Unsafe-term screen → 'unsafe_term'   (obscenity english dataset with
 *      leetspeak/spacing transformers + a small curated kid-app list)
 *
 * The rejection NEVER echoes the offending value — only the field name and
 * a bounded reason code. Mobile mirrors the caps/charset locally for inline
 * UX (create.tsx), but this module is the enforcement point.
 */

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

/** Per-field length caps (plan §1 — final, do not tune without a new plan). */
export const FIELD_LIMITS: Record<string, number> = {
  childName: 30,
  specialFriendName: 30,
  favoriteAnimal: 40,
  moral: 40,
  setting: 60,
  authorStyle: 60,
  specialFriendDescription: 120,
};

/** Fields validated when present, in deterministic first-failure order. */
const VALIDATED_FIELDS = [
  'childName',
  'specialFriendName',
  'favoriteAnimal',
  'moral',
  'setting',
  'authorStyle',
  'specialFriendDescription',
] as const;

export type ValidatedField = (typeof VALIDATED_FIELDS)[number];

/**
 * Charset allowlist: Unicode letters + combining marks, whitespace, hyphen,
 * both apostrophe forms. Admits "O'Brien", "Mary-Jane", "José", "Åsa";
 * rejects digits, emoji, symbols, and prompt-injection punctuation
 * ({}, quotes, backticks, angle brackets, etc.).
 */
const SAFE_CHARS = /^[\p{L}\p{M}\s'’-]+$/u;
/** specialFriendDescription is a phrase — additionally allow comma + period. */
const SAFE_CHARS_DESCRIPTION = /^[\p{L}\p{M}\s'’,.-]+$/u;

/**
 * Curated kid-app-specific unsafe terms obscenity's profanity dataset misses:
 * weapons, drugs/alcohol, self-harm, adult themes, graphic violence, hate.
 * Matched case-insensitively on whole-word boundaries (so "Killian" is fine
 * but "kill" is not), plus a per-token punctuation-stripped pass so "gu-n"
 * can't slip through the allowed hyphen/apostrophe characters.
 *
 * Deliberately conservative — over-blocking beats under-blocking for a
 * children's product. Owner reviews this list in the PR diff (plan
 * "Deferred decisions").
 */
export const CUSTOM_UNSAFE_TERMS: readonly string[] = [
  // weapons
  'gun', 'guns', 'rifle', 'pistol', 'shotgun', 'firearm', 'grenade',
  'bomb', 'explosive', 'bullet', 'machete', 'dagger',
  // drugs / alcohol / tobacco
  'cocaine', 'heroin', 'meth', 'fentanyl', 'marijuana', 'cannabis',
  'opioid', 'vodka', 'whiskey', 'cigarette', 'vape', 'nicotine',
  // self-harm
  'suicide', 'self-harm', 'overdose',
  // adult themes
  'porn', 'erotic', 'naked', 'nude', 'sexy', 'bdsm',
  // graphic violence
  'murder', 'kill', 'slaughter', 'torture', 'massacre', 'stab', 'behead',
  // hate / extremism
  'nazi', 'hitler', 'kkk', 'terrorist',
];

// Precompiled whole-phrase regexes for the custom list. Custom boundaries
// (anything that isn't a letter/mark) instead of \b so they behave under
// the /u flag with accented input. Hyphenated terms ("self-harm") match as
// literal phrases.
const CUSTOM_TERM_REGEXES: RegExp[] = CUSTOM_UNSAFE_TERMS.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\p{L}\\p{M}])${escaped}(?:$|[^\\p{L}\\p{M}])`,
    'iu',
  );
});

// Single-word custom terms as a set, for the punctuation-stripped per-token
// pass ("gu-n" → token "gun"). Whole-token equality only, so "skillful"
// never matches "kill" (no Scunthorpe collateral).
const CUSTOM_SINGLE_WORD_TERMS = new Set(
  CUSTOM_UNSAFE_TERMS.filter((t) => !/[\s-]/.test(t)),
);

// obscenity: english profanity dataset + recommended transformers
// (leetspeak/confusable resolution, duplicate collapsing, non-alphabetic
// skipping — catches "fuuuck", "f u c k", etc.).
const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export type InputSafetyRejection = {
  ok: false;
  field: string;
  reason: 'too_long' | 'invalid_chars' | 'unsafe_term';
};
export type InputSafetyResult = { ok: true } | InputSafetyRejection;

function containsUnsafeTerm(value: string): boolean {
  // NFKC-normalize so fullwidth/compatibility characters can't dodge the
  // matchers (e.g. "ｇｕｎ" → "gun").
  const normalized = value.normalize('NFKC');
  if (profanityMatcher.hasMatch(normalized)) return true;
  if (CUSTOM_TERM_REGEXES.some((re) => re.test(normalized))) return true;
  // Punctuation-stripped per-token pass: split on whitespace, strip every
  // non-letter char inside each token, compare against single-word terms.
  const lowered = normalized.toLowerCase();
  for (const rawToken of lowered.split(/\s+/)) {
    const token = rawToken.replace(/[^\p{L}\p{M}]+/gu, '');
    if (token && CUSTOM_SINGLE_WORD_TERMS.has(token)) return true;
  }
  return false;
}

/**
 * Validate whichever recognized free-text fields are present on the request
 * body. Returns the FIRST failure (deterministic field order above); never
 * echoes the offending value.
 *
 * Non-string values for a recognized field (arrays, objects — field
 * smuggling) are rejected as 'invalid_chars'. Empty / whitespace-only
 * strings are skipped — required-field presence is the route's concern.
 */
export function validateStoryInputSafety(
  body: Record<string, unknown>,
): InputSafetyResult {
  for (const field of VALIDATED_FIELDS) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      return { ok: false, field, reason: 'invalid_chars' };
    }
    if (value.trim().length === 0) continue;

    if (value.length > FIELD_LIMITS[field]) {
      return { ok: false, field, reason: 'too_long' };
    }
    const charset =
      field === 'specialFriendDescription' ? SAFE_CHARS_DESCRIPTION : SAFE_CHARS;
    if (!charset.test(value)) {
      return { ok: false, field, reason: 'invalid_chars' };
    }
    if (containsUnsafeTerm(value)) {
      return { ok: false, field, reason: 'unsafe_term' };
    }
  }
  return { ok: true };
}
