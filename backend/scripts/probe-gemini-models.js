/**
 * FC-045 probe (dev-only): which Gemini model IDs does OUR API key serve, and do
 * the candidates accept the exact call shapes production uses on the installed
 * @google/genai SDK?
 *
 * Why it exists: Google retires preview model IDs on short notice and the docs
 * for newer image models only show the Interactions API. Docs cannot tell us
 * whether `generateContent` + `responseModalities:['IMAGE']` still works for a
 * given model on our SDK version — only a live call can.
 *
 * Phases (each prints a table; images are saved to --out for eyeballing):
 *   list    GET /v1beta/models — presence + supported methods per candidate. FREE.
 *   text    story-JSON call per text candidate (prod shape: safetySettings only).
 *   image   baked-text page per image candidate (prod shape: IMAGE modality +
 *           safetySettings). Reports EVERY response part incl. the `thought`
 *           flag: production keeps the last NON-thought image
 *           (extractGeneratedImage), so the layout matters.
 *   ref     same, with a reference image in `contents` (prod multimodal shape).
 *   vision  text model + inline image (FC-041 vision-moderation shape).
 *   rest    raw REST with thinkingLevel / imageConfig — fields the installed SDK
 *           may silently drop; shows what an SDK upgrade would unlock.
 *
 * Only `list` is free; every other phase makes paid calls. This probe builds
 * its own requests on purpose (it tests call SHAPES per model). To verify the
 * real pipeline end to end, use scripts/live-verify-models.js instead.
 *
 * Usage, from backend/ (key is read from the environment and never printed):
 *   GEMINI_API_KEY=... node scripts/probe-gemini-models.js [--phases list,text,image,ref,vision,rest] [--out <dir>]
 * Images are written to --out (default: a folder under the OS temp dir, so
 * nothing lands inside backend/, which is the deploy trigger's path filter).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const BACKEND = path.resolve(arg('backend', process.cwd()));
const OUT = path.resolve(arg('out', path.join(os.tmpdir(), `probe-gemini-models-${Date.now()}`)));
const PHASES = new Set(arg('phases', 'list').split(','));
const KEY = process.env.GEMINI_API_KEY;
if (!KEY) { console.error('GEMINI_API_KEY is not set'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const backendRequire = createRequire(path.join(BACKEND, 'package.json'));
const genai = backendRequire('@google/genai');
// The SDK's `exports` map hides ./package.json, so read it off disk instead.
const sdkVersion = JSON.parse(
  fs.readFileSync(path.join(BACKEND, 'node_modules', '@google', 'genai', 'package.json'), 'utf8'),
).version;
const { GoogleGenAI, HarmCategory, HarmBlockThreshold } = genai;
const ai = new GoogleGenAI({ apiKey: KEY });

const TEXT_MODELS = (arg('text-models', 'gemini-3-flash-preview,gemini-3.6-flash,gemini-3.8-flash')).split(',');
const IMAGE_MODELS = (arg('image-models', 'gemini-3.1-flash-image-preview,gemini-3.1-flash-image,gemini-nano-banana-2.1')).split(',');

// Mirrors SAFETY_SETTINGS in backend/src/services/gemini.ts.
const SAFETY_SETTINGS = [
  HarmCategory.HARM_CATEGORY_HARASSMENT,
  HarmCategory.HARM_CATEGORY_HATE_SPEECH,
  HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
  HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_LOW_AND_ABOVE }));

const PAGE_TEXT = 'Mia and her little fox tiptoed past the sleepy owl. "Whoosh!" went the wind in the tall pine trees.';
const IMAGE_PROMPT =
  `Children's picture-book illustration in a soft watercolor style, wide 16:9 landscape composition. ` +
  `Scene: a small girl named Mia with curly brown hair and a red raincoat walks through a moonlit pine forest ` +
  `beside a small orange fox; a sleepy owl sits on a branch. ` +
  `Render this exact narration text inside the illustration, in a playful hand-lettered storybook font, ` +
  `clearly legible, spelled exactly, with no other words anywhere in the image: ${JSON.stringify(PAGE_TEXT)}`;
const TEXT_PROMPT =
  'Write a 2-page bedtime story about a girl named Mia and a fox learning kindness. ' +
  'Respond with ONLY a JSON object: {"title": string, "pages": [{"pageNumber": number, "text": string, "sceneDescription": string}]}';

function errLine(e) {
  const s = String(e && e.message ? e.message : e).replace(/\s+/g, ' ');
  return s.length > 420 ? `${s.slice(0, 420)}…` : s;
}

function imageDims(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  if (buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return 'unknown';
}

/** Describe every part of candidate 0 — type, thought flag, size — and save images. */
function describeParts(response, label) {
  const parts = response?.candidates?.[0]?.content?.parts || [];
  const rows = [];
  let firstImage = null;
  let lastNonThoughtImage = null;
  parts.forEach((p, idx) => {
    if (p.inlineData?.data) {
      const buf = Buffer.from(p.inlineData.data, 'base64');
      const mime = p.inlineData.mimeType || '?';
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
      const file = path.join(OUT, `${label}-part${idx}${p.thought ? '-thought' : ''}.${ext}`);
      fs.writeFileSync(file, buf);
      const info = { idx, mime, dims: imageDims(buf), kb: Math.round(buf.length / 1024), thought: !!p.thought, file, data: p.inlineData.data };
      rows.push(`part${idx}: IMAGE ${mime} ${info.dims} ${info.kb}KB thought=${info.thought}`);
      if (!firstImage) firstImage = info;
      if (!p.thought) lastNonThoughtImage = info;
    } else if (typeof p.text === 'string') {
      rows.push(`part${idx}: TEXT(${p.text.length} chars) thought=${!!p.thought}`);
    } else {
      rows.push(`part${idx}: OTHER keys=${Object.keys(p).join('|')}`);
    }
  });
  return { rows, firstImage, lastNonThoughtImage, partCount: parts.length };
}

