import { ArtStyle } from '../types';
import { ASPECT_RATIO_INSTRUCTION } from './aspect';

/**
 * Style descriptors mirrored from illustration.ts and characterReference.ts.
 * If the canonical map there changes, mirror the change here. (Triple
 * duplication is acknowledged smell — extracting to a shared module is a
 * follow-up after the four-FC overhaul lands.)
 */
const STYLE_DESCRIPTIONS: Record<ArtStyle, string> = {
  'watercolor': 'soft watercolor illustration with gentle colors, dreamy brushstrokes, and delicate washes of color',
  'cartoon': 'whimsical cartoon style with bold black outlines, vibrant saturated colors, and playful expressions',
  'storybook-classic': "classic children's book illustration with warm nostalgic colors, detailed but gentle linework, and a timeless feel",
  'claymation': 'charming claymation-style 3D render with soft textures, rounded shapes, and stop-motion animation aesthetic like Wallace & Gromit',
  'studio-ghibli': 'beautiful Studio Ghibli-inspired illustration with soft watercolors, detailed backgrounds, and magical atmospheric lighting',
  'pixar-3d': 'polished Pixar-style 3D render with smooth surfaces, expressive characters, vibrant colors, and cinematic lighting',
};

/**
 * Build a TITLE PAGE / COVER prompt for FC-012.
 *
 * The output is one landscape image suitable both for the reader's first page
 * and (when 3:4-portrait-cropped by the library card) for a thumbnail. The
 * cover renders the book title text inside the artwork and features the main
 * characters in a hero pose using the FC-013 character reference images as
 * visual anchors (passed as multimodal inputs by gemini.ts).
 *
 * Composition notes:
 *  - Landscape orientation (matches the reader's full-page render).
 *  - Central subject placement so a 3:4 portrait crop (library thumbnail)
 *    doesn't decapitate the focal character.
 *  - On-image text is short — at most ~60 chars per the story prompt — to
 *    stay inside Gemini's reliable in-image text accuracy band.
 *  - No spoilers (per the story prompt's sceneDescription contract; the
 *    illustrator just renders what the LLM described).
 */
export function buildTitlePagePrompt(
  titleText: string,
  sceneDescription: string,
  style: ArtStyle = 'watercolor',
  characterReferences?: Array<{ name: string }>,
): string {
  const styleDesc = STYLE_DESCRIPTIONS[style];

  const refsBlock =
    characterReferences && characterReferences.length > 0
      ? `

CHARACTER REFERENCE IMAGES ATTACHED:
The first ${characterReferences.length} reference image(s) attached to this prompt are the canonical model sheets for the named characters in this story. Each reference shows ONE character from front, three-quarter, and action poses on a white background. Use these as the visual ground truth — match each character's appearance EXACTLY when they appear on the cover:
${characterReferences.map((c, i) => `- Reference image ${i + 1} = ${c.name}`).join('\n')}`
      : '';

  return `Create a ${styleDesc} BOOK COVER for a children's picture book ages 3-8.

COVER SCENE:
${sceneDescription}
${refsBlock}

ON-COVER TEXT (RENDER EXACTLY AS WRITTEN):
"${titleText}"

TEXT REQUIREMENTS:
- The exact text above must appear on the cover, spelled correctly, character-for-character
- Render in playful, friendly display lettering appropriate for children
- Position at top OR bottom of the image (your choice based on composition); leave the central area for the hero illustration
- High contrast against the background behind it (use a soft wash if needed for legibility)

COMPOSITION:
- LANDSCAPE orientation (wider than tall) — this is a full-page cover image
- ${ASPECT_RATIO_INSTRUCTION}
- Central subject placement: the main character(s) should sit roughly in the center of the frame so a portrait-aspect crop (used as a library thumbnail) shows them cleanly without cutting heads off
- Cover should evoke the spirit of the book at a glance
- Bright, saturated, joyful colors with warm undertones

CONSTRAINTS:
- NO scary, dark, violent, or threatening elements
- NO realistic human faces (stylized/cartoon only if humans appear)
- NO additional text beyond the title above (no taglines, no author lines we didn't request, no chapter numbers)
- Professional children's book cover quality`;
}
