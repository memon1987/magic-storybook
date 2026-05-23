/**
 * FC-019 metric diagnosis (dev-only). The word-recall metric failed to catch
 * the page-6 jumble (hallucinated gibberish block — all intended words still
 * present, so recall=1.0). This dumps OCR token data + candidate metrics for a
 * set of images against their intended text so we can pick a metric that
 * cleanly separates jumbled from clean.
 *
 * Usage: node scripts/diagnose-text-metrics.js <storyId> <pageNumber> <gsUri...>
 */
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');

const PROJECT = 'ai-storybook-app-2025';
const BUCKET = 'ai-storybook-app-2025-images';
const [storyId, pageNumStr, ...uris] = process.argv.slice(2);
if (!storyId || !pageNumStr) { console.error('Usage: node diagnose-text-metrics.js <storyId> <pageNumber> <objectName...>'); process.exit(1); }
const pageNumber = parseInt(pageNumStr, 10);

admin.initializeApp({ projectId: PROJECT });
const vision = new ImageAnnotatorClient();
const storage = new Storage({ projectId: PROJECT });

function wordTokens(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1);
}

(async () => {
  const pageDoc = (await admin.firestore().collection('stories').doc(storyId).collection('pages')
    .where('pageNumber', '==', pageNumber).get()).docs[0];
  const intendedText = pageDoc.data().text;
  const soundEffects = pageDoc.data().soundEffects || [];
  const emphasized = pageDoc.data().emphasizedWords || [];
  const intendedTokens = wordTokens(intendedText);
  const intendedSet = new Set(intendedTokens);
  console.log(`\n=== Page ${pageNumber} intended text ===\n${intendedText}`);
  console.log(`soundEffects: ${JSON.stringify(soundEffects)}  emphasized: ${JSON.stringify(emphasized)}`);
  console.log(`intended tokens: ${intendedTokens.length} (${intendedSet.size} unique)\n`);

  for (const obj of uris) {
    const name = `stories/${storyId}/spike-flash/${obj}`;
    const [buf] = await storage.bucket(BUCKET).file(name).download();
    const [result] = await vision.textDetection({ image: { content: buf.toString('base64') } });
    const detected = result.fullTextAnnotation?.text ?? result.textAnnotations?.[0]?.description ?? '';
    const detTokens = wordTokens(detected);
    const detSet = new Set(detTokens);

    const recallFound = [...intendedSet].filter((w) => detSet.has(w)).length;
    const recall = intendedSet.size ? recallFound / intendedSet.size : 1;
    const precFound = [...detSet].filter((w) => intendedSet.has(w)).length;
    const precision = detSet.size ? precFound / detSet.size : 1;
    const f1 = (precision + recall) ? (2 * precision * recall) / (precision + recall) : 0;
    const lenRatio = intendedTokens.length ? detTokens.length / intendedTokens.length : 1;
    const extraWords = [...detSet].filter((w) => !intendedSet.has(w));

    console.log(`--- ${obj} ---`);
    console.log(`OCR text:\n${detected.replace(/\n/g, ' / ')}`);
    console.log(`detected tokens: ${detTokens.length} (${detSet.size} unique)`);
    console.log(`recall=${recall.toFixed(2)}  precision=${precision.toFixed(2)}  F1=${f1.toFixed(2)}  lenRatio=${lenRatio.toFixed(2)}`);
    console.log(`extra (detected, not intended) [${extraWords.length}]: ${extraWords.join(', ')}`);
    console.log('');
  }
})().catch((e) => { console.error('error:', e.message || e); process.exit(1); });
