# FC-002 Latency Benchmark — 2026-04-28

## Question

After shipping `gemini-3.1-flash-image-preview` ("Nano Banana 2") on 2026-04-24 to replace `gemini-3-pro-image-preview`, do we keep it or revert? Initial 04-28 observation showed 28-88s/page latency, well over Nano Banana 2's 4-6s spec.

## Method

Pulled all `Illustration for page X generated in Yms` log lines from Cloud Run for 30 days. Found three completed runs, all on the new Flash model.

## Data

| Story | Date | Pages | Per-page latency (s) | Parallel total (s) | Story-text (s) | End-to-end (s) |
|---|---|---|---|---|---|---|
| `76a3b8ce` | 04-24 06:44 | 4 | 32, 32, 59, 67 | 127 | 18 | **145** |
| `ddaa8147` | 04-25 02:41 | 6 | 12, 14, 15, 15, 15, 17 | 30 | 38 (with 1 retry) | **68** |
| `b1a1a5be` | 04-28 13:15 | 8 | 28, 46, 53, 79, 88, ?, 250, 254 | 354 | 80 (with 1 retry) | **435** |

## Observations

- **Variance is massive.** 04-25 averaged 14.6s/page; 04-28 averaged 113s/page on the same model. The 04-28 worst-case (254s) is **18× the worst-case from 04-25** (17s).
- **The 4-6s spec has not been observed.** Even the best run (04-25) was 12-17s/page, 2-3× the spec.
- **04-28 had two outliers** (250s, 254s for pages 5 and 2). These are the same kind of pages as the others (parallel, with reference image input). Smells like rate limiting / quota throttling kicking in mid-batch.
- **Each run hit a 503 retry on text generation** (04-25 and 04-28). Demand pressure on the Gemini side appears constant.
- **Cold start** affected 04-28 — container started in the same second the request arrived. May explain some upfront cost but not 250s outliers.
- **Reverting to Pro likely doesn't fix variance.** Historical Pro-era logs from before the swap showed individual pages taking 224s+ on a 4-page story. Both models suffer when Gemini is under load.

## Hypothesis

The variance isn't a model-quality problem. It's a **load / quota problem with Gemini's image API**, and our parallel-7 multimodal call pattern (page 1 + 6-7 reference-image-bearing pages) probably hits rate limits intermittently. Switching models won't fix it. Pro is potentially worse — historical Pro runs showed similar tail latencies but at ~2× cost.

## Recommendation: **KEEP Flash. Don't revert.**

Reasoning:
- 04-25 shows Flash CAN deliver 12-17s/page — fine for the product.
- Pro had similar tail latencies historically + costs ~2× more per image.
- Reverting trades intermittent-fast-and-sometimes-slow for consistently-slow.
- The real fix is rate-limit / parallelism / UX work, not model choice.

Conditions for re-evaluation:
- If 3 of next 5 stories show > 60s average per-page latency, revisit revert.
- If we add usage and Gemini's quota tier rises (paid throughput), variance may smooth out without code change.

## Recommended follow-ups (ordered)

1. **Fix the misleading log line** in `backend/src/services/gemini.ts:160` — it hardcodes "Gemini 3 Pro Image" but actual model is Flash. One-line change to use `${IMAGE_MODEL}`. Cosmetic but corrupts log analysis like this report.
2. **Add structured per-page latency log** — replace text logs with one JSON line per illustration: `{ event: 'illustration_generated', page, model, attempts, latencyMs, storyId }`. Lets us aggregate trivially in BigQuery / analysis tools.
3. **Wizard UX honesty** — current copy says "This usually takes about a minute." For 8-page stories the empirical median is closer to 4-7 minutes. Tier the message by length: "~1 min" for short (4 pages), "~3 min" for medium (6 pages), "up to 8 min" for long (8 pages).
4. **Test sequential vs parallel** — counter-intuitively, sequential may be faster overall when Gemini's parallel quota is the bottleneck. Worth a one-day spike if the per-page tail latency keeps showing 200s+ outliers.
5. **Move FC-002 to Completed** in `docs/FUTURE_CONSIDERATIONS.md` since the model swap has shipped (`13ba5d7`) and this report is the formal close-out.

## Cost data (for the record)

At ~$0.067/image with the Flash model:
- 4-page story: ~$0.27
- 6-page story: ~$0.40
- 8-page story: ~$0.54

Pro would have cost ~$0.52, $0.78, $1.04 for the same stories — roughly 2× higher per story.
