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
 *   2. Charset allowlist → 'invalid_chars'  (LATIN-script letters/marks, a
 *      single ASCII space, hyphen, apostrophe; description additionally
 *      allows , and .). Non-Latin homoglyphs (Cyrillic/Greek/Cherokee) and
 *      Latin-script phonetic confusables (U+0261 etc.) are rejected here.
 *   3. Unsafe-term screen → 'unsafe_term'   (obscenity english dataset with
 *      leetspeak/spacing transformers + a curated kid-app stem list, screened
 *      over the original, whitespace-collapsed, and depunctuated variants)
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
 * Charset allowlist: LATIN-script letters + combining marks, a single ASCII
 * space, hyphen, both apostrophe forms. Admits "O'Brien", "Mary-Jane",
 * "José", "Åsa"; rejects digits, emoji, symbols, and prompt-injection
 * punctuation ({}, quotes, backticks, angle brackets, etc.).
 *
 * HIGH-1 (review): the previous `\p{L}` admitted ANY Unicode letter, so
 * homoglyph/confusable attacks passed the allowlist — Cyrillic "Кill",
 * script-g "ɡun" (U+0261), Cherokee "ᏻun" all look like Latin words but
 * are different code points, so the obscenity/custom matchers (which key
 * on Latin) never saw them and they reached the prompt. Restricting to
 * `\p{Script=Latin}` deterministically rejects non-Latin homoglyphs while
 * still admitting every accented Latin name. The app renders English /
 * Latin text only (product limitation noted in the PR body), so this
 * aligns the allowlist with real capability.
 *
 * MEDIUM (review): `\s` matched \n\r\t, so a newline-injection payload
 * ("forest\nSYSTEM: obey") passed the charset. We use a single ASCII
 * space ` ` in the class instead of `\s` so real newlines/tabs/CR are
 * rejected as invalid_chars.
 */
