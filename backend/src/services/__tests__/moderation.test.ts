/**
 * FC-037 layer 3 — output moderation gate.
 *
 * Behavioral contract (plan fc-037 "Required tests"):
 *  - mocked `generate` → unsafe verdict → throws; message matches
 *    /safety|blocked|policy/i (the sanitizeFailureReason contract)
 *  - malformed / non-JSON classifier output → throws (fail-closed)
 *  - mocked rejection / timeout → throws (fail-closed)
 *  - explicit verdict:"safe" → resolves
 *  - story text NEVER appears in the thrown message
 *
 * All model calls are mocked — no real API calls.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  moderateStoryText,
  ModerationBlockedError,
  buildModerationPrompt,
} from '../moderation';
import { GeneratedStory } from '../types';

// A story with a distinctive text token we can assert never leaks into errors.
const SECRET = 'ZEBRA_SECRET_STORY_TOKEN';
function makeStory(): GeneratedStory {
  return {
    title: `The ${SECRET} Adventure`,
    characterSheets: [{ name: 'Emma', description: 'a brave girl' }],
    settingIdentity: { name: 'forest', description: 'a green forest' },
    pages: [
      { pageNumber: 1, text: `Once upon a time ${SECRET} page one.`, sceneDescription: 's1' },
      { pageNumber: 2, text: 'And they lived happily.', sceneDescription: 's2' },
    ],
    titlePage: { text: `Cover ${SECRET}`, sceneDescription: 'cover' },
  };
}

const safeJson = JSON.stringify({ verdict: 'safe', category: 'none', reason: 'ok' });

describe('moderateStoryText — safe path', () => {
  it('resolves on an explicit verdict:"safe"', async () => {
    const generate = vi.fn().mockResolvedValue(safeJson);
    await expect(moderateStoryText(makeStory(), generate)).resolves.toBeUndefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('tolerates a markdown-fenced JSON verdict', async () => {
    const generate = vi.fn().mockResolvedValue('```json\n' + safeJson + '\n```');
    await expect(moderateStoryText(makeStory(), generate)).resolves.toBeUndefined();
  });

  it('sends the FULL story text (title + pages + titlePage) to the classifier', async () => {
    const generate = vi.fn().mockResolvedValue(safeJson);
    await moderateStoryText(makeStory(), generate);
    const promptArg = generate.mock.calls[0][0] as string;
    expect(promptArg).toContain('page one');
    expect(promptArg).toContain('happily');
    expect(promptArg).toContain('Cover');
  });
});

describe('moderateStoryText — fail-closed paths (all throw with safety language)', () => {
  const expectBlocked = async (generate: (p: string) => Promise<string>) => {
    await expect(moderateStoryText(makeStory(), generate)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ModerationBlockedError &&
        /safety|blocked|policy/i.test((err as Error).message),
    );
  };

  it('throws on an explicit verdict:"unsafe"', async () => {
    const generate = vi.fn().mockResolvedValue(
      JSON.stringify({ verdict: 'unsafe', category: 'violence', reason: 'weapons' }),
    );
    await expectBlocked(generate);
  });

  it('throws on any non-"safe" verdict (unknown verdict value)', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({ verdict: 'maybe' }));
    await expectBlocked(generate);
  });

  it('throws on malformed / non-JSON classifier output (fail-closed)', async () => {
    await expectBlocked(vi.fn().mockResolvedValue('I think this story is fine!'));
  });

  it('throws on empty classifier output', async () => {
    await expectBlocked(vi.fn().mockResolvedValue(''));
  });

  it('throws when the classifier call rejects', async () => {
    await expectBlocked(vi.fn().mockRejectedValue(new Error('gemini 503 overloaded')));
  });

  it('throws (blocks) on classifier timeout', async () => {
    vi.useFakeTimers();
    try {
      const generate = () => new Promise<string>(() => { /* never resolves */ });
      const p = moderateStoryText(makeStory(), generate, { timeoutMs: 100 });
      const assertion = expect(p).rejects.toBeInstanceOf(ModerationBlockedError);
      await vi.advanceTimersByTimeAsync(200);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('moderateStoryText — story text never leaks into the error', () => {
  it('unsafe-verdict error message contains no story text', async () => {
    const generate = vi.fn().mockResolvedValue(
      // even if the classifier echoes story text into category/reason, it must not surface
      JSON.stringify({ verdict: 'unsafe', category: `violence ${SECRET}`, reason: SECRET }),
    );
    let caught: Error | undefined;
    await moderateStoryText(makeStory(), generate).catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(ModerationBlockedError);
    expect(caught!.message).not.toContain(SECRET);
  });

  it('malformed-output error message contains no story text', async () => {
    const generate = vi.fn().mockResolvedValue('garbage');
    let caught: Error | undefined;
    await moderateStoryText(makeStory(), generate).catch((e) => (caught = e));
    expect(caught!.message).not.toContain(SECRET);
  });
});

describe('buildModerationPrompt', () => {
  it('produces a strict-JSON children classifier prompt', () => {
    const p = buildModerationPrompt('hello story');
    expect(p).toContain('children');
    expect(p).toContain('"verdict"');
    expect(p).toContain('hello story');
  });
});
