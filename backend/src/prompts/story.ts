import { StoryInput, WritingStyleId } from '../types';

/**
 * Single source of truth for the writing-style ids that ship.
 * `WritingStyleId` is derived from this in `types/index.ts`; the route validator
 * imports this list to validate the request body. Adding a new id here requires
 * also adding a descriptor + page-target entry below — both lookups use
 * `Record<WritingStyleId, …>` so tsc enforces exhaustiveness.
 */
export const WRITING_STYLE_IDS = [
  'bouncy-rhymes',
  'gentle-refrains',
  'sweet-simple',
] as const satisfies readonly WritingStyleId[];

/**
 * Per-voice page targets (FC-014 review fix H1/H2).
 *
 * The previous version used a single global "2-4 sentences (30-60 words/page)"
 * cap. That conflicted with both:
 *   - "Sweet & Simple" 3-7 word sentences × 2-4 sentences = 6-28 words/page (below 30 floor)
 *   - "Bouncy Rhymes" AABB rhyme scheme requiring even sentence counts (3 sentences = unrhymable)
 *
 * Voice-aware caps let each voice produce text that matches its descriptor.
 */
interface PageTarget {
  sentencesText: string;
  wordsText: string;
}

const WRITING_STYLE_PAGE_TARGETS: Record<WritingStyleId, PageTarget> = {
  'bouncy-rhymes': {
    // Even sentence count so AABB always closes; 4 = full AABB stanza.
    sentencesText: 'exactly 4 short rhyming lines per page (one full AABB stanza)',
    wordsText: '20-50 words per page',
  },
  'gentle-refrains': {
    sentencesText: '3-4 short sentences per page',
    wordsText: '30-55 words per page',
  },
  'sweet-simple': {
    // Each sentence is short, but more of them per page so total still feels substantial.
    sentencesText: '4-6 very short sentences per page (3-7 words each)',
    wordsText: '15-35 words per page',
  },
};

const DEFAULT_PAGE_TARGET: PageTarget = {
  sentencesText: '2-4 short, engaging sentences per page',
  wordsText: '30-60 words per page',
};

/**
 * Structural voice descriptors for FC-014's 3-voice writing-style picker.
 * Author names deliberately excluded; descriptors are purely structural so the
 * LLM has no copyrighted reference to draw from.
 *
 * Review-fix notes (FC-014 PR #6 review):
 *   - M2: dropped "anapestic-leaning" (LLMs cannot scan stress); replaced with
 *     a galloping-rhythm example so the model has something concrete to mimic.
 *   - M3: replaced vague "echo a phrase from the previous page" with a specific
 *     refrain pattern (one short phrase, repeated verbatim ≥3 times).
 *   - Removed "Avoid sharp consonants" (M1 — phonological instruction LLMs
 *     don't reliably honor).
 */
const WRITING_STYLE_DESCRIPTORS: Record<WritingStyleId, string> = {
  'bouncy-rhymes':
    'Write in rhyming couplets with a galloping, forward-driving rhythm — like "On a moonlit night with a dragonfly\'s flight". Use AABB rhyme scheme: lines 1+2 rhyme, lines 3+4 rhyme. Repeat key phrases across pages for emphasis. Sprinkle in exclamations. Keep vocabulary at kindergarten level with punchy single-syllable words where possible.',
  'gentle-refrains':
    'Pick ONE short refrain phrase (3-5 words) tied to the moral and repeat it VERBATIM on at least 3 pages — ideally as the closing line of those pages. Use sensory adjectives (warm, soft, slow, golden). Structure the story as a step-by-step or day-by-day progression. Vocabulary is simple, soft, and concrete.',
  'sweet-simple':
    'Write in very short sentences — strictly 3 to 7 words each, no longer. Use questions to engage the child ("Do you see?"). Include sound words and onomatopoeia ("Boom!", "Whoosh!"). Convey big emotions through simple words. Use lots of repetition and direct address (you, your, my).',
};

/**
 * Get page count based on story length
 */
export function getPageCount(length: 'short' | 'medium' | 'long'): number {
  switch (length) {
    case 'short':
      return 4;
    case 'medium':
      return 6;
    case 'long':
      return 8;
    default:
      return 6;
  }
}

/**
 * Get pronoun instructions for the story prompt
 */
function getPronounBlock(childName: string, gender?: 'boy' | 'girl'): string {
  if (!gender) return '';
  const pronouns = gender === 'boy' ? 'he/him/his' : 'she/her/hers';
  return `\nPRONOUN USAGE:\n- ${childName} uses ${pronouns} pronouns. Always use these when referring to ${childName}.`;
}

/**
 * Build the story generation prompt for Gemini
 */
