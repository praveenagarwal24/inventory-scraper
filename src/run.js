#!/usr/bin/env node
/**
 * Daily inventory scrape runner.
 *
 * Reproduces the manual loop (open URL -> open console -> paste script -> CSV downloads)
 * in headless Chrome, then ships each CSV to Google Drive under a YYYY-MM-DD folder.
 *
 * Your scraper scripts are injected VERBATIM. No edits needed to any of them.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------- config

const CFG = {
  sheetId:      env('SHEET_ID', true),
  sheetTab:     env('SHEET_TAB') || 'Main',
  sheetGid:     env('SHEET_GID') || '',          // optional; more reliable than tab name
  urlCol:       env('URL_COL') || 'L',
  scriptCol:    env('SCRIPT_COL') || 'M',
  nameCol:      env('NAME_COL') || '',           // optional: column holding a site label
  appsScriptUrl:env('APPS_SCRIPT_URL') || '',
  runSecret:    env('RUN_SECRET') || '',
  timezone:     env('TIMEZONE') || 'America/New_York',
  concurrency:  int(env('CONCURRENCY'), 3),
  siteTimeout:  int(env('SITE_TIMEOUT_MS'), 6 * 60 * 1000),
  navTimeout:   int(env('NAV_TIMEOUT_MS'), 60 * 1000),
  attempts:     int(env('ATTEMPTS'), 2),
  shardIndex:   int(env('SHARD_INDEX'), 0),
  shardTotal:   int(env('SHARD_TOTAL'), 1),
  only:         env('ONLY') || '',               // substring filter on URL
  dryRun:       env('DRY_RUN') === '1',
  outDir:       path.resolve(env('OUT_DIR') || 'out'),
  failOnError:  env('FAIL_ON_ERROR') === '1',
};

function env(k, required = false) {
  const v = process.env[k];
  if (required && !v) { console.error(`Missing required env var: ${k}`); process.exit(2); }
  return v;
}
function int(v, d) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

const RUN_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// ---------------------------------------------------------------- tiny CSV parser

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const colIndex = (letters) =>
  letters.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

// ---------------------------------------------------------------- sheet + drive

async function loadRows() {
  const url = CFG.sheetGid
    ? `https://docs.google.com/spreadsheets/d/${CFG.sheetId}/export?format=csv&gid=${CFG.sheetGid}`
    : `https://docs.google.com/spreadsheets/d/${CFG.sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CFG.sheetTab)}`;

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}. Is link sharing on?`);
  const body = await res.text();
  if (/<html/i.test(body.slice(0, 400))) {
    throw new Error('Sheet returned HTML, not CSV. Set sharing to "Anyone with the link - Viewer".');
  }

  const uI = colIndex(CFG.urlCol), sI = colIndex(CFG.scriptCol);
  const nI = CFG.nameCol ? colIndex(CFG.nameCol) : -1;

  return parseCsv(body)
    .map((r, i) => ({
      rowNumber: i + 1,
      name: (nI >= 0 ? (r[nI] || '') : '').trim(),
      url: (r[uI] || '').trim(),
      scriptLink: (r[sI] || '').trim(),
    }))
    .filter((r) => /^https?:\/\//i.test(r.url) && /^https?:\/\//i.test(r.scriptLink));
}

function driveFileId(link) {
  const m = link.match(/\/d\/([-\w]{20,})/) || link.match(/[?&]id=([-\w]{20,})/) || link.match(/([-\w]{25,})/);
  if (!m) throw new Error(`Could not extract a Drive file id from: ${link}`);
  return m[1];
}

const isHtml = (t) => /^\s*<(!doctype|html)/i.test(t);

/**
 * Drive refuses to virus-scan .js files and serves a "Download anyway" page instead.
 * In a browser you click through it; here we parse the form and submit it ourselves.
 */
