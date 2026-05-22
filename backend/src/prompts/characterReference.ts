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
 * (front, three-quarter, action) on a plain white background. This image is
 * passed as a multimodal reference to every page generation in the story so
 * the model has a stable visual anchor for the character's appearance across
 * pages.
 *
 * Deliberate constraints:
 *  - No scene context (no setting, no other characters, no props beyond what
 *    the character description says they wear/carry)
 *  - White background (matches the "model sheet" convention used by animation
 *    studios for character bibles)
 *  - Same art style as the book's pages (so the character looks "from the same
 *    book" when the model later generates story pages)
 *  - NO text or labels of any kind. (Earlier versions asked for a name label
 *    beneath the figures, but Gemini's text-rendering accuracy on multi-word
 *    names was poor and the misspelled labels added noise to the reference
 *    image. Page-generation prompts address characters by name in the prompt
 *    body; they don't need to read the name off the multimodal image.)
 */
/**
 * FC-019: build a CAST LINEUP reference showing ALL named characters together
 * at correct relative scale, on a white background. Solves the "relative size
 * drifts between characters" problem observed in the bakeoff — per-character
 * model sheets (each alone, each filling its frame) give the model no anchor
 * for how big the characters are relative to each other, so it re-guesses the
 * size ratio every page. A single lineup image fixes that ratio.
 */
export function buildCastReferencePrompt(
  characters: Array<{ name: string; description: string }>,
  style: ArtStyle = 'watercolor',
): string {
  const styleDesc = STYLE_DESCRIPTIONS[style];
  const roster = characters
    .map((c, i) => `${i + 1}. ${c.name}: ${c.description}`)
    .join('\n');

  return `Create a CHARACTER CAST LINEUP in ${styleDesc} style.

PURPOSE: a group reference that fixes the RELATIVE SIZE and proportions of all
characters in this book. This image will anchor how big each character is
compared to the others across every page.

CHARACTERS (depict ALL of them, standing together in one row):
${roster}

LAYOUT:
- Plain white background, no scenery, no props beyond what each character naturally wears or carries
- All characters standing side by side in a single straight row, full body, facing the viewer, neutral friendly poses
- CRITICAL: depict each character at their CORRECT RELATIVE HEIGHT AND SIZE based on the descriptions above (e.g. a small animal should be visibly smaller than a child; characters of similar size should match). Their feet should rest on the same ground line so heights are directly comparable.
- Even spacing between characters; none overlapping

CONSTRAINTS:
- Each character appears EXACTLY ONCE
- Identical colors, clothing, proportions, and distinguishing features as their individual descriptions
- NO scenery, NO speech bubbles, NO text or labels of any kind
- Style suitable for a children's picture book ages 3-8
- High clarity — this is a reference image; the size relationships must be unambiguous`;
}

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

CONSTRAINTS:
- Only ONE character in the image (the character above, three times)
- NO other characters, NO scenery, NO speech bubbles, NO text or labels of any kind. This is a pure visual reference; the character's identity is established by the figures themselves, not by labels.
- All three views must depict EXACTLY the same character with identical colors, clothing, proportions, and distinguishing features
- Style suitable for a children's picture book ages 3-8: friendly, expressive, age-appropriate
- High clarity — this image will be used as a reference for the model when generating subsequent story pages, so the character's distinguishing features must be unambiguous`;
}
