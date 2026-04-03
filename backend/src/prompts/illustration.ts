import { ArtStyle, CharacterVisualSheet, SettingVisualIdentity } from '../types';

/**
 * Style descriptions for different art styles
 */
const STYLE_DESCRIPTIONS: Record<ArtStyle, string> = {
  'watercolor': 'soft watercolor illustration with gentle colors, dreamy brushstrokes, and delicate washes of color',
  'cartoon': 'whimsical cartoon style with bold black outlines, vibrant saturated colors, and playful expressions',
  'storybook-classic': 'classic children\'s book illustration with warm nostalgic colors, detailed but gentle linework, and a timeless feel',
  'claymation': 'charming claymation-style 3D render with soft textures, rounded shapes, and stop-motion animation aesthetic like Wallace & Gromit',
  'studio-ghibli': 'beautiful Studio Ghibli-inspired illustration with soft watercolors, detailed backgrounds, and magical atmospheric lighting',
  'pixar-3d': 'polished Pixar-style 3D render with smooth surfaces, expressive characters, vibrant colors, and cinematic lighting',
};

/**
 * Build an illustration prompt for Gemini image generation
 * Features: character sheet consistency, clear text reading flow
 */
export function buildIllustrationPrompt(
  sceneDescription: string,
  animalType: string,
  style: ArtStyle = 'watercolor',
  pageText?: string,
  characterSheets?: CharacterVisualSheet[],
  settingIdentity?: SettingVisualIdentity
): string {
  const styleDesc = STYLE_DESCRIPTIONS[style];

  // Build character consistency block
  const characterBlock = characterSheets && characterSheets.length > 0
    ? `CHARACTER REFERENCE SHEET — FOLLOW EXACTLY ON EVERY PAGE:
${characterSheets.map(c => `• ${c.name}: ${c.description}`).join('\n')}

CONSISTENCY IS CRITICAL: The characters described above must look IDENTICAL on every page of this book. Do not change their colors, clothing, proportions, or distinguishing features. A reader flipping between pages must recognize the same characters instantly.`
    : `CHARACTER REQUIREMENTS:
- The ${animalType} should be friendly, round, and huggable with exaggerated expressions
- BIG expressive eyes that clearly convey emotion
- Soft, rounded, bouncy shapes - no sharp edges
- Consistent character design suitable for a picture book series`;

  // Build setting consistency block
  const settingBlock = settingIdentity && settingIdentity.description
    ? `SETTING VISUAL IDENTITY — MAINTAIN ACROSS ALL PAGES:
${settingIdentity.name}: ${settingIdentity.description}`
    : '';

  // Text instructions: either embed with reading-flow layout, or no text
  const textInstructions = pageText ? `
TEXT TO EMBED IN THE IMAGE (EXACT WORDS - DO NOT CHANGE):
"${pageText}"

CRITICAL TEXT ACCURACY REQUIREMENT:
- The EXACT words above MUST appear in the image - do NOT paraphrase, summarize, or change ANY words
- Every single word must be spelled correctly and match the text EXACTLY as written
- Do NOT add extra words, remove words, or substitute synonyms
- The text in the final image must be 100% identical to the text provided above
- This is the actual story text that children will read - accuracy is essential

TEXT LAYOUT — CLEAR READING ORDER (CRITICAL):
The text MUST be readable in a natural left-to-right, top-to-bottom order. Young children are learning to read, so the reading path must be obvious and intuitive.

1. PRIMARY TEXT ZONE:
   - Place ALL story text in ONE consistent band across the BOTTOM quarter of the page
   - Use a slightly lighter or softly tinted background wash behind the text so it is always legible
   - The text zone should blend softly into the illustration above it

2. TEXT FLOW:
   - All text reads LEFT to RIGHT, TOP to BOTTOM — no exceptions
   - If text spans multiple lines, each line should be roughly the same width
   - Never scatter story words in different corners of the page
   - Never place narrative text in a circle, spiral, or non-linear path
   - A reader should be able to follow the text with their finger in a straight, smooth path

3. DIALOGUE:
   - Dialogue stays in the main text zone (do NOT use speech bubbles)
   - Show the character speaking through the illustration (open mouth, expressive gesture)

4. SOUND EFFECTS:
   - At most ONE onomatopoeia word may ALSO appear in the illustration near the relevant action
   - Keep it small and complementary, not dominant
   - The word must still appear in its correct position in the main text zone

5. EMPHASIS:
   - Key emotional words can be slightly larger or a different color
   - But they must remain IN the reading flow — never pulled out to a separate location

TEXT STYLING:
- Clear, rounded, hand-lettered style that is friendly but highly legible
- Consistent letter sizing for narrative text
- High contrast between text color and background (dark text on light wash)
- Large enough to be read comfortably on a phone screen
- Text should feel like it belongs to the artwork but must prioritize readability` : `
IMPORTANT: NO text, words, letters, or numbers in the image`;

  return `Create a ${styleDesc} children's picture book page.

${characterBlock}

${settingBlock}

SCENE TO ILLUSTRATE:
${sceneDescription}
${textInstructions}

VISUAL STYLE INFLUENCES:
- Dr. Seuss: Imaginative shapes, whimsical settings, expressive characters
- Pout-Pout Fish: Dreamy colors, expressive characters, immersive environments
- Classic picture books: Text and art as ONE unified composition, with text in a clear readable zone

COLOR PALETTE:
- Bright, saturated, joyful colors
- Soft pastels mixed with vibrant pops
- Warm undertones throughout
- High contrast for visual interest and text readability

COMPOSITION:
- This is a FULL picture book page with a clear TEXT ZONE and ILLUSTRATION ZONE
- The text zone (bottom band) blends softly into the illustration through a gradient or soft wash
- The illustration occupies the majority of the page (top ~75%)
- Clear focal point (characters should be prominent)
- Landscape orientation (wider than tall)

IMPORTANT CONSTRAINTS:
- NO scary, dark, violent, or threatening elements
- NO realistic human faces (stylized/cartoon only if humans appear)
- Everything must be magical, warm, gentle, and child-friendly
- Professional children's book illustration quality
- Age-appropriate for children ages 3-8 years old`;
}