function confirmUrlFrom(html) {
  const form = html.match(/<form[^>]+action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i);
  if (!form) return null;
  const action = form[1].replace(/&amp;/g, '&');
  const params = new URLSearchParams();
  const re = /<input[^>]+type="hidden"[^>]*>/gi;
  let m;
  while ((m = re.exec(form[2]))) {
    const n = m[0].match(/name="([^"]*)"/i);
    const v = m[0].match(/value="([^"]*)"/i);
    if (n) params.set(n[1], (v ? v[1] : '').replace(/&amp;/g, '&'));
  }
  return `${action}?${params.toString()}`;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchScript(link) {
  const id = driveFileId(link);
  const candidates = [
    `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    `https://drive.google.com/uc?export=download&id=${id}&confirm=t`,
    `https://docs.google.com/uc?export=download&id=${id}&confirm=t`,
  ];

  let last = '';
  for (const u of candidates) {
    try {
      let res = await fetch(u, { redirect: 'follow', headers: { 'User-Agent': UA } });
      let text = await res.text();

      // Still on the interstitial? Submit its form and take the result.
      if (isHtml(text)) {
        const next = confirmUrlFrom(text);
        if (next) {
          const cookie = (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
          res = await fetch(next, {
            redirect: 'follow',
            headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}) },
          });
          text = await res.text();
        }
      }

      if (res.ok && text.length > 20 && !isHtml(text)) return text;
      last = `${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
    } catch (e) {
      last = String(e);
    }
  }
  throw new Error(`Could not download script ${id}: ${last}`);
}

// ---------------------------------------------------------------- browser work

const SHIM = () => {
  // Belt and braces: if the anchor-click download does not land on disk in headless,
  // we can still recover the CSV text straight out of the Blob.
  window.__CAPTURED_BLOBS__ = [];
  window.__DL_NAME__ = null;
  try {
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (obj) {
      try { if (obj && typeof obj.text === 'function') window.__CAPTURED_BLOBS__.push(obj); } catch (e) {}
      return origCreate(obj);
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      try { if (this.download) window.__DL_NAME__ = this.download; } catch (e) {}
      return origClick.apply(this, arguments);
    };
  } catch (e) {}
};

async function settledDownload(dir) {
  let entries;
  try { entries = await fsp.readdir(dir); } catch { return null; }
  const done = entries.filter((f) => !f.endsWith('.crdownload') && !f.startsWith('.'));
  if (!done.length) return null;
  const f = path.join(dir, done[0]);
  const a = await fsp.stat(f);
  await new Promise((r) => setTimeout(r, 400));
  const b = await fsp.stat(f);
  return a.size === b.size && b.size > 0 ? { file: f, name: done[0] } : null;
}

async function scrapeOne(browser, site, scriptText) {
  const dlDir = await fsp.mkdtemp(path.join(CFG.outDir, '.dl-'));
  const page = await browser.newPage();
  let evalError = null;

  try {
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    );
    await page.evaluateOnNewDocument(SHIM);

    const client = await page.createCDPSession();
    try {
      await client.send('Browser.setDownloadBehavior', {
        behavior: 'allow', downloadPath: dlDir, eventsEnabled: true,
      });
    } catch {
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    }

    await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    await page.waitForNetworkIdle({ idleTime: 1500, timeout: 20000 }).catch(() => {});

    // Fire the script but do NOT block on it: some scripts never resolve cleanly.
    // The download landing on disk is our real completion signal.
    page.evaluate(scriptText).catch((e) => { evalError = e; });

    const deadline = Date.now() + CFG.siteTimeout;
    while (Date.now() < deadline) {
      const hit = await settledDownload(dlDir);
      if (hit) {
        const csv = await fsp.readFile(hit.file, 'utf8');
        return { name: hit.name, csv, via: 'download' };
      }
      if (evalError) throw new Error(`Script threw: ${evalError.message || evalError}`);
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Fallback: pull the Blob contents out of the page.
    const rec = await page.evaluate(async () => {
      const out = [];
      for (const b of (window.__CAPTURED_BLOBS__ || [])) {
        try { out.push(await b.text()); } catch (e) {}
      }
      return { name: window.__DL_NAME__, texts: out };
    }).catch(() => ({ name: null, texts: [] }));

    const best = (rec.texts || []).sort((a, b) => b.length - a.length)[0];
    if (best && best.length > 50) {
      return { name: rec.name || defaultName(site), csv: best, via: 'blob-recovery' };
    }
    throw new Error(`Timed out after ${Math.round(CFG.siteTimeout / 1000)}s with no CSV`);
  } finally {
    await page.close().catch(() => {});
    await fsp.rm(dlDir, { recursive: true, force: true }).catch(() => {});
  }
}

function defaultName(site) {
  const host = (() => { try { return new URL(site.url).hostname; } catch { return 'site'; } })();
  const slug = (site.name || host).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${slug}_${RUN_DATE}.csv`;
}

