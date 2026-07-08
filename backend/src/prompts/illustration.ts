import { ArtStyle, CharacterVisualSheet, SettingVisualIdentity } from '../types';
import { ASPECT_RATIO_INSTRUCTION } from './aspect';

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
 * Build an illustration prompt for Gemini image generation.
 * Features: character-sheet consistency, narration baked into the image with a
 * clear reading flow, playful sound-effect lettering, and accented emphasis.
 *
 * FC-013: when `characterReferences` is non-empty, the call also attaches those
 * character ref images as multimodal inputs (built by gemini.ts). The prompt
 * body numbers them so the model can correlate the "Character reference 1: NAME"
 * labels in `contents` with the prompt text.
 *
 * FC-020: narration text is BAKED INTO the image (the FC-015/018 Skia overlay
 * was removed). `pageText` is the exact narration; `soundEffects` are short
 * stylized onomatopoeia; `emphasizedWords` (a subset of pageText) are accented.
 * When `pageText` is empty the page renders with no text (defensive fallback).
 */
export function buildIllustrationPrompt(
  sceneDescription: string,
  animalType: string,
  style: ArtStyle = 'watercolor',
  pageText?: string,
  characterSheets?: CharacterVisualSheet[],
  settingIdentity?: SettingVisualIdentity,
  characterReferences?: Array<{ name: string }>,
  soundEffects?: string[],
  emphasizedWords?: string[],
): string {
  const styleDesc = STYLE_DESCRIPTIONS[style];

  // Build character consistency block
  const refsBlock = characterReferences && characterReferences.length > 0
    ? `

CHARACTER REFERENCE IMAGES ATTACHED:
The first ${characterReferences.length} reference image(s) attached to this prompt are the canonical model sheets for the named characters in this story. Each reference shows ONE character from front, three-quarter, and action poses on a white background. Use these as the visual ground truth — match each character's appearance EXACTLY when they appear on this page:
${characterReferences.map((c, i) => `- Reference image ${i + 1} = ${c.name}`).join('\n')}
If a setting reference image is also attached, it is the page-1 illustration of this story; use it for color palette, art style, and environmental details.`
    : '';

  const characterBlock = characterSheets && characterSheets.length > 0
    ? `CHARACTER REFERENCE SHEET — FOLLOW EXACTLY ON EVERY PAGE:
${characterSheets.map(c => `• ${c.name}: ${c.description}`).join('\n')}

CONSISTENCY IS CRITICAL: The characters described above must look IDENTICAL on every page of this book. Do not change their colors, clothing, proportions, or distinguishing features. A reader flipping between pages must recognize the same characters instantly.${refsBlock}`
    : `CHARACTER REQUIREMENTS:
- The ${animalType} should be friendly, round, and huggable with exaggerated expressions
- BIG expressive eyes that clearly convey emotion
- Soft, rounded, bouncy shapes - no sharp edges
- Consistent character design suitable for a picture book series${refsBlock}`;

  // Build setting consistency block
  const settingBlock = settingIdentity && settingIdentity.description
    ? `SETTING VISUAL IDENTITY — MAINTAIN ACROSS ALL PAGES:
${settingIdentity.name}: ${settingIdentity.description}`
    : '';

  // FC-020: narration is baked into the image. Fallback to "no text" only when
  // pageText is empty (defensive — production always supplies it).
  let textInstructions: string;

  if (pageText) {
    textInstructions = `
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
${soundEffects && soundEffects.length > 0 ? `
4. PLAYFUL SOUND-EFFECT LETTERING (IMPORTANT — this is what makes it feel like a real picture book):
   - Render these onomatopoeia word(s) as BOLD, LARGE, PLAYFULLY ILLUSTRATED lettering integrated INTO the scene, near the action that makes the sound: ${soundEffects.map((w) => `"${w}"`).join(', ')}
   - Style them like classic picture books do — Pout-Pout Fish "glub glub glub", Dr. Seuss bouncing onomatopoeia: hand-drawn, expressive, following the motion/energy of the moment (curving, bouncing, dripping, exploding — whatever fits the sound)
   - Use color, scale, and motion so the sound word is FUN and dramatic — this is separate from the calm narration band and SHOULD stand out
   - These are SHORT single words; spell them exactly as given` : `
4. SOUND EFFECTS:
   - None for this page — keep the illustration free of extra onomatopoeia`}

5. EMPHASIS:${emphasizedWords && emphasizedWords.length > 0 ? `
   - Within the narration, make these key word(s) pop with larger size and/or an accent color so they carry emotional punch: ${emphasizedWords.map((w) => `"${w}"`).join(', ')}
   - They must remain IN the reading flow (do not pull them to a separate corner), just visually emphasized` : `
   - Key emotional words can be slightly larger or a different color, but must remain IN the reading flow`}

TEXT STYLING:
- Narration: clear, rounded, hand-lettered style that is friendly and highly legible (dark text on a soft light wash)
- Sound-effect words: free to be bold, colorful, and dramatically styled (the playful counterpoint to the calm narration)
- Large enough to read comfortably on a phone screen
- Text should feel hand-made and part of the artwork, like a real children's-book illustrator lettered the page`;
  } else {
    textInstructions = `
IMPORTANT: NO text, words, letters, or numbers in the image`;
  }

  // Composition guidance: baked-text page keeps the "TEXT ZONE / ILLUSTRATION
  // ZONE" rule; the no-text fallback is "fully illustrated, no text zone".
  let compositionBlock: string;
  if (pageText) {
    compositionBlock = `COMPOSITION:
- This is a FULL picture book page with a clear TEXT ZONE and ILLUSTRATION ZONE
- The text zone (bottom band) blends softly into the illustration through a gradient or soft wash
- The illustration occupies the majority of the page (top ~75%)
- Clear focal point (characters should be prominent)
- Landscape orientation (wider than tall)`;
  } else {
    compositionBlock = `COMPOSITION:
- Fully illustrated landscape page; no text zone
- Clear focal point (characters should be prominent)
- Landscape orientation (wider than tall)`;
  }

  return `Create a ${styleDesc} children's picture book page.

${characterBlock}

${settingBlock}

SCENE TO ILLUSTRATE:
${sceneDescription}
${textInstructions}

VISUAL STYLE INFLUENCES:
- Dr. Seuss: Imaginative shapes, whimsical settings, expressive characters
- Pout-Pout Fish: Dreamy colors, expressive characters, immersive environments
- Classic picture books: text and art as ONE unified composition

COLOR PALETTE:
- Bright, saturated, joyful colors
- Soft pastels mixed with vibrant pops
- Warm undertones throughout
- High contrast for visual interest and text readability

${compositionBlock}

IMPORTANT CONSTRAINTS:
- NO scary, dark, violent, or threatening elements
- NO realistic human faces (stylized/cartoon only if humans appear)
- Everything must be magical, warm, gentle, and child-friendly
- Professional children's book illustration quality
- Age-appropriate for children ages 3-8 years old

${ASPECT_RATIO_INSTRUCTION}`;
}