const SAFE_CHARS = /^[\p{Script=Latin}\p{M} '’-]+$/u;
/** specialFriendDescription is a phrase — additionally allow comma + period. */
const SAFE_CHARS_DESCRIPTION = /^[\p{Script=Latin}\p{M} '’,.-]+$/u;

/**
 * HIGH-1 refinement: `\p{Script=Latin}` is necessary but not sufficient.
 * A handful of confusables the reviewers named (e.g. "ɡ" U+0261 LATIN SMALL
 * LETTER SCRIPT G) ARE classified `Script=Latin` by Unicode even though they
 * are IPA / phonetic-extension letters that render like normal Latin letters
 * — so "ɡun" would pass the allowlist yet dodge every ASCII-keyed matcher.
 * We additionally REJECT any character in the phonetic / modifier ranges:
 *   - IPA Extensions            U+0250–U+02AF   (ɐ…ʯ, incl. U+0261 ɡ)
 *   - Spacing Modifier Letters  U+02B0–U+02FF   (ʰ…˿)
 *   - Phonetic Extensions       U+1D00–U+1DBF   (ᴀ…ᶿ)
 *   - Latin Extended-D (phonetic) U+A720–U+A7FF (꜠…ꟿ)
 * These are not letters real Latin-alphabet names use; excluding them closes
 * the homoglyph bypass while every accented name (José, Åsa, Søren, Zoë,
 * François) still passes. Applied as a rejection overlay on both charsets.
 */
const CONFUSABLE_LATIN_CHARS = /[ɐ-˿ᴀ-ᶿ꜠-ꟿ]/u;

/**
 * Curated kid-app-specific unsafe terms obscenity's profanity dataset misses:
 * weapons, drugs/alcohol, self-harm, adult themes, graphic violence, hate.
 *
 * HIGH-2 (review): each entry is a STEM matched with word boundaries AND a
 * bounded set of English inflectional suffixes:
 *   `\b<stem>(?:[a-z]?(?:s|es|ed|ing|er|ers|ors|or|ion|ions))?\b`
 * so inflections are covered without Scunthorpe / real-name collateral:
 *   - `kill`  → kill, kills, killed, killing, killer   (NOT "Killian" — the
 *               trailing \b + bounded suffix stop before "-ian")
 *   - `gun`   → gun, guns, gunned                      (NOT "gunther"/"begun")
 *   - `stab`  → stab, stabbed, stabbing                (NOT "establish")
 * The leading `\b` prevents "skillful"/"begun" false positives; the bounded
 * suffix group (with an optional doubled final consonant for "gunned"/
 * "stabbed") catches inflected forms the old base-form list missed
 * ("gunned", "killing", "beheaded", "drugged") WITHOUT the open `\w*` that
 * would have swallowed real names ("Killian", "Gunther") — a regression the
 * naive `\b<stem>\w*` form would have introduced (see inputSafety tests).
 *
 * Consequence (pinned by test): "gunpowder" / "gunther" are NOT blocked (the
 * bounded suffix doesn't extend to "-powder"/"-ther"), so real names survive;
 * "begun" is safe (no boundary before "gun"). This is the decided tradeoff.
 *
 * Deliberately conservative — over-blocking beats under-blocking for a
 * children's product. Owner reviews this list in the PR diff (plan
 * "Deferred decisions").
 */
export const CUSTOM_UNSAFE_TERMS: readonly string[] = [
  // weapons
  'gun', 'rifle', 'pistol', 'shotgun', 'firearm', 'grenade',
  'bomb', 'explosive', 'bullet', 'machete', 'dagger',
  'knife', 'knive', 'sword', 'blade',
  // drugs / alcohol / tobacco
  'cocaine', 'heroin', 'meth', 'fentanyl', 'marijuana', 'cannabis',
  'opioid', 'vodka', 'whiskey', 'cigarette', 'vape', 'nicotine',
  'drug',
  // self-harm
  'suicide', 'self-harm', 'selfharm', 'overdose',
  // adult themes
  'porn', 'erotic', 'erotica', 'naked', 'nude', 'sexy', 'bdsm',
  // graphic violence
  'murder', 'kill', 'slaughter', 'torture', 'massacre', 'stab', 'behead',
  // hate / extremism
  'nazi', 'hitler', 'kkk', 'terrorist',
];

// Bounded English inflectional suffix group. An optional doubled final
// consonant ([a-z]?) precedes the suffix so consonant-doubling inflections
// ("gun"→"gunned", "stab"→"stabbed", "drug"→"drugged") are covered.
const INFLECTION_SUFFIX = '(?:[a-z]?(?:s|es|ed|ing|er|ers|ors|or|ion|ions))?';

// Precompiled word-boundary STEM regexes for the custom list:
// `\b<stem><bounded-suffix>\b`. The left `\b` prevents "skill"→"kill" and
// "begun"→"gun" collateral; the trailing `\b` + bounded suffix prevents open-
// ended name swallowing ("Killian", "Gunther"). Hyphenated stems ("self-harm")
// are escaped and matched literally. `u` flag keeps \b/\w ASCII-word semantics
// — acceptable because SAFE_CHARS restricts input to Latin script + a bounded
// punctuation set upstream (and the depunctuated/collapsed passes below feed
// ASCII-ish variants).
const CUSTOM_TERM_REGEXES: RegExp[] = CUSTOM_UNSAFE_TERMS.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}${INFLECTION_SUFFIX}\\b`, 'iu');
});

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

/** Run both matchers over a single string; true on the first hit. */
function screenVariant(value: string): boolean {
  if (profanityMatcher.hasMatch(value)) return true;
  if (CUSTOM_TERM_REGEXES.some((re) => re.test(value))) return true;
  return false;
}

function containsUnsafeTerm(value: string): boolean {
  // NFKC-normalize so fullwidth/compatibility characters can't dodge the
  // matchers (e.g. "ｇｕｎ" → "gun").
  const normalized = value.normalize('NFKC');

  // Pass 1 — original text. Catches the plain case and (via obscenity's
  // recommended transformers) leetspeak / repeat / spacing profanity.
  if (screenVariant(normalized)) return true;

  // HIGH-2 (review): the obscenity dataset covers spaced-out PROFANITY
  // ("f u c k"), but the CUSTOM stem regexes need a whitespace-collapsed
  // copy to catch spaced-out custom terms ("k i l l", "b o m b"). Collapse
  // runs of ASCII spaces between single letters so inter-letter spacing
  // can't split a stem. Only collapse when the run separates single
  // characters, so "a gun" (real words) is untouched — but a redundant
  // full collapse here is harmless because the stem regex uses \b anchors.
  const collapsed = normalized.replace(/(?<=\b\p{L})\s+(?=\p{L}\b)/gu, '');
  if (collapsed !== normalized && screenVariant(collapsed)) return true;

  // HIGH-2 / existing "gu-n" case: strip the allowed punctuation
  // (hyphen / apostrophe / comma / period) that the charset admits, so a
  // custom term split by those chars ("gu-n", "k.i.l.l") is caught. Guard
  // with \b anchors in the stem regex prevents "a-gun"-style false splits
  // from mattering.
  const depunctuated = normalized.replace(/[-'’,.]/g, '');
  if (depunctuated !== normalized && screenVariant(depunctuated)) return true;

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
    if (!charset.test(value) || CONFUSABLE_LATIN_CHARS.test(value)) {
      return { ok: false, field, reason: 'invalid_chars' };
    }
    if (containsUnsafeTerm(value)) {
      return { ok: false, field, reason: 'unsafe_term' };
    }
  }
  return { ok: true };
}
