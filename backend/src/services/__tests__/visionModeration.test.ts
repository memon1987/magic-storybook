/**
 * FC-041 — unit tests for the vision moderation gate (visionModeration.ts).
 *
 * All model calls are MOCKED (a synchronous/async `generate` stub) — zero real
 * API/image calls, cost cap $0. These assert BEHAVIOR (fail-closed on every
 * path, no content leak, first-block short-circuit), not implementation.
 *
 * The load-bearing contract mirrors moderateStoryText:
 *   - resolves ONLY on an explicit `verdict: "safe"`;
 *   - throws ModerationBlockedError (message matches /safety|blocked|policy/i,
 *     which worker.ts sanitizeFailureReason maps to 'safety_blocked') on
 *     unsafe / malformed / rejected / timed-out / missing-verdict;
 *   - blocks the whole batch on the FIRST unsafe image and does NOT classify
 *     images after it;
 *   - never leaks image/story tokens into the thrown error.
 */
import { describe, it, expect, vi } from 'vitest';

// The visionModeration module imports gcsDownload transitively? No — it does
// not. But moderation.ts (imported for ModerationBlockedError/sanitizeCategory/
// extractFirstJsonObject) imports instrumentation only. Neither reads env at
// module load, so no env stubbing is required for these unit tests.
import {
  moderatePageImage,
  moderateStoryImages,
  buildVisionModerationPrompt,
  ModeratableImage,
} from '../visionModeration';
import { ModerationBlockedError } from '../moderation';

const IMG: ModeratableImage = { data: 'ZmFrZQ==', mimeType: 'image/png', label: 'page-1' };

function safe(category = 'none'): string {
  return JSON.stringify({ verdict: 'safe', category, reason: 'ok' });
}

describe('FC-041 buildVisionModerationPrompt', () => {
  it('is fixed text with no story interpolation and marks the image as untrusted', () => {
    const p = buildVisionModerationPrompt();
    expect(p).toMatch(/UNTRUSTED DATA/);
    expect(p).toMatch(/ages 3-8/);
    // JSON verdict schema is requested.
    expect(p).toMatch(/"verdict"/);
    // Prompt is a constant — does not vary with the image.
    expect(buildVisionModerationPrompt()).toBe(p);
  });
});

