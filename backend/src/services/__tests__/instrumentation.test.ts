import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyError, instrumentedGenerateContent, responseTelemetry } from '../instrumentation';

describe('classifyError', () => {
  it('detects fetch failed (the 2026-05-12 instance-death trigger)', () => {
    expect(classifyError(new Error('TypeError: fetch failed sending request')).errorClass).toBe('fetch_failed');
    expect(classifyError('socket hang up').errorClass).toBe('fetch_failed');
  });

  it('detects ECONNRESET / ETIMEDOUT / EAI_AGAIN as distinct classes', () => {
    expect(classifyError(new Error('ECONNRESET on read')).errorClass).toBe('econnreset');
    expect(classifyError(new Error('ETIMEDOUT after 30s')).errorClass).toBe('etimedout');
    expect(classifyError(new Error('getaddrinfo EAI_AGAIN gemini.googleapis.com')).errorClass).toBe('eai_again');
  });

  it('detects Gemini UNAVAILABLE / INTERNAL status strings (no numeric code attached)', () => {
    // Synthesizes a 503 statusCode when the string carries no numeric code itself
    const u = classifyError(new Error('UNAVAILABLE: model overloaded'));
    expect(u.errorClass).toBe('unavailable');
    expect(u.statusCode).toBe(503);
    const i = classifyError(new Error('INTERNAL: backend error'));
    expect(i.errorClass).toBe('internal');
    expect(i.statusCode).toBe(500);
  });

  it('parses a numeric status code from "status: 503" pattern', () => {
    const r = classifyError(new Error('Request failed with status: 503 (Service Unavailable)'));
    expect(r.statusCode).toBe(503);
    // 503 happens to match UNAVAILABLE's class because we hit status before the generic 5xx
    expect(['unavailable', '5xx']).toContain(r.errorClass);
  });

  it('falls through to generic 5xx / 4xx when no specific class matches', () => {
    expect(classifyError(new Error('status: 502 Bad Gateway')).errorClass).toBe('5xx');
    expect(classifyError(new Error('status: 429 Too Many Requests')).errorClass).toBe('4xx');
  });

  it('handles unknown / null / undefined gracefully', () => {
    expect(classifyError(null).errorClass).toBe('unknown');
    expect(classifyError(undefined).errorClass).toBe('unknown');
    expect(classifyError('a thing happened').errorClass).toBe('other');
  });

  it('classifies "high demand" (the Gemini overload phrasing) distinctly', () => {
    expect(classifyError(new Error('Model is under high demand, try again')).errorClass).toBe('high_demand');
  });
});

describe('instrumentedGenerateContent', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => logSpy.mockClear());

  it('returns the wrapped fn result on success and emits a success call_event', async () => {
    const out = await instrumentedGenerateContent('story-1', 'char_ref', 1, async () => 'ok');
    expect(out).toBe('ok');
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.event).toBe('call');
    expect(payload.outcome).toBe('success');
    expect(payload.kind).toBe('char_ref');
    expect(payload.attempt).toBe(1);
    expect(payload.storyId).toBe('story-1');
    expect(typeof payload.latencyMs).toBe('number');
  });

  it('re-throws the original error and emits a classified failure call_event', async () => {
    const err = new Error('TypeError: fetch failed sending request');
    await expect(instrumentedGenerateContent('story-2', 'page', 2, async () => { throw err; })).rejects.toBe(err);
    const payload = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(payload.event).toBe('call');
    expect(payload.outcome).toBe('failure');
    expect(payload.errorClass).toBe('fetch_failed');
    expect(payload.kind).toBe('page');
    expect(payload.attempt).toBe(2);
  });
});

describe('FC-045 — call telemetry (responseTelemetry)', () => {
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => logSpy.mockClear());

  const lastPayload = () => JSON.parse(logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string);
  const TELEMETRY_KEYS = ['modelVersion', 'finishReason', 'blockReason', 'promptTokens', 'outputTokens', 'thoughtTokens', 'totalTokens'];

  it('success event carries the seven fields from a realistic response object', async () => {
    const response = {
      modelVersion: 'gemini-nano-banana-2.1-001',
      candidates: [
        {
          finishReason: 'STOP',
          finishMessage: 'Mira finished her story',
          content: { parts: [{ text: 'Mira the rabbit hopped.' }] },
        },
      ],
      promptFeedback: { blockReason: 'SAFETY' },
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 1290, thoughtsTokenCount: 310, totalTokenCount: 2800 },
    };
    const out = await instrumentedGenerateContent('story-t1', 'page', 1, async () => response);
    expect(out).toBe(response);
    const payload = lastPayload();
    expect(payload).toMatchObject({
      event: 'call', outcome: 'success', kind: 'page',
      modelVersion: 'gemini-nano-banana-2.1-001',
      finishReason: 'STOP',
      blockReason: 'SAFETY',
      promptTokens: 1200,
      outputTokens: 1290,
      thoughtTokens: 310,
      totalTokens: 2800,
    });
    // Never logs finishMessage, part text or prompt text.
    const line = logSpy.mock.calls[logSpy.mock.calls.length - 1][0] as string;
    expect(line).not.toContain('finishMessage');
    expect(line).not.toContain('Mira');
  });

  it('fields absent from the response are absent from the event (no undefined/null keys)', async () => {
    const response = {
      modelVersion: 42, // wrong type → omitted
      candidates: [{ finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, totalTokenCount: Number.NaN }, // NaN → omitted
    };
    await instrumentedGenerateContent('story-t2', 'story_text', 1, async () => response);
    const payload = lastPayload();
    expect(payload.finishReason).toBe('STOP');
    expect(payload.promptTokens).toBe(10);
    for (const k of ['modelVersion', 'blockReason', 'outputTokens', 'thoughtTokens', 'totalTokens']) {
      expect(Object.prototype.hasOwnProperty.call(payload, k)).toBe(false);
    }
    const t = responseTelemetry(response);
    expect(Object.keys(t).sort()).toEqual(['finishReason', 'promptTokens']);
    expect(Object.values(t).some((v) => v === undefined || v === null)).toBe(false);
  });

  it('string / null / throwing-getter results do not throw and the original result is returned', async () => {
    const throwing = {};
    Object.defineProperty(throwing, 'candidates', { get() { throw new Error('boom'); }, enumerable: true });
    Object.defineProperty(throwing, 'modelVersion', { get() { throw new Error('boom'); }, enumerable: true });

    for (const result of ['plain text', null, throwing] as unknown[]) {
      expect(() => responseTelemetry(result)).not.toThrow();
      expect(responseTelemetry(result)).toEqual({});
      logSpy.mockClear();
      const out = await instrumentedGenerateContent('story-t3', 'moderation', 1, async () => result);
      expect(out).toBe(result);
      const payload = lastPayload();
      expect(payload.outcome).toBe('success');
      for (const k of TELEMETRY_KEYS) expect(Object.prototype.hasOwnProperty.call(payload, k)).toBe(false);
    }
  });

  it('failure-path event is unchanged (no telemetry fields)', async () => {
    const err = new Error('status: 502 Bad Gateway');
    await expect(instrumentedGenerateContent('story-t4', 'char_ref', 3, async () => { throw err; })).rejects.toBe(err);
    const payload = lastPayload();
    expect(Object.keys(payload).sort()).toEqual(
      ['attempt', 'errorClass', 'event', 'kind', 'latencyMs', 'outcome', 'statusCode', 'storyId', 'ts'],
    );
    expect(payload).toMatchObject({ outcome: 'failure', errorClass: '5xx', statusCode: 502, kind: 'char_ref', attempt: 3 });
  });
});
