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
  /** Logical canvas width in PIXELS (i.e. dp * pixelDensity to match Curl's inner Group). */
  width: number;
  /** Logical canvas height in PIXELS. */
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

    const fontFamily = writingStyle
      ? WRITING_STYLE_FONT_MAP[writingStyle] ?? DEFAULT_OVERLAY_FONT
      : DEFAULT_OVERLAY_FONT;

    const zone = computeZone(page.textPosition, width, height);

    // Base font size scales with canvas height. Landscape phone is roughly
    // 400-500dp tall × pd; height/22 lands at ~32-36px which reads well at
    // arm's length. Cap to avoid overshoot on tablets.
    const baseFontSize = Math.min(48, Math.max(22, height / 22));
    const emphFontSize = baseFontSize * 1.22;

    const paragraphStyle = {
      textAlign:
        page.textPosition === 'left'
          ? TextAlign.Left
          : page.textPosition === 'right'
            ? TextAlign.Right
            : TextAlign.Center,
      maxLines: 6,
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

    // Re-anchor vertically so `bottom` and `right` zones stick to their edge.
    const finalY =
      page.textPosition === 'bottom'
        ? height - measuredHeight - zone.padding
        : page.textPosition === 'top'
          ? zone.padding
          : zone.y; // left / right / center-overlay use the precomputed center

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
 * Compute the rect (in canvas pixels) where the text block should sit. The
 * `y` returned for top/bottom is provisional — the caller re-anchors after
 * measuring the paragraph height so the block always hugs its edge cleanly.
 */
function computeZone(position: TextPosition, width: number, height: number): Zone {
  // Padding scales with canvas size so the layout looks consistent at any
  // resolution. Roughly 4% of the smaller dimension.
  const padding = Math.max(16, Math.min(width, height) * 0.04);

  switch (position) {
    case 'top':
      return { x: padding, y: padding, width: width - padding * 2, padding };
    case 'bottom':
      return { x: padding, y: 0, width: width - padding * 2, padding };
    case 'left': {
      const w = Math.min(width * 0.42, 520);
      return { x: padding, y: height / 2, width: w, padding };
    }
    case 'right': {
      const w = Math.min(width * 0.42, 520);
      return { x: width - w - padding, y: height / 2, width: w, padding };
    }
    case 'center-overlay': {
      const w = Math.min(width * 0.7, 720);
      // Bias above center so it doesn't cover the focal subject's face when
      // characters are roughly mid-canvas.
      return { x: (width - w) / 2, y: height * 0.32, width: w, padding };
    }
  }
}

/**
 * Standard JS regex escape — local to keep the file self-contained.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
