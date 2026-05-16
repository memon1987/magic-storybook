import React, { useMemo } from 'react';
import {
  Group,
  Paint,
  Paragraph,
  RadialGradient,
  Rect,
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
  /**
   * Warm halo color (FC-018) used as:
   *   - The tint of the load-bearing text shadow (the "halo" shadow that
   *     replaced the FC-015 RoundedRect backing).
   *   - The fill of the soft radial halo behind text on `center-overlay`
   *     pages (the only position that sits over the focal subject by
   *     design and needs a legibility safety net).
   *
   * MUST be a `#RRGGBB` string (no alpha). Alpha is added internally via
   * 8-digit hex suffixes for shadow + gradient stops.
   */
  haloColor: string;
  /** Body text color. */
  textColor: string;
}

/**
 * FC-015 / FC-018: Skia node fragment that renders narration text inside the
 * page-curl Group. Lives in the same `<Group layer={Paint with RuntimeShader}>`
 * the curl shader operates on, so the curl shader composites image + text into
 * the offscreen layer FIRST and then deforms that composite — text curls with
 * the page rather than floating as an independent overlay.
 *
 * FC-018 (2026-05-16) replaced the opaque rounded-rect backing with:
 *   - A multi-shadow text stack (warm halo + soft drop + tight shadow) for
 *     legibility on most backgrounds without a hard rectangle blocking the art.
 *   - An optional soft radial halo behind text — ONLY for `center-overlay`
 *     pages, where the text sits directly over the focal subject and needs a
 *     graceful-degradation safety net. Other positions trust the illustrator's
 *     reserved negative space + the shadow stack.
 *
 * Rendering contract:
 *   - `page === null` OR `page.textPosition` undefined/null → render nothing.
 *     This is how legacy stories (text already baked into the image) opt out.
 *   - `fontMgr === null` (Skia font registration still loading or failed)
 *     → render nothing.
 *   - Otherwise: build a Paragraph with the writing-style font + shadow stack
 *     + emphasized words highlighted, lay it out at the chosen position. If
 *     position is `center-overlay`, also render the radial halo behind it.
 */