function usageLine(response) {
  const u = response?.usageMetadata || {};
  const bits = Object.entries(u).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}=${v}`);
  return bits.join(' ') || 'no usageMetadata';
}

async function timed(fn) {
  const t0 = Date.now();
  try { return { ok: true, value: await fn(), ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, error: errLine(e), ms: Date.now() - t0 }; }
}

async function rest(model, body) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${json?.error?.status || ''}: ${json?.error?.message || 'no message'}`);
  return json;
}

async function phaseList() {
  console.log('\n=== list: models served to this key ===');
  const all = [];
  let pageToken = '';
  do {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`, {
      headers: { 'x-goog-api-key': KEY },
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`models.list HTTP ${res.status}: ${json?.error?.message}`);
    all.push(...(json.models || []));
    pageToken = json.nextPageToken || '';
  } while (pageToken);
  const byId = new Map(all.map((m) => [m.name.replace(/^models\//, ''), m]));
  console.log(`total models listed: ${all.length}`);
  for (const id of [...TEXT_MODELS, ...IMAGE_MODELS]) {
    const m = byId.get(id);
    console.log(m
      ? `LISTED   ${id}  methods=[${(m.supportedGenerationMethods || []).join(',')}] in=${m.inputTokenLimit} out=${m.outputTokenLimit}`
      : `MISSING  ${id}`);
  }
  const others = [...byId.keys()].filter((id) => /image|banana|flash/.test(id) && !TEXT_MODELS.includes(id) && !IMAGE_MODELS.includes(id));
  console.log(`other flash/image ids: ${others.sort().join(', ') || '(none)'}`);
}

async function phaseText() {
  console.log(`\n=== text: generateContent via SDK ${sdkVersion}, prod config (safetySettings only) ===`);
  for (const model of TEXT_MODELS) {
    const r = await timed(() => ai.models.generateContent({ model, contents: TEXT_PROMPT, config: { safetySettings: SAFETY_SETTINGS } }));
    if (!r.ok) { console.log(`FAIL ${model} (${r.ms}ms): ${r.error}`); continue; }
    let text = r.value.text || '';
    const fenced = text.match(/```(?:json)?\n?([\s\S]*?)\n?```/);
    if (fenced) text = fenced[1];
    let parsed = 'unparseable';
    try { const j = JSON.parse(text.trim()); parsed = `json ok, pages=${Array.isArray(j.pages) ? j.pages.length : 'n/a'}, fenced=${!!fenced}`; } catch { /* keep */ }
    console.log(`OK   ${model} (${r.ms}ms): ${parsed}; ${usageLine(r.value)}`);
  }
}

const imageResults = new Map();
async function phaseImage() {
  console.log(`\n=== image: generateContent via SDK ${sdkVersion}, prod config (IMAGE modality + safetySettings) ===`);
  for (const model of IMAGE_MODELS) {
    const r = await timed(() => ai.models.generateContent({
      model, contents: [{ text: IMAGE_PROMPT }], config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS },
    }));
    if (!r.ok) { console.log(`FAIL ${model} (${r.ms}ms): ${r.error}`); continue; }
    const d = describeParts(r.value, `image-${model}`);
    imageResults.set(model, d);
    const sameAsProd = d.firstImage && d.lastNonThoughtImage && d.firstImage.idx === d.lastNonThoughtImage.idx;
    console.log(`${d.firstImage ? 'OK  ' : 'NOIMG'} ${model} (${r.ms}ms): parts=${d.partCount}; prod-would-keep=part${d.firstImage?.idx ?? '-'}; final=part${d.lastNonThoughtImage?.idx ?? '-'}; firstIsFinal=${!!sameAsProd}; blockReason=${r.value.promptFeedback?.blockReason || 'none'}; ${usageLine(r.value)}`);
    d.rows.forEach((row) => console.log(`       ${row}`));
  }
}

async function phaseRef() {
  console.log(`\n=== ref: image generation with a reference image in contents (prod multimodal shape) ===`);
  const donor = [...imageResults.values()].find((d) => d.lastNonThoughtImage) || null;
  if (!donor) { console.log('SKIP — no image from the image phase to use as a reference (run with --phases image,ref)'); return; }
  const ref = donor.lastNonThoughtImage;
  for (const model of IMAGE_MODELS) {
    if (!imageResults.get(model)?.firstImage) { console.log(`SKIP ${model} — failed the image phase`); continue; }
    const contents = [
      { text: 'Previous page 1 of THIS SAME book. The characters on the new page must look EXACTLY like they do here.' },
      { inlineData: { data: ref.data, mimeType: ref.mime } },
      { text: `${IMAGE_PROMPT.replace(PAGE_TEXT, 'The little fox found a shiny acorn and gave it to Mia.')}` },
    ];
    const r = await timed(() => ai.models.generateContent({ model, contents, config: { responseModalities: ['IMAGE'], safetySettings: SAFETY_SETTINGS } }));
    if (!r.ok) { console.log(`FAIL ${model} (${r.ms}ms): ${r.error}`); continue; }
    const d = describeParts(r.value, `ref-${model}`);
    console.log(`${d.firstImage ? 'OK  ' : 'NOIMG'} ${model} (${r.ms}ms): parts=${d.partCount}; ${usageLine(r.value)}`);
    d.rows.forEach((row) => console.log(`       ${row}`));
  }
}

async function phaseVision() {
  console.log(`\n=== vision: text model + inline image (FC-041 vision-moderation shape) ===`);
  const donor = [...imageResults.values()].find((d) => d.lastNonThoughtImage) || null;
  if (!donor) { console.log('SKIP — no image available (run with --phases image,vision)'); return; }
  const img = donor.lastNonThoughtImage;
  for (const model of TEXT_MODELS) {
    const r = await timed(() => ai.models.generateContent({
      model,
      contents: [{ text: 'Is this image safe for a children\'s storybook? Reply with ONLY JSON: {"safe": boolean, "reason": string}' }, { inlineData: { data: img.data, mimeType: img.mime } }],
      config: { safetySettings: SAFETY_SETTINGS },
    }));
    console.log(r.ok ? `OK   ${model} (${r.ms}ms): ${(r.value.text || '').replace(/\s+/g, ' ').slice(0, 140)}; ${usageLine(r.value)}` : `FAIL ${model} (${r.ms}ms): ${r.error}`);
  }
}

async function phaseRest() {
  console.log(`\n=== rest: raw REST generateContent — fields SDK ${sdkVersion} may drop ===`);
  const safetySettings = SAFETY_SETTINGS.map((s) => ({ category: s.category, threshold: s.threshold }));
  const variants = [
    { label: 'imageConfig-16x9', generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } } },
    { label: 'thinking-minimal', generationConfig: { responseModalities: ['IMAGE'], thinkingConfig: { thinkingLevel: 'minimal' } } },
    { label: 'thinking-minimal+16x9', generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' }, thinkingConfig: { thinkingLevel: 'minimal' } } },
  ];
  for (const model of IMAGE_MODELS) {
    if (imageResults.size && !imageResults.get(model)?.firstImage) { console.log(`SKIP ${model} — failed the image phase`); continue; }
    for (const v of variants) {
      const r = await timed(() => rest(model, { contents: [{ role: 'user', parts: [{ text: IMAGE_PROMPT }] }], generationConfig: v.generationConfig, safetySettings }));
      if (!r.ok) { console.log(`FAIL ${model} [${v.label}] (${r.ms}ms): ${r.error}`); continue; }
      const d = describeParts(r.value, `rest-${v.label}-${model}`);
      console.log(`${d.firstImage ? 'OK  ' : 'NOIMG'} ${model} [${v.label}] (${r.ms}ms): parts=${d.partCount}; ${usageLine(r.value)}`);
      d.rows.forEach((row) => console.log(`       ${row}`));
    }
  }
}

(async () => {
  console.log(`probe: SDK @google/genai ${sdkVersion}; phases=${[...PHASES].join(',')}; out=${OUT}`);
  if (PHASES.has('list')) await phaseList();
  if (PHASES.has('text')) await phaseText();
  if (PHASES.has('image')) await phaseImage();
  if (PHASES.has('ref')) await phaseRef();
  if (PHASES.has('vision')) await phaseVision();
  if (PHASES.has('rest')) await phaseRest();
})().catch((e) => { console.error(`probe aborted: ${errLine(e)}`); process.exit(1); });
