import React, { useMemo } from 'react';
import {
  Group,
  Paragraph,
  RoundedRect,
  Skia,
  TextAlign,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import {
  StoryPage,
  TextPosition,
  WritingStyleId,
  WRITING_STYLE_FONT_MAP,
  DEFAULT_OVERLAY_FONT,
} from '../../services/api';

interface PageTextLayerProps {
  /** Page whose narration should be rendered. Pass null to render nothing. */
  page: StoryPage | null;
  /** Story-level writing style; selects the font family. */
  writingStyle?: WritingStyleId | null;
  /** Skia font provider; required to lay out the paragraph. */
  fontMgr: SkTypefaceFontProvider | null;
  /**
   * Canvas width in dp (matches the Canvas style.width prop in Curl). Skia
   * draws happen in dp coordinates inside the Canvas regardless of which
   * Group nesting level this layer is rendered at — the inner group's
   * `scale: pd` is cancelled by the outer group's `scale: 1/pd`, leaving
   * net dp space.
   */
  width: number;
  /** Canvas height in dp (see `width` note). */
  height: number;
  /** Accent color for emphasized words. */
  accentColor: string;
  /** Translucent backing-rect color for legibility over the illustration. */
  backingColor: string;
  /** Body text color. */
  textColor: string;
}

/**
 * FC-015: Skia node fragment that renders narration text inside the page-curl
 * Group. Because it lives inside the same `<Group layer={Paint with RuntimeShader}>`
 * that the curl shader operates on, the text is composited into the offscreen
 * layer FIRST and then deformed by the shader — meaning the text curls with
 * the page rather than sliding around as an independent overlay.
 *
 * Rendering contract:
 *   - `page === null` OR `page.textPosition` undefined / null → render nothing.
 *     This is how legacy stories (text already baked into the image) opt out.
 *   - `fontMgr === null` (Skia font registration still loading or failed)
 *     → render nothing. Reader logs the failure on first miss.
 *   - Otherwise: build a Paragraph with the writing-style font + emphasized
 *     words highlighted, lay it out at the chosen position with a translucent
 *     backing rounded-rect for contrast.
 */
export function PageTextLayer({
  page,
  writingStyle,
  fontMgr,
  width,
  height,
  accentColor,
  backingColor,
  textColor,
}: PageTextLayerProps) {
  const layout = useMemo(() => {
    if (!page || !page.textPosition || !fontMgr) return null;

    // Review fix HIGH-2: a single bad page (malformed color, builder API
    // contract violation across Skia versions, fontMgr in a bad state, etc.)
    // would otherwise throw during render and crash the whole reader screen
    // (no ErrorBoundary in the tree). Catch + return null → reader shows the
    // illustration with no overlay, matches the plan's graceful-degradation
    // contract for the font-load-failed case.
    try {
      const fontFamily = writingStyle
        ? WRITING_STYLE_FONT_MAP[writingStyle] ?? DEFAULT_OVERLAY_FONT
        : DEFAULT_OVERLAY_FONT;

      const zone = computeZone(page.textPosition, width, height);

      // Review fix MEDIUM-3: phones (typical landscape height ≈ 375-430 dp)
      // would all hit the previous floor of 22 dp — too small for early
      // readers at arm's length. Raised floor to 26; new formula puts iPhone
      // 14 landscape at ~26-29 dp and tablets near the 48 cap.
      const baseFontSize = Math.min(48, Math.max(26, height / 18));
      const emphFontSize = baseFontSize * 1.22;

      // Review fix MEDIUM-5: removed maxLines cap — silent truncation on a
      // children's book is the worst failure mode. If a long narration
      // overflows the zone, that's a visible bug we can iterate on (story
      // prompt nudge or position re-pick), not data the user is missing.
      const paragraphStyle = {
        textAlign:
          page.textPosition === 'left'
            ? TextAlign.Left
            : page.textPosition === 'right'
              ? TextAlign.Right
              : TextAlign.Center,
      };

      const baseTextStyle = {
        color: Skia.Color(textColor),
        fontFamilies: [fontFamily],
        fontSize: baseFontSize,
        heightMultiplier: 1.25,
      };
      const emphTextStyle = {
        ...baseTextStyle,
        color: Skia.Color(accentColor),
        fontSize: emphFontSize,
        fontStyle: { weight: 700 } as const,
      };

      const builder = Skia.ParagraphBuilder.Make(paragraphStyle, fontMgr);
      builder.pushStyle(baseTextStyle);

      // Tokenize on emphasized-word boundaries (case-insensitive, whole-word).
      // Falls back to plain text if no emphasis or tokenization yields nothing.
      const emph = (page.emphasizedWords ?? [])
        .filter((w): w is string => typeof w === 'string' && w.trim().length > 0)
        .map((w) => w.trim());

      if (emph.length === 0) {
        builder.addText(page.text);
      } else {
        // Build an alternation regex like \b(word1|word2)\b that captures the
        // matched word so we can split-and-walk the text in original order.
        const escaped = emph.map(escapeRegExp);
        const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
        const tokens = page.text.split(pattern); // [plain, match, plain, match, ...]
        tokens.forEach((tok, i) => {
          if (tok.length === 0) return;
          const isMatch = i % 2 === 1;
          if (isMatch) {
            builder.pushStyle(emphTextStyle);
            builder.addText(tok);
            builder.pop();
          } else {
            builder.addText(tok);
          }
        });
      }

      const paragraph = builder.build();
      paragraph.layout(zone.width);
      const measuredHeight = paragraph.getHeight();

      // Review fix MEDIUM-1: re-anchor vertically per position. Previously
      // `left`/`right` used `zone.y = height/2` as the TOP of the text and
      // grew downward, ending up bottom-heavy. Now centered around midpoint.
      let finalY: number;
      switch (page.textPosition) {
        case 'top':
          finalY = zone.padding;
          break;
        case 'bottom':
          finalY = height - measuredHeight - zone.padding;
          break;
        case 'left':
        case 'right':
          finalY = (height - measuredHeight) / 2;
          break;
        case 'center-overlay':
          // Slight upward bias so a tall block doesn't sit dead-center over
          // the focal subject's face.
          finalY = Math.max(zone.padding, height * 0.32 - measuredHeight * 0.2);
          break;
      }

      // Backing rect dimensions: slight horizontal padding around the text block.
      const padX = baseFontSize * 0.6;
      const padY = baseFontSize * 0.45;
      const backingX = zone.x - padX;
      const backingY = finalY - padY;
      const backingW = zone.width + padX * 2;
      const backingH = measuredHeight + padY * 2;

      return {
        paragraph,
        x: zone.x,
        y: finalY,
        width: zone.width,
        backingX,
        backingY,
        backingW,
        backingH,
        cornerRadius: baseFontSize * 0.5,
      };
    } catch (e) {
      console.warn('PageTextLayer: paragraph build failed, rendering image without overlay', e);
      return null;
    }
  }, [page, writingStyle, fontMgr, width, height, accentColor, textColor]);

  if (!layout) return null;

  return (
    <Group>
      <RoundedRect
        x={layout.backingX}
        y={layout.backingY}
        width={layout.backingW}
        height={layout.backingH}
        r={layout.cornerRadius}
        color={backingColor}
      />
      <Paragraph
        paragraph={layout.paragraph}
        x={layout.x}
        y={layout.y}
        width={layout.width}
      />
    </Group>
  );
}

interface Zone {
  x: number;
  y: number;
  width: number;
  padding: number;
}

/**
 * Compute the X and width of the text block for a given position. The Y
 * returned here is a placeholder — the caller always recomputes `finalY`
 * after measuring the paragraph height (review fix MEDIUM-1). We only return
 * `y` so the Zone shape stays simple; the value is not load-bearing.
 */
function computeZone(position: TextPosition, width: number, height: number): Zone {
  // Padding scales with canvas size so the layout looks consistent at any
  // resolution. Roughly 4% of the smaller dimension.
  const padding = Math.max(16, Math.min(width, height) * 0.04);

  switch (position) {
    case 'top':
    case 'bottom':
      return { x: padding, y: 0, width: width - padding * 2, padding };
    case 'left': {
      const w = Math.min(width * 0.42, 520);
      return { x: padding, y: 0, width: w, padding };
    }
    case 'right': {
      const w = Math.min(width * 0.42, 520);
      return { x: width - w - padding, y: 0, width: w, padding };
    }
    case 'center-overlay': {
      const w = Math.min(width * 0.7, 720);
      return { x: (width - w) / 2, y: 0, width: w, padding };
    }
  }
}

/**
 * Standard JS regex escape — local to keep the file self-contained.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