export function PageTextLayer({
  page,
  writingStyle,
  fontMgr,
  width,
  height,
  accentColor,
  haloColor,
  textColor,
}: PageTextLayerProps) {
  const layout = useMemo(() => {
    if (!page || !page.textPosition || !fontMgr) return null;

    // Review fix HIGH-2 (FC-015): any throw inside paragraph build would crash
    // the reader (no ErrorBoundary in tree). Catch + return null → reader
    // shows the illustration with no overlay (matches font-load-failed
    // graceful-degradation contract).
    try {
      const fontFamily = writingStyle
        ? WRITING_STYLE_FONT_MAP[writingStyle] ?? DEFAULT_OVERLAY_FONT
        : DEFAULT_OVERLAY_FONT;

      const zone = computeZone(page.textPosition, width, height);

      // Font size scales with canvas height. Phones (landscape height
      // ~375-430 dp) land at ~26-29 dp; tablets near the 48 cap.
      const baseFontSize = Math.min(48, Math.max(26, height / 18));
      const emphFontSize = baseFontSize * 1.22;

      const paragraphStyle = {
        textAlign:
          page.textPosition === 'left'
            ? TextAlign.Left
            : page.textPosition === 'right'
              ? TextAlign.Right
              : TextAlign.Center,
      };

      // FC-018: multi-shadow text stack replaces the rounded-rect backing.
      // Array order matters — Skia paints shadows in order, all behind the
      // glyph, so widest goes FIRST. Cap at 3 (4+ has measurable jank on the
      // curl shader's offscreen layer on older Android).
      const baseShadows = [
        // (1) Warm halo — the load-bearing legibility helper. Uses palette
        //     haloColor at ~70% alpha (B3 hex). Replaces the FC-015 rect.
        { color: Skia.Color(haloColor + 'B3'), offset: { x: 0, y: 0 }, blurRadius: 16 },
        // (2) Soft drop shadow — gives the text "lift" off the page.
        { color: Skia.Color('#00000088'),       offset: { x: 0, y: 2 }, blurRadius: 5 },
        // (3) Tight near-glyph shadow — adds visual weight, fakes a subtle
        //     outline. Skia text shadow is Gaussian (no real stroke), so this
        //     reads as a soft edge-darken, not a hard outline.
        { color: Skia.Color('#00000066'),       offset: { x: 0, y: 1 }, blurRadius: 2 },
      ];
      // Emphasized words get a slightly heavier drop shadow to match their
      // larger font size — same recipe, scaled up.
      const emphShadows = [
        { color: Skia.Color(haloColor + 'B3'), offset: { x: 0, y: 0 }, blurRadius: 20 },
        { color: Skia.Color('#00000099'),       offset: { x: 0, y: 3 }, blurRadius: 7 },
        { color: Skia.Color('#00000066'),       offset: { x: 0, y: 1 }, blurRadius: 2 },
      ];

      const baseTextStyle = {
        color: Skia.Color(textColor),
        fontFamilies: [fontFamily],
        fontSize: baseFontSize,
        heightMultiplier: 1.25,
        // FC-018: heavy baseline weight for picture-book typography feel.
        fontStyle: { weight: 700 } as const,
        shadows: baseShadows,
      };
      const emphTextStyle = {
        ...baseTextStyle,
        color: Skia.Color(accentColor),
        fontSize: emphFontSize,
        fontStyle: { weight: 800 } as const,
        shadows: emphShadows,
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
        const escaped = emph.map(escapeRegExp);
        const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');
        const tokens = page.text.split(pattern);
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

      // Re-anchor vertically per position (centered for left/right, edge-
      // hugging for top/bottom, biased-upper for center-overlay).
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
          finalY = Math.max(zone.padding, height * 0.32 - measuredHeight * 0.2);
          break;
      }

      // FC-018: halo dimensions for center-overlay's radial gradient. The halo
      // extends ~1.4× the text block in each direction so the soft fade reaches
      // organically past the glyphs (rather than cutting off at a hard edge).
      const haloPadX = baseFontSize * 1.6;
      const haloPadY = baseFontSize * 1.2;
      const haloX = zone.x - haloPadX;
      const haloY = finalY - haloPadY;
      const haloW = zone.width + haloPadX * 2;
      const haloH = measuredHeight + haloPadY * 2;

      return {
        paragraph,
        x: zone.x,
        y: finalY,
        width: zone.width,
        haloX,
        haloY,
        haloW,
        haloH,
        position: page.textPosition,
      };
    } catch (e) {
      console.warn('PageTextLayer: paragraph build failed, rendering image without overlay', e);
      return null;
    }
  }, [page, writingStyle, fontMgr, width, height, accentColor, haloColor, textColor]);

  if (!layout) return null;

  return (
    <Group>
      {layout.position === 'center-overlay' && (
        // FC-018: soft radial halo only for center-overlay (the position that
        // sits over the focal subject by design). Other positions trust the
        // illustrator's reserved negative space + the shadow stack alone.
        // Alpha 8C (~55%) at center, 00 at edge, fading organically — replaces
        // the hard-edged FC-015 rect with a "page got misty here" feel.
        <Rect x={layout.haloX} y={layout.haloY} width={layout.haloW} height={layout.haloH}>
          <Paint>
            <RadialGradient
              c={{ x: layout.haloX + layout.haloW / 2, y: layout.haloY + layout.haloH / 2 }}
              r={Math.max(layout.haloW, layout.haloH) / 2}
              colors={[Skia.Color(haloColor + '8C'), Skia.Color(haloColor + '00')]}
              positions={[0, 1]}
            />
          </Paint>
        </Rect>
      )}
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
 * after measuring the paragraph height.
 */
function computeZone(position: TextPosition, width: number, height: number): Zone {
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