export function buildStoryPrompt(input: StoryInput): string {
  const pageCount = getPageCount(input.length);

  // FC-014: writingStyle (structured) takes precedence over legacy authorStyle (free-text).
  // Default fallback unchanged when neither is set.
  let styleGuide: string;
  let pageTarget: PageTarget;
  if (input.writingStyle && WRITING_STYLE_DESCRIPTORS[input.writingStyle]) {
    styleGuide = WRITING_STYLE_DESCRIPTORS[input.writingStyle];
    pageTarget = WRITING_STYLE_PAGE_TARGETS[input.writingStyle];
  } else if (input.authorStyle && input.authorStyle.trim().length > 0) {
    styleGuide = `Write in the style of ${input.authorStyle}, capturing their unique voice, rhythm, and storytelling approach.`;
    pageTarget = DEFAULT_PAGE_TARGET;
  } else {
    styleGuide = 'Write in a warm, engaging, and gentle children\'s book style with simple but evocative language.';
    pageTarget = DEFAULT_PAGE_TARGET;
  }

  // Build friend description from new or legacy fields
  const friendRef = input.specialFriendName || input.favoriteAnimal || 'special friend';
  const friendLine = input.specialFriendName
    ? `- Special friend: ${input.specialFriendName}, who is ${input.specialFriendDescription}`
    : `- Animal friend: A friendly, lovable ${input.favoriteAnimal}`;

  return `You are a talented children's book author. Create an original, heartwarming storybook for children ages 3-8.

STORY PARAMETERS:
- Main character: A child named ${input.childName}
${friendLine}
- Setting: ${input.setting}
- Moral/lesson to teach: ${input.moral}
- Total pages: ${pageCount}

WRITING STYLE:
${styleGuide}
${getPronounBlock(input.childName, input.childGender)}
REQUIREMENTS:
1. Use simple vocabulary appropriate for ages 3-8 (avoid complex words)
2. Each page should have ${pageTarget.sentencesText} (${pageTarget.wordsText}). The voice instructions in WRITING STYLE above are authoritative — match them exactly even if it means hitting the floor or ceiling of these counts.
3. Create a clear story arc with:
   - Beginning: Introduce ${input.childName} and ${friendRef}, set up the adventure
   - Middle: Present a gentle challenge or discovery related to ${input.moral}
   - End: Resolve the story with a warm, satisfying conclusion that reinforces the lesson
4. Weave the moral (${input.moral}) naturally into the story without being preachy
5. Include vivid, detailed scene descriptions for each page that an illustrator can use
6. Make ${friendRef} an active, endearing character in the story
7. Keep the tone positive, warm, and age-appropriate throughout

CHARACTER VISUAL CONSISTENCY:
- Create a "characterSheets" array with ONE entry for each named character in the story (${input.childName} and ${friendRef} at minimum)
- IMPORTANT: ${input.childName} (the child protagonist) MUST be the FIRST entry in the array. Their reference image will be used as the primary anchor for character consistency across all pages.
- Each entry must be EXHAUSTIVELY detailed about visual appearance — imagine briefing an illustrator who must draw this character identically across ${pageCount} pages
- Include: species/type, exact body colors and patterns, approximate size, clothing (specific colors, style, accessories), hairstyle/fur texture, distinguishing features (e.g., a red scarf, freckles, a curly tail), eye color, and body shape
- Use specific colors ("sky blue", "golden yellow") not vague ("blue", "yellow")
- Include 2-3 signature visual traits per character that make them instantly recognizable

SETTING VISUAL CONSISTENCY:
- Create a "settingIdentity" object describing the visual world of this story
- Include 3-5 specific recurring visual elements that should appear across multiple pages (e.g., "glowing blue fireflies", "twisted silver trees with golden leaves", "pink cherry blossom petals floating in the air")
- Specify the dominant color palette for the environment
- These details anchor the reader in a single, coherent visual world

TITLE PAGE / COVER (FC-012):
- Also produce a "titlePage" object — this is the book's cover, generated as a separate hero illustration.
- titlePage.text: the on-cover display text. Always include the book's title (same value as the top-level "title" field). Optionally append " · Starring ${input.childName}" or a similar short attribution as a smaller secondary line — keep total cover text short (<= 60 characters) since Gemini's in-image text accuracy degrades on longer strings.
- titlePage.sceneDescription: a hero scene featuring the main characters in the book's signature setting, composed for a book cover (characters central, evocative pose, signature setting elements visible). Should capture the spirit of the book WITHOUT spoiling the ending. This will be illustrated as ONE landscape image, not a multi-page sequence.

OUTPUT FORMAT:
Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "title": "The Story Title",
  "titlePage": {
    "text": "The Story Title",
    "sceneDescription": "Hero scene for the cover: characters central, evocative pose, signature setting elements visible. No spoilers."
  },
  "characterSheets": [
    {
      "name": "Character Name",
      "description": "DETAILED visual description: species/type, exact body colors and patterns, size, clothing (colors and style), hairstyle/fur texture, distinguishing features, eye color, body shape. Be extremely specific."
    }
  ],
  "settingIdentity": {
    "name": "Setting Name",
    "description": "DETAILED visual description: dominant colors, lighting quality, key recurring landmarks or environmental features, time of day, weather/atmosphere, ground/sky appearance."
  },
  "pages": [
    {
      "pageNumber": 1,
      "text": "The story text that will appear on this page. Keep it simple and engaging for young readers.",
      "sceneDescription": "Visual description for this specific page. Do NOT re-describe character appearances (those are in characterSheets). Instead describe: character poses, expressions, and positions; what action is happening; which setting elements are visible; any new objects unique to this page; the emotional mood."
    }
  ]
}

SCENE DESCRIPTION TIPS:
- Reference characters by NAME only — the illustrator will use characterSheets for their appearance
- Be specific about character positions, expressions, and poses
- Mention which setting elements from settingIdentity are visible in this scene
- Indicate the emotional tone and atmosphere
- Include small details that make the scene feel alive

Generate the complete ${pageCount}-page story now.`;
}
