import { ArtStyle, CharacterVisualSheet, SettingVisualIdentity, TextPosition } from '../types';

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
 * FC-015: instructions for reserving negative space at the chosen text position.
 * The mobile Skia overlay paints narration text into this reserved zone, so
 * the illustrator's job is to keep that part of the image clean and uncluttered.
 *
 * Phrasing favors composition language ("low-detail negative space",
 * "soft wash") rather than "leave a hole" — the latter consistently produced
 * a literal blank rectangle from Gemini, which looks broken if the overlay
 * fails to load.
 */
const TEXT_POSITION_RESERVATION: Record<TextPosition, string> = {
  'top':
    'Reserve the TOP ~22% of the page as low-detail negative space (open sky, soft cloud wash, gentle gradient, or quiet treetop foliage) so a typography overlay can sit there cleanly. Do NOT place the focal character or busy detail in that band.',
  'bottom':
    'Reserve the BOTTOM ~22% of the page as low-detail negative space (foreground grass, sand, water, or a soft warm wash) so a typography overlay can sit there cleanly. Do NOT place the focal character or busy detail in that band.',
  'left':
    'Reserve the LEFT ~30% of the page as low-detail negative space (open sky, distant softly washed background, foliage simplified to mood) so a typography overlay can sit there cleanly. Compose the focal character on the right two-thirds of the page.',
  'right':
    'Reserve the RIGHT ~30% of the page as low-detail negative space (open sky, distant softly washed background, foliage simplified to mood) so a typography overlay can sit there cleanly. Compose the focal character on the left two-thirds of the page.',
  'center-overlay':
    'Compose the scene normally, but ensure the CENTER of the page (roughly the middle third, both horizontally and vertically) is calm enough that a translucent typography card can sit on top of it without obscuring the focal character. Keep the focal character\'s face out of the dead center.',
};

/**
 * Build an illustration prompt for Gemini image generation
 * Features: character sheet consistency, clear text reading flow
 *
 * FC-013: when `characterReferences` is non-empty, the call also attaches
 * those character ref images as multimodal inputs (built by gemini.ts).
 * The prompt body explicitly numbers them so the model can correlate the
 * "Character reference 1: NAME" labels in `contents` with the prompt text.
 *
 * FC-015: there are now two mutually-exclusive text paths.
 *   - LEGACY (`pageText` provided, `textPosition` undefined): bake narration
 *     into the image at the bottom band. Used by stories generated before
 *     FC-015 if they're ever regenerated.
 *   - NEW (`textPosition` provided, `pageText` undefined): do NOT bake
 *     narration. Reserve negative space at the chosen position so the mobile
 *     reader can paint a Skia text overlay there. `soundEffects` (single
 *     stylized words like "Boom!", "Splash!") may still be rendered IN the
 *     image when present — these are short enough that Gemini handles them
 *     reliably and they look intentional, not like spelling errors.
 */
export function buildIllustrationPrompt(
  sceneDescription: string,
  animalType: string,
  style: ArtStyle = 'watercolor',
  pageText?: string,
  characterSheets?: CharacterVisualSheet[],
  settingIdentity?: SettingVisualIdentity,
  characterReferences?: Array<{ name: string }>,
  textPosition?: TextPosition,
  soundEffects?: string[],
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

  // FC-015: choose between legacy in-image text (when pageText is supplied and
  // textPosition is NOT — old code path) vs new negative-space reservation
  // (when textPosition is supplied — new path; narration is rendered as a
  // Skia overlay on the mobile reader and must NOT be baked into the image).
  let textInstructions: string;

  if (textPosition) {
    // NEW PATH: reserve negative space; narration will be overlaid by the app.
    const reservation = TEXT_POSITION_RESERVATION[textPosition];
    const soundEffectsBlock =
      soundEffects && soundEffects.length > 0
        ? `
STYLIZED SOUND-EFFECT WORDS IN-IMAGE (FC-015):
- Render ONLY these short stylized words IN the illustration near the relevant action: ${soundEffects.map((w) => `"${w}"`).join(', ')}
- These are sound effects (e.g., "Boom!", "Splash!") — render them in expressive comic-style typography that fits the moment
- Keep each word small-to-medium and complementary to the scene; never dominant
- Do NOT add any other words. Do NOT add narration. Do NOT add labels, captions, or signs containing other text`
        : `
NO OTHER TEXT IN THE IMAGE (FC-015):
- Do NOT render narration, captions, dialogue text, labels, signs, or letters of any kind in the illustration
- The narrative text for this page is rendered separately as a typography overlay by the reader app — your image should contain ZERO words`;

    textInstructions = `
TEXT LAYOUT — RESERVE NEGATIVE SPACE FOR OVERLAY (FC-015):
${reservation}

The narrative text for this page is NOT baked into the image. The mobile reader composes it as a Skia typography overlay positioned exactly in the reserved zone above. Your job is to keep that zone clean and uncluttered so the overlay reads sharply.
${soundEffectsBlock}`;
  } else if (pageText) {
    // LEGACY PATH: bake narration into the image at the bottom band.
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
- Text should feel like it belongs to the artwork but must prioritize readability`;
  } else {
    textInstructions = `
IMPORTANT: NO text, words, letters, or numbers in the image`;
  }

  // Composition guidance shifts depending on path:
  //   - LEGACY (pageText baked in): keep the historical "TEXT ZONE / ILLUSTRATION ZONE" rule
  //   - FC-015 (textPosition reserved): describe the reservation contract instead
  //   - No-text fallback: just say "fully illustrated, no text zone"
  let compositionBlock: string;
  if (textPosition) {
    compositionBlock = `COMPOSITION:
- This is a FULL picture book page composed in landscape orientation
- The narrative text overlay will be painted by the reader app at the position described in TEXT LAYOUT above — keep that zone calm and uncluttered
- The illustration occupies the full page; the focal character/action belongs in the OPPOSITE region from the reserved text zone
- Use a clear focal point (characters should be prominent)
- Landscape orientation (wider than tall)`;
  } else if (pageText) {
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
- Age-appropriate for children ages 3-8 years old`;
}
