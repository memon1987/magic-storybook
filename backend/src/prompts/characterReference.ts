import { ArtStyle } from '../types';

/**
 * Style descriptors used by the regular illustration prompt — duplicated here
 * intentionally so the character model sheet matches the book's art style.
 * If illustration.ts changes its style descriptions, mirror the change here.
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
 * Build a character "model sheet" reference image prompt for FC-013.
 *
 * The output is a clean reference image showing one character in 3 poses
 * (front, three-quarter, action) on a plain white background, with the
 * character's name labeled beneath the figures. This image is then passed as
 * a multimodal reference to every page generation in the story so the model
 * has a stable visual anchor for the character's appearance across pages.
 *
 * Deliberate constraints:
 *  - No scene context (no setting, no other characters, no props beyond what
 *    the character description says they wear/carry)
 *  - White background (matches the "model sheet" convention used by animation
 *    studios for character bibles)
 *  - Same art style as the book's pages (so the character looks "from the same
 *    book" when the model later generates story pages)
 *  - Name label only — no other text (the page-generation prompts will refer
 *    to the character by name and need the name visible in the reference)
 */
export function buildCharacterReferencePrompt(
  name: string,
  description: string,
  style: ArtStyle = 'watercolor',
): string {
  const styleDesc = STYLE_DESCRIPTIONS[style];

  return `Create a CHARACTER MODEL SHEET in ${styleDesc} style.

CHARACTER:
- Name: ${name}
- Appearance (follow this EXACTLY): ${description}

LAYOUT:
- Plain white background, no scenery, no props beyond what the character naturally wears or carries
- Three views of the SAME character arranged side by side, all at roughly the same scale:
  1. FRONT view (left): character facing the viewer head-on
  2. THREE-QUARTER view (center): character at a 45-degree angle, slight body turn
  3. ACTION pose (right): character in a dynamic pose that shows their personality (running, jumping, waving, hugging — pick what suits this character)
- Below the three figures, in clear bold lettering, the character's name: "${name}"

CONSTRAINTS:
- Only ONE character in the image (the character above, three times)
- NO other characters, NO scenery, NO speech bubbles, NO additional text other than the name label
- All three views must depict EXACTLY the same character with identical colors, clothing, proportions, and distinguishing features
- Style suitable for a children's picture book ages 3-8: friendly, expressive, age-appropriate
- High clarity — this image will be used as a reference for the model when generating subsequent story pages, so the character's distinguishing features must be unambiguous`;
}
