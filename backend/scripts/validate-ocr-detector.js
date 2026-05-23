/**
 * FC-019 validation (dev-only): establishes the clean-vs-jumbled metric
 * distribution across every historical spike-flash render so we can pick a
 * detection rule that catches the page-6 hallucinated-text jumble (recall=1.0
 * but precision low) WITHOUT false-positiving clean pages.
 *
 * Folds soundEffects into the intended set (they are legitimately rendered, so
 * they must not count as "extra"). Reports recall, precision, F1, lenRatio per
 * render and applies a candidate flag rule.
 *
 * Usage: node scripts/validate-ocr-detector.js <storyId>
 */
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');

const PROJECT = 'ai-storybook-app-2025';
const BUCKET = 'ai-storybook-app-2025-images';
const storyId = process.argv[2];
if (!storyId) { console.error('Usage: node scripts/validate-ocr-detector.js <storyId>'); process.exit(1); }

// Candidate detection rule under evaluation:
const RECALL_MIN = 0.6;
const PRECISION_MIN = 0.75;

admin.initializeApp({ projectId: PROJECT });
const vision = new ImageAnnotatorClient();
const storage = new Storage({ projectId: PROJECT });

function wordTokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

(async () => {
  const pagesSnap = await admin.firestore().collection('stories').doc(storyId).collection('pages').orderBy('pageNumber').get();
  const intendedByPage = {};
  pagesSnap.docs.forEach((d) => {
    const p = d.data();
    const sfx = (p.soundEffects || []).join(' ');
    intendedByPage[p.pageNumber] = wordTokens(`${p.text} ${sfx}`);
  });

  const [files] = await storage.bucket(BUCKET).getFiles({ prefix: `stories/${storyId}/spike-flash/` });
  const renders = files
    .map((f) => { const m = f.name.match(/spike-flash\/page-(\d+)-/); return m ? { pageNumber: +m[1], file: f, short: f.name.split('/').pop() } : null; })
    .filter(Boolean)
    .sort((a, b) => a.pageNumber - b.pageNumber || a.short.localeCompare(b.short));

  console.log(`Found ${renders.length} spike-flash renders\n`);
  console.log('PG | recall | prec | F1   | lenR | FLAG        | render');
  console.log('---|--------|------|------|------|-------------|--------');

  let caught = 0;
  for (const r of renders) {
    const intendedTokens = intendedByPage[r.pageNumber] || [];
    const intendedSet = new Set(intendedTokens);
    const [buf] = await r.file.download();
    const [res] = await vision.textDetection({ image: { content: buf.toString('base64') } });
    const detected = res.fullTextAnnotation?.text ?? res.textAnnotations?.[0]?.description ?? '';
    const detTokens = wordTokens(detected);
    const detSet = new Set(detTokens);

    const recall = intendedSet.size ? [...intendedSet].filter((w) => detSet.has(w)).length / intendedSet.size : 1;
    const precision = detSet.size ? [...detSet].filter((w) => intendedSet.has(w)).length / detSet.size : 1;
    const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
    const lenR = intendedTokens.length ? detTokens.length / intendedTokens.length : 1;
    const flagged = recall < RECALL_MIN || precision < PRECISION_MIN;
    if (flagged) caught++;
    console.log(`${r.pageNumber}  | ${recall.toFixed(2)}   | ${precision.toFixed(2)} | ${f1.toFixed(2)} | ${lenR.toFixed(2)} | ${flagged ? 'JUMBLE→REGEN' : 'clean       '}| ${r.short}`);
  }
  console.log(`\nRule: recall<${RECALL_MIN} OR precision<${PRECISION_MIN}  →  flagged ${caught}/${renders.length} renders`);
})().catch((e) => { console.error('error:', e.message || e); process.exit(1); });