describe('FC-041 moderatePageImage (single image)', () => {
  it('SAFE verdict → resolves, classifier called once', async () => {
    const generate = vi.fn().mockResolvedValue(safe());
    await expect(moderatePageImage(IMG, generate, { storyId: 's' })).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
    // The image bytes are passed to generate as the second arg.
    expect(generate.mock.calls[0][1]).toEqual({ data: IMG.data, mimeType: IMG.mimeType });
  });

  it('UNSAFE verdict → throws ModerationBlockedError with safety-blocked message', async () => {
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ verdict: 'unsafe', category: 'violence', reason: 'gore' }),
    );
    await expect(moderatePageImage(IMG, generate, { storyId: 's' })).rejects.toBeInstanceOf(
      ModerationBlockedError,
    );
    await expect(moderatePageImage(IMG, generate)).rejects.toThrow(/safety|blocked|policy/i);
  });

  it('malformed / non-JSON output → fail-closed (throws)', async () => {
    const generate = vi.fn().mockResolvedValue('I think this picture is fine!');
    await expect(moderatePageImage(IMG, generate)).rejects.toThrow(/safety|blocked|policy/i);
  });

  it('valid JSON but MISSING verdict field → fail-closed (throws)', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ category: 'none', reason: 'ok' }));
    await expect(moderatePageImage(IMG, generate)).rejects.toThrow(/safety|blocked|policy/i);
  });

  it("verdict is a non-'safe' string → fail-closed (throws)", async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ verdict: 'SAFE ' }));
    await expect(moderatePageImage(IMG, generate)).rejects.toThrow(/safety|blocked|policy/i);
  });

  it('classifier REJECTS → fail-closed (throws)', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('gemini 503 UNAVAILABLE'));
    await expect(moderatePageImage(IMG, generate)).rejects.toThrow(/safety|blocked|policy/i);
  });

  it('classifier TIMES OUT (never resolves) → fail-closed (throws) under a short timeout', async () => {
    // generate never settles; the 5ms timeout must win the race and block.
    const generate = vi.fn().mockReturnValue(new Promise<string>(() => {}));
    await expect(
      moderatePageImage(IMG, generate, { storyId: 's', timeoutMs: 5 }),
    ).rejects.toThrow(/safety|blocked|policy/i);
  });

  it('a late REJECTION after a timeout does NOT surface as an unhandledRejection', async () => {
    // generate rejects AFTER the timeout has already fired. The `.catch(()=>{})`
    // guard must swallow the orphaned rejection so the process is not crashed.
    let onUnhandled: ((r: unknown) => void) | undefined;
    const spy = vi.fn();
    onUnhandled = spy;
    process.on('unhandledRejection', onUnhandled);
    try {
      const generate = vi.fn().mockImplementation(
        () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error('late')), 20)),
      );
      await expect(
        moderatePageImage(IMG, generate, { timeoutMs: 5 }),
      ).rejects.toThrow(/safety|blocked|policy/i);
      // Give the late rejection time to fire and be swallowed.
      await new Promise((r) => setTimeout(r, 40));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('tolerates markdown-fenced JSON and trailing prose (does not false-block a safe image)', async () => {
    const generate = vi
      .fn()
      .mockResolvedValue('```json\n{"verdict":"safe","category":"none"}\n```\nLooks great!');
    await expect(moderatePageImage(IMG, generate)).resolves.toBeUndefined();
  });

  it('NO image/story token leaks into the thrown error (category is sanitized to the allowlist)', async () => {
    // The classifier echoes a distinctive SECRET token in its free-form
    // category + reason. sanitizeCategory must map onto the fixed allowlist so
    // the SECRET never reaches the error message.
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({
        verdict: 'unsafe',
        category: 'SECRET_LEAK_TOKEN_violence',
        reason: 'SECRET_LEAK_TOKEN baked text says something',
      }),
    );
    let caught: unknown;
    try {
      await moderatePageImage(IMG, generate);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModerationBlockedError);
    const msg = (caught as Error).message;
    expect(msg).not.toMatch(/SECRET_LEAK_TOKEN/);
    // The substring 'violence' still maps to the 'violence' allowlist bucket.
    expect(msg).toMatch(/violence/);
    // And the raw payload token ('page-1' is fine — bounded label — but the
    // base64 image data must never appear).
    expect(msg).not.toMatch(/ZmFrZQ==/);
  });
});

describe('FC-041 moderateStoryImages (batch)', () => {
  const mkImg = (label: string): ModeratableImage => ({ data: 'ZmFrZQ==', mimeType: 'image/png', label });

  it('all-safe batch → resolves; classifier called once per image', async () => {
    const generate = vi.fn().mockResolvedValue(safe());
    const images = [mkImg('title'), mkImg('page-1'), mkImg('page-2')];
    await expect(moderateStoryImages(images, generate, { storyId: 's' })).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('empty batch → resolves without any classifier call', async () => {
    const generate = vi.fn().mockResolvedValue(safe());
    await expect(moderateStoryImages([], generate)).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
  });

  it('the Nth image unsafe → blocks the whole batch AND short-circuits (later images NOT classified)', async () => {
    const images = [mkImg('title'), mkImg('page-1'), mkImg('page-2'), mkImg('page-3')];
    // title + page-1 safe, page-2 unsafe, page-3 should NEVER be classified.
    const generate = vi
      .fn()
      .mockResolvedValueOnce(safe()) // title
      .mockResolvedValueOnce(safe()) // page-1
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'unsafe', category: 'weapons' })) // page-2
      .mockResolvedValueOnce(safe()); // page-3 (must not be reached)
    await expect(moderateStoryImages(images, generate, { storyId: 's' })).rejects.toThrow(
      /safety|blocked|policy/i,
    );
    // 3 calls: title, page-1, page-2 (the block). page-3 short-circuited.
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it('first image unsafe → blocks immediately, no further classifier calls', async () => {
    const images = [mkImg('title'), mkImg('page-1')];
    const generate = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ verdict: 'unsafe', category: 'sexual' }));
    await expect(moderateStoryImages(images, generate)).rejects.toThrow(/safety|blocked|policy/i);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
