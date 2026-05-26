import { describe, it, expect, vi, afterEach } from 'vitest';
import { classifyError, instrumentedGenerateContent } from '../instrumentation';

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
