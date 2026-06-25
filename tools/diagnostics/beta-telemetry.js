#!/usr/bin/env node
/**
 * beta-telemetry.js — Beta usage & performance dashboard generator.
 *
 * Pulls live telemetry and renders a self-contained HTML dashboard:
 *   1. Stories generated over time (per week, per user)
 *   2. Per-user usage over time — retention (cumulative + activity timeline
 *      + per-day intensity)
 *   3. Generation time by story length
 *
 * DATA SOURCES
 *   - Firestore `stories` collection (all-time)        → counts, length, status
 *   - Cloud Logging `stage_done`/`stage:total` events  → generation latency (last 30d only;
 *                                                         default log retention)
 *   - Firebase Auth                                     → resolve userId → email
 *
 * AUTH: uses Application Default Credentials (ADC). Run `gcloud auth
 *       application-default login` once if it fails. Node SDKs mint properly
 *       scoped tokens from ADC (a raw `gcloud auth ... print-access-token` is
 *       NOT accepted by the Logging API — token-type unsupported).
 *
 * DEPENDENCIES are resolved from ../../backend/node_modules (firebase-admin,
 *       @google-cloud/firestore, google-auth-library) so this script needs no
 *       package.json of its own. Just have backend deps installed.
 *
 * ⚠️  OUTPUT CONTAINS REAL USER EMAILS (PII). The generated HTML is written to
 *       /tmp by default and MUST NOT be committed to the repo. Only this script
 *       (no PII) is tracked.
 *
 * USAGE:
 *   node tools/diagnostics/beta-telemetry.js [outfile.html]
 *   (defaults to /tmp/storybook_telemetry.html, then opens it on macOS)
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// ---- config ----
const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'ai-storybook-app-2025';
// own/dev accounts → tagged "(dev)" and excluded from the non-dev count. Override with
// DEV_EMAILS=a@x.com,b@y.com env var.
const DEV_EMAILS = new Set((process.env.DEV_EMAILS || 'zeshan@tkzmgroup.com,memonmz@gmail.com').split(',').map((s) => s.trim()).filter(Boolean));
const LOG_WINDOW_DAYS = 30;
const OUT = process.argv[2] || '/tmp/storybook_telemetry.html';

// resolve backend node_modules so we can `require` the GCP SDKs from anywhere
const BMODS = path.join(__dirname, '..', '..', 'backend', 'node_modules');
const req = (m) => require(path.join(BMODS, m));
const { Firestore } = req('@google-cloud/firestore');
const admin = req('firebase-admin');
const { GoogleAuth } = req('google-auth-library');

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const COLORS = ['#FF6B6B','#6BCB77','#FFB000','#C9B1FF','#3DA5FF','#2D3748','#FF8FB1','#00B8A9'];
const lenOf = (pc) => (pc === 4 ? 'short' : pc === 6 ? 'medium' : pc === 8 ? 'long' : 'pc' + pc);
const PAGES = { short: 4, medium: 6, long: 8 };

async function fetchStories(db) {
  const snap = await db.collection('stories').get();
  const rows = [];
  snap.forEach((d) => {
    const x = d.data();
    rows.push({
      id: d.id,
      userId: x.userId,
      length: x.length || null,
      status: x.status || 'legacy',
      createdAt: x.createdAt && x.createdAt.toDate ? x.createdAt.toDate().toISOString() : null,
    });
  });
  return rows;
}

async function fetchEmails(uids) {
  if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
  const map = {};
  // getUsers accepts max 100 identifiers per call
  for (let i = 0; i < uids.length; i += 100) {
    const res = await admin.auth().getUsers(uids.slice(i, i + 100).map((uid) => ({ uid })));
    res.users.forEach((u) => { map[u.uid] = u.email || null; });
    res.notFound.forEach((u) => { map[u.uid] = null; }); // deleted account
  }
  return map;
}

async function fetchLatencies() {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const since = new Date(Date.now() - LOG_WINDOW_DAYS * 86400000).toISOString();
  const filter =
    `resource.type="cloud_run_revision" AND jsonPayload.event="stage_done" ` +
    `AND jsonPayload.stage="total" AND timestamp>="${since}"`;
  const out = [];
  let pageToken, rounds = 0;
  do {
    const body = JSON.stringify({
      resourceNames: [`projects/${PROJECT}`], filter, orderBy: 'timestamp desc', pageSize: 1000, pageToken,
    });
    const r = await client.request({
      url: 'https://logging.googleapis.com/v2/entries:list',
      method: 'POST', data: body, headers: { 'Content-Type': 'application/json' },
    });
    (r.data.entries || []).forEach((e) => {
      const p = e.jsonPayload || {};
      out.push({ storyId: p.storyId, latencyMs: p.latencyMs, pageCount: p.pageCount, outcome: p.outcome });
    });
    pageToken = r.data.nextPageToken;
  } while (pageToken && ++rounds < 30);
  return out;
}

// ---- date helpers ----
function monday(iso) {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}
function wkLabel(m) {
  const e = new Date(m.getTime() + 6 * 86400000);
  const a = MON[m.getUTCMonth()] + ' ' + m.getUTCDate();
  const b = m.getUTCMonth() === e.getUTCMonth() ? e.getUTCDate() : MON[e.getUTCMonth()] + ' ' + e.getUTCDate();
  return a + '–' + b;
}
const dayKey = (iso) => iso.slice(0, 10);
const dayLabel = (k) => { const d = new Date(k + 'T00:00:00Z'); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); };

function aggregate(stories, emails, lat) {
  const byId = {}; stories.forEach((s) => (byId[s.id] = s));
  const emailOf = (uid) => emails[uid] || null;
  const devUid = new Set(Object.keys(emails).filter((u) => DEV_EMAILS.has(emails[u])));

  // weekly
  const weeks = {};
  stories.forEach((s) => {
    if (!s.createdAt) return;
    const k = monday(s.createdAt).toISOString().slice(0, 10);
    weeks[k] = weeks[k] || { label: wkLabel(monday(s.createdAt)), complete: 0, generating: 0 };
    weeks[k][s.status] = (weeks[k][s.status] || 0) + 1;
  });
  const wk = Object.keys(weeks).sort();

  // per-user totals
  const pu = {};
  stories.forEach((s) => {
    pu[s.userId] = pu[s.userId] || { complete: 0, generating: 0, total: 0 };
    pu[s.userId].total++; pu[s.userId][s.status] = (pu[s.userId][s.status] || 0) + 1;
  });
  const us = Object.entries(pu).sort((a, b) => b[1].total - a[1].total);
  const uLabel = (uid) => {
    let e = emailOf(uid) || uid.slice(0, 8) + '…';
    if (e.length > 30) e = e.slice(0, 27) + '…';
    return e + (devUid.has(uid) ? ' (dev)' : '');
  };

  // named (non-deleted) users, ordered by first activity, for timeseries
  const byUser = {};
  stories.filter((s) => s.createdAt && emailOf(s.userId)).forEach((s) => {
    byUser[s.userId] = byUser[s.userId] || [];
    byUser[s.userId].push(s);
  });
  Object.values(byUser).forEach((rows) => rows.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)));
  const order = Object.keys(byUser).sort((a, b) => (byUser[a][0].createdAt < byUser[b][0].createdAt ? -1 : 1));

  // cumulative lines
  const lines = order.map((uid, i) => {
    let c = 0; const data = byUser[uid].map((s) => ({ x: new Date(s.createdAt).getTime(), y: ++c }));
    return { label: uLabel(uid), data, color: COLORS[i % COLORS.length] };
  });
  // activity timeline
  const userRows = order.map(uLabel);
  const timeline = order.map((uid, i) => ({
    idx: i, color: COLORS[i % COLORS.length],
    dots: byUser[uid].map((s) => ({ x: new Date(s.createdAt).getTime(), status: s.status })),
  }));

  // per-day intensity (stories/day, stacked by user) — only active days
  const dayset = {};
  stories.filter((s) => s.createdAt && emailOf(s.userId)).forEach((s) => {
    const k = dayKey(s.createdAt); dayset[k] = dayset[k] || {};
    dayset[k][s.userId] = (dayset[k][s.userId] || 0) + 1;
  });
  const days = Object.keys(dayset).sort();
  const dayLabels = days.map(dayLabel);
  const intensity = order.map((uid, i) => ({
    label: uLabel(uid), color: COLORS[i % COLORS.length],
    data: days.map((k) => dayset[k][uid] || 0),
  }));

  // timing by length
  const pts = { short: [], medium: [], long: [] };
  lat.filter((e) => e.outcome === 'success' && e.latencyMs).forEach((e) => {
    const L = lenOf(e.pageCount); if (!pts[L]) return;
    const s = byId[e.storyId];
    pts[L].push({ y: Math.round(e.latencyMs / 10) / 100, email: s ? emailOf(s.userId) || '(deleted)' : '(deleted)' });
  });
  const box = (a) => {
    a = a.slice().sort((x, y) => x - y); const q = (p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
    return a.length ? { n: a.length, min: a[0], med: q(0.5), max: a[a.length - 1] } : null;
  };
  const boxes = { short: box(pts.short.map((p) => p.y)), medium: box(pts.medium.map((p) => p.y)), long: box(pts.long.map((p) => p.y)) };

  return {
    totalStories: stories.length,
    complete: stories.filter((s) => s.status === 'complete').length,
    users: Object.keys(pu).length,
    realTesters: us.filter(([u]) => emailOf(u) && !devUid.has(u)).length,
    timed: pts.short.length + pts.medium.length + pts.long.length,
    wkLabels: wk.map((k) => weeks[k].label),
    wkComplete: wk.map((k) => weeks[k].complete || 0),
    wkGen: wk.map((k) => weeks[k].generating || 0),
    uLabels: us.map(([u]) => uLabel(u)),
    uComplete: us.map(([, v]) => v.complete || 0),
    uGen: us.map(([, v]) => v.generating || 0),
    lines, timeline, userRows, dayLabels, intensity, pts, boxes,
  };
}

function renderHTML(D) {
  const lenRows = ['short', 'medium', 'long'].map((L) => {
    const b = D.boxes[L];
    return b
      ? `<tr><td>${L}</td><td>${PAGES[L]}</td><td>${b.n}</td><td>${Math.round(b.min)}s</td><td><b>${Math.round(b.med)}s</b></td><td>${Math.round(b.max)}s</td></tr>`
      : `<tr><td>${L}</td><td>${PAGES[L]}</td><td colspan=4>no data</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>AI Storybook — Beta Telemetry</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#FFF9E8;color:#2D3748;margin:0;padding:24px}
h1{color:#FF6B6B}h2{margin-top:36px;border-bottom:3px solid #FFD93D;padding-bottom:6px}
.card{background:#fff;border-radius:14px;padding:18px;margin:16px 0;box-shadow:0 2px 10px rgba(0,0,0,.06)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.note{font-size:13px;color:#555;background:#FFF3CD;border-left:4px solid #FFD93D;padding:10px 14px;border-radius:6px;margin:10px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:6px 10px;text-align:left;border-bottom:1px solid #eee}th{color:#6BCB77}
.metric{display:inline-block;background:#C9B1FF22;border-radius:10px;padding:10px 16px;margin:6px;font-size:14px}
.metric b{font-size:22px;color:#FF6B6B;display:block}
canvas{max-height:360px}
</style></head><body>
<h1>🦊 AI Storybook — Beta Telemetry</h1>
<p>Generated ${new Date().toISOString().slice(0, 10)} · Firestore <code>stories</code> (all-time) + Cloud Logging <code>total</code> events (last ${LOG_WINDOW_DAYS}d) · emails from Firebase Auth</p>
<div class="card">
<span class="metric"><b>${D.totalStories}</b>total stories</span>
<span class="metric"><b>${D.complete}</b>completed</span>
<span class="metric"><b>${D.users}</b>distinct users</span>
<span class="metric"><b>${D.realTesters}</b>non-dev users</span>
<span class="metric"><b>${D.timed}</b>timed generations (${LOG_WINDOW_DAYS}d)</span>
</div>

<h2>1 · Stories generated over time</h2>
<div class="grid">
<div class="card"><canvas id="weekChart"></canvas></div>
<div class="card"><canvas id="userChart"></canvas></div>
</div>

<h2>2 · Per-user usage over time (retention &amp; intensity)</h2>
<div class="grid">
<div class="card"><canvas id="cumChart"></canvas></div>
<div class="card"><canvas id="timelineChart"></canvas></div>
</div>
<div class="card"><canvas id="intensityChart"></canvas></div>
<div class="note"><b>Cumulative</b>: rising line = still active, flat tail = stopped. <b>Timeline</b>: each dot is a story (✕ = stuck). <b>Daily intensity</b>: stories per active day, stacked by user — shows engagement bursts and who drove them. Deleted single-story accounts omitted from this section.</div>

<h2>3 · Generation time by story length</h2>
<div class="grid">
<div class="card"><canvas id="timeChart"></canvas></div>
<div class="card">
<table><tr><th>length</th><th>pages</th><th>n</th><th>min</th><th>median</th><th>max</th></tr>${lenRows}</table>
<div class="note">Median is dominated by fixed overhead (story text + char refs + cast + title), not page count. Hover a point for the tester.</div>
</div>
</div>

<script>
const fmt=ms=>{const d=new Date(ms);return ${JSON.stringify(MON)}[d.getUTCMonth()]+" "+d.getUTCDate();};
new Chart(weekChart,{type:"bar",data:{labels:${JSON.stringify(D.wkLabels)},datasets:[{label:"complete",data:${JSON.stringify(D.wkComplete)},backgroundColor:"#6BCB77"},{label:"generating/stuck",data:${JSON.stringify(D.wkGen)},backgroundColor:"#FF6B6B"}]},options:{plugins:{title:{display:true,text:"Stories per week"}},scales:{x:{stacked:true},y:{stacked:true,title:{display:true,text:"stories"}}}}});
new Chart(userChart,{type:"bar",data:{labels:${JSON.stringify(D.uLabels)},datasets:[{label:"complete",data:${JSON.stringify(D.uComplete)},backgroundColor:"#6BCB77"},{label:"generating/stuck",data:${JSON.stringify(D.uGen)},backgroundColor:"#FF6B6B"}]},options:{indexAxis:"y",plugins:{title:{display:true,text:"Stories per user (all-time)"}},scales:{x:{stacked:true},y:{stacked:true}}}});
const lines=${JSON.stringify(D.lines)};
new Chart(cumChart,{type:"line",data:{datasets:lines.map(l=>({label:l.label,data:l.data,borderColor:l.color,backgroundColor:l.color,stepped:true,pointRadius:3,borderWidth:2}))},options:{plugins:{title:{display:true,text:"Cumulative stories per user"},legend:{labels:{boxWidth:12,font:{size:11}}}},scales:{x:{type:"linear",ticks:{callback:fmt,maxTicksLimit:8},title:{display:true,text:"date"}},y:{beginAtZero:true,title:{display:true,text:"cumulative stories"}}}}});
const tl=${JSON.stringify(D.timeline)},rows=${JSON.stringify(D.userRows)};
new Chart(timelineChart,{type:"scatter",data:{datasets:tl.map(u=>({data:u.dots.map(d=>({x:d.x,y:u.idx})),backgroundColor:u.color,pointRadius:7,pointStyle:u.dots.map(d=>d.status==="complete"?"circle":"crossRot")}))},options:{plugins:{legend:{display:false},title:{display:true,text:"Activity timeline (1 dot = 1 story; ✕ = stuck)"},tooltip:{callbacks:{label:c=>rows[c.raw.y]+" · "+fmt(c.raw.x)}}},scales:{x:{type:"linear",ticks:{callback:fmt,maxTicksLimit:8}},y:{min:-0.5,max:rows.length-0.5,ticks:{stepSize:1,callback:v=>rows[v]||"",font:{size:10}}}}}});
new Chart(intensityChart,{type:"bar",data:{labels:${JSON.stringify(D.dayLabels)},datasets:${JSON.stringify(D.intensity)}.map(u=>({label:u.label,data:u.data,backgroundColor:u.color}))},options:{plugins:{title:{display:true,text:"Daily intensity — stories per active day (stacked by user)"},legend:{labels:{boxWidth:12,font:{size:11}}}},scales:{x:{stacked:true,title:{display:true,text:"active day"}},y:{stacked:true,title:{display:true,text:"stories that day"}}}}});
const pts=${JSON.stringify(D.pts)};
new Chart(timeChart,{type:"scatter",data:{datasets:["short","medium","long"].map((L,i)=>({label:L,data:pts[L].map((p,j)=>({x:i+((j%5)-2)*0.05,y:p.y,email:p.email})),backgroundColor:["#FFD93D","#FF6B6B","#C9B1FF"][i],pointRadius:6}))},options:{plugins:{title:{display:true,text:"Generation time per story (s) by length"},tooltip:{callbacks:{label:c=>c.raw.y+"s · "+c.raw.email}}},scales:{x:{min:-0.5,max:2.5,ticks:{stepSize:1,callback:v=>["short (4p)","medium (6p)","long (8p)"][v]||""}},y:{title:{display:true,text:"seconds"},beginAtZero:true}}}});
</script>
</body></html>`;
}

(async () => {
  const db = new Firestore({ projectId: PROJECT });
  console.log(`[beta-telemetry] project=${PROJECT}`);
  const stories = await fetchStories(db);
  console.log(`  stories: ${stories.length}`);
  const uids = [...new Set(stories.map((s) => s.userId))];
  const emails = await fetchEmails(uids);
  console.log(`  users resolved: ${Object.values(emails).filter(Boolean).length}/${uids.length}`);
  let lat = [];
  try {
    lat = await fetchLatencies();
    console.log(`  latency events (${LOG_WINDOW_DAYS}d): ${lat.length}`);
  } catch (e) {
    console.warn(`  ⚠ logging fetch failed (${e.message}); timing charts will be empty`);
  }
  const D = aggregate(stories, emails, lat);
  fs.writeFileSync(OUT, renderHTML(D));
  console.log(`[beta-telemetry] wrote ${OUT}  ⚠ contains PII — do not commit`);
  if (process.platform === 'darwin') { try { execSync(`open ${OUT}`); } catch (_) {} }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
