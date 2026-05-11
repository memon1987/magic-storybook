import { StoryInput, WritingStyleId } from '../types';

/**
 * Structural voice descriptors for FC-014's 3-voice writing-style picker.
 * Author names deliberately excluded; descriptors are purely structural so the
 * LLM has no copyrighted reference to draw from.
 */
const WRITING_STYLE_DESCRIPTORS: Record<WritingStyleId, string> = {
  'bouncy-rhymes':
    'Write in rhyming couplets with an energetic, anapestic-leaning rhythm. Use AABB rhyme scheme. Repeat key phrases for emphasis. Sprinkle in exclamations. Keep vocabulary at kindergarten level with punchy single-syllable words where possible.',
  'gentle-refrains':
    'Write with repetitive refrains and sensory adjectives. Use a day-by-day or step-by-step progression. Each page should echo a phrase from the previous page. Vocabulary is simple, soft, and concrete. Avoid sharp consonants where possible — favor flowing word sounds.',
  'sweet-simple':
    'Write in very short sentences — 3 to 7 words each. Use questions to engage the child. Include sound words and onomatopoeia. Convey big emotions through simple words. Use lots of repetition and direct address (you, your, my).',
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
  if (input.writingStyle && WRITING_STYLE_DESCRIPTORS[input.writingStyle]) {
    styleGuide = WRITING_STYLE_DESCRIPTORS[input.writingStyle];
  } else if (input.authorStyle) {
    styleGuide = `Write in the style of ${input.authorStyle}, capturing their unique voice, rhythm, and storytelling approach.`;
  } else {
    styleGuide = 'Write in a warm, engaging, and gentle children\'s book style with simple but evocative language.';
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
2. Each page should have 2-4 short, engaging sentences (30-60 words max per page)
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
- Each entry must be EXHAUSTIVELY detailed about visual appearance — imagine briefing an illustrator who must draw this character identically across ${pageCount} pages
- Include: species/type, exact body colors and patterns, approximate size, clothing (specific colors, style, accessories), hairstyle/fur texture, distinguishing features (e.g., a red scarf, freckles, a curly tail), eye color, and body shape
- Use specific colors ("sky blue", "golden yellow") not vague ("blue", "yellow")
- Include 2-3 signature visual traits per character that make them instantly recognizable

SETTING VISUAL CONSISTENCY:
- Create a "settingIdentity" object describing the visual world of this story
- Include 3-5 specific recurring visual elements that should appear across multiple pages (e.g., "glowing blue fireflies", "twisted silver trees with golden leaves", "pink cherry blossom petals floating in the air")
- Specify the dominant color palette for the environment
- These details anchor the reader in a single, coherent visual world

OUTPUT FORMAT:
Return ONLY valid JSON with this exact structure (no markdown, no code blocks):
{
  "title": "The Story Title",
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