// ---------------------------------------------------------------- upload

async function upload(fileName, csv) {
  if (CFG.dryRun || !CFG.appsScriptUrl) return { ok: true, skipped: true };
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  if (b64.length > 45 * 1024 * 1024) throw new Error('CSV too large for the web app (>45MB encoded)');

  const res = await fetch(CFG.appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: CFG.runSecret, action: 'file', date: RUN_DATE, fileName, csvB64: b64 }),
    redirect: 'follow',
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { throw new Error(`Bad web app reply: ${text.slice(0, 200)}`); }
  if (!json.ok) throw new Error(json.error || 'Web app rejected the upload');
  return json;
}

async function postLog(results) {
  if (CFG.dryRun || !CFG.appsScriptUrl) return;
  const rows = results.map((r) => [
    RUN_DATE, new Date().toISOString(), r.url, r.status,
    r.rows ?? '', r.fileName ?? '', r.via ?? '', r.error ?? '',
  ]);
  await fetch(CFG.appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: CFG.runSecret, action: 'log', rows }),
    redirect: 'follow',
  }).catch((e) => console.warn('Log post failed:', e.message));
}

// ---------------------------------------------------------------- orchestration

async function pool(items, size, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await worker(items[n], n); }
  }));
  return out;
}

async function main() {
  await fsp.mkdir(CFG.outDir, { recursive: true });
  console.log(`Run date ${RUN_DATE} (${CFG.timezone})`);

  let rows = await loadRows();
  if (CFG.only) rows = rows.filter((r) => r.url.includes(CFG.only));
  if (CFG.shardTotal > 1) rows = rows.filter((_, i) => i % CFG.shardTotal === CFG.shardIndex);
  console.log(`${rows.length} site(s) to process, concurrency ${CFG.concurrency}\n`);
  if (!rows.length) { console.log('Nothing to do.'); return; }

  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: CFG.siteTimeout + 120000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
    ],
  });

  const used = new Set();
  const results = await pool(rows, CFG.concurrency, async (site) => {
    const label = site.name || site.url;
    for (let attempt = 1; attempt <= CFG.attempts; attempt++) {
      try {
        const script = await fetchScript(site.scriptLink);
        const { name, csv, via } = await scrapeOne(browser, site, script);

        let fileName = name || defaultName(site);
        if (used.has(fileName)) {
          const ext = path.extname(fileName);
          fileName = `${fileName.slice(0, -ext.length)}_${site.rowNumber}${ext}`;
        }
        used.add(fileName);

        await fsp.writeFile(path.join(CFG.outDir, fileName), csv, 'utf8');
        await upload(fileName, csv);

        const dataRows = Math.max(0, csv.trim().split('\n').length - 1);
        console.log(`OK    ${label} -> ${fileName} (${dataRows} rows, ${via})`);
        return { url: site.url, status: 'ok', rows: dataRows, fileName, via };
      } catch (err) {
        const msg = err.message || String(err);
        if (attempt === CFG.attempts) {
          console.error(`FAIL  ${label} -> ${msg}`);
          return { url: site.url, status: 'failed', error: msg };
        }
        console.warn(`retry ${label} (attempt ${attempt}): ${msg}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  });

  await browser.close().catch(() => {});
  await postLog(results);

  const ok = results.filter((r) => r.status === 'ok');
  const bad = results.filter((r) => r.status !== 'ok');
  console.log(`\n${ok.length} succeeded, ${bad.length} failed.`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Scrape ${RUN_DATE}`, '',
      `**${ok.length} succeeded, ${bad.length} failed**`, '',
      '| Site | Status | Rows | File |', '|---|---|---|---|',
      ...results.map((r) =>
        `| ${r.url} | ${r.status === 'ok' ? 'ok' : 'FAILED'} | ${r.rows ?? ''} | ${r.fileName || (r.error || '').slice(0, 90)} |`),
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }

  if (bad.length && (CFG.failOnError || ok.length === 0)) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
