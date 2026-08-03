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
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';

// ---------------------------------------------------------------- config

const CFG = {
  sheetId:      env('SHEET_ID', true),
  sheetTab:     env('SHEET_TAB') || 'Main',
  sheetGid:     env('SHEET_GID') || '',
  urlCol:       env('URL_COL') || 'L',
  scriptCol:    env('SCRIPT_COL') || 'M',
  nameCol:      env('NAME_COL') || '',
  proxyCol:     env('PROXY_COL') || '',        // optional per-site proxy column
  appsScriptUrl:env('APPS_SCRIPT_URL') || '',
  runSecret:    env('RUN_SECRET') || '',
  timezone:     env('TIMEZONE') || 'America/New_York',
  concurrency:  int(env('CONCURRENCY'), 8),
  stagger:      int(env('STAGGER_MS'), 400),    // spread out the FIRST batch only
  siteTimeout:  int(env('SITE_TIMEOUT_MS'), 150 * 1000),
  navTimeout:   int(env('NAV_TIMEOUT_MS'), 45 * 1000),
  idleGrace:    int(env('IDLE_GRACE_MS'), 8 * 1000),   // quiet time before we call it done
  attempts:     int(env('ATTEMPTS'), 2),
  blockAssets:  env('BLOCK_ASSETS') !== '0',
  skipExisting: env('SKIP_EXISTING') !== '0',   // skip sites already in Drive for today
  maxMinutes:   int(env('MAX_MINUTES'), 0),     // stop starting new sites after this
  proxyUrl:     env('PROXY_URL') || '',        // applies to every site unless overridden
  shardIndex:   int(env('SHARD_INDEX'), 0),
  shardTotal:   int(env('SHARD_TOTAL'), 1),
  only:         env('ONLY') || '',
  limit:        int(env('LIMIT'), 0),
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Heavy assets the scrapers never read. Blocking these is the single biggest speed win:
// dealer sites are image-dense, and none of it feeds the CSV.
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const BLOCKED_HOSTS = [
  'googletagmanager.com', 'google-analytics.com', 'doubleclick.net', 'facebook.net',
  'facebook.com', 'hotjar.com', 'clarity.ms', 'newrelic.com', 'nr-data.net',
  'cdn.segment.com', 'fullstory.com', 'mouseflow.com', 'quantserve.com',
  'scorecardresearch.com', 'adsrvr.org', 'bing.com/bat', 'taboola.com', 'outbrain.com',
];

// ---------------------------------------------------------------- CSV + sheet

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
  const pI = CFG.proxyCol ? colIndex(CFG.proxyCol) : -1;

  return parseCsv(body)
    .map((r, i) => ({
      rowNumber: i + 1,
      name: (nI >= 0 ? (r[nI] || '') : '').trim(),
      url: (r[uI] || '').trim(),
      scriptLink: (r[sI] || '').trim(),
      proxy: (pI >= 0 ? (r[pI] || '') : '').trim() || CFG.proxyUrl,
    }))
    .filter((r) => /^https?:\/\//i.test(r.url) && /^https?:\/\//i.test(r.scriptLink));
}

// ---------------------------------------------------------------- Drive

function driveFileId(link) {
  const m = link.match(/\/d\/([-\w]{20,})/) || link.match(/[?&]id=([-\w]{20,})/) || link.match(/([-\w]{25,})/);
  if (!m) throw new Error(`Could not extract a Drive file id from: ${link}`);
  return m[1];
}

const isHtml = (t) => /^\s*<(!doctype|html)/i.test(t);

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

const scriptCache = new Map();

async function fetchScript(link) {
  const id = driveFileId(link);
  if (scriptCache.has(id)) return scriptCache.get(id);

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
      if (res.ok && text.length > 20 && !isHtml(text)) { scriptCache.set(id, text); return text; }
      last = `${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`;
    } catch (e) { last = String(e); }
  }
  throw new Error(`Could not download script ${id}: ${last}`);
}

// ---------------------------------------------------------------- browser

const SHIM = () => {
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
  await sleep(300);
  const b = await fsp.stat(f);
  return a.size === b.size && b.size > 0 ? { file: f, name: done[0] } : null;
}

function parseProxy(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch { return { server: raw, username: '', password: '' }; }
}

async function scrapeOne(browser, site, scriptText) {
  const t0 = Date.now();
  const dlDir = await fsp.mkdtemp(path.join(CFG.outDir, '.dl-'));
  const proxy = parseProxy(site.proxy);

  const context = proxy
    ? await browser.createBrowserContext({ proxyServer: proxy.server })
    : await browser.createBrowserContext();
  const page = await context.newPage();

  let evalDone = false, evalError = null, lastActivity = Date.now();
  const pageErrors = [];

  try {
    if (proxy && proxy.username) await page.authenticate({ username: proxy.username, password: proxy.password });
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(UA);
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
    });
    await page.evaluateOnNewDocument(SHIM);

    page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text().slice(0, 200)); });

    if (CFG.blockAssets) {
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        lastActivity = Date.now();
        const url = req.url();
        if (BLOCKED_TYPES.has(req.resourceType()) || BLOCKED_HOSTS.some((h) => url.includes(h))) {
          req.abort().catch(() => {});
        } else {
          req.continue().catch(() => {});
        }
      });
    } else {
      page.on('request', () => { lastActivity = Date.now(); });
    }
    page.on('response', () => { lastActivity = Date.now(); });

    // Scope the download path to THIS context. Browser.setDownloadBehavior is
    // browser-wide by default, so without browserContextId concurrent sites
    // overwrite each other's path and files get claimed by the wrong site.
    const client = await page.createCDPSession();
    const ctxId = context.id || context._id;
    let scoped = false;
    if (ctxId) {
      try {
        await client.send('Browser.setDownloadBehavior', {
          behavior: 'allow', downloadPath: dlDir, eventsEnabled: true, browserContextId: ctxId,
        });
        scoped = true;
      } catch { scoped = false; }
    }
    if (!scoped) {
      // Page-scoped fallback. Deprecated, but per-page and therefore still safe.
      await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
    }

    const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: CFG.navTimeout });
    const loadStatus = resp ? resp.status() : 0;
    if (loadStatus >= 400) {
      // Not fatal. The landing page may be challenged while the APIs still answer.
      console.warn(`  note  ${site.url} loaded with HTTP ${loadStatus}; continuing anyway`);
    }
    await page.waitForNetworkIdle({ idleTime: 800, timeout: 3000 }).catch(() => {});

    // Kick the script off. We do not block on it: the download landing on disk is the
    // real completion signal, and not every script resolves cleanly.
    page.evaluate(scriptText).then(() => { evalDone = true; }, (e) => { evalError = e; });

    const deadline = Date.now() + CFG.siteTimeout;
    while (Date.now() < deadline) {
      const hit = await settledDownload(dlDir);
      if (hit) {
        const csv = await fsp.readFile(hit.file, 'utf8');
        return { name: hit.name, csv, via: 'download', secs: Math.round((Date.now() - t0) / 1000) };
      }
      if (evalError) {
        const e = new Error(`Script threw: ${evalError.message || evalError}`);
        if (loadStatus >= 400) e.blocked = true;
        throw e;
      }

      // Fast fail: script finished AND the network has gone quiet, but no file appeared.
      // Waiting out the full timeout here is what used to make bad sites cost 6 minutes.
      if (evalDone && Date.now() - lastActivity > CFG.idleGrace) break;

      await sleep(500);
    }

    const rec = await page.evaluate(async () => {
      const out = [];
      for (const b of (window.__CAPTURED_BLOBS__ || [])) {
        try { out.push(await b.text()); } catch (e) {}
      }
      return { name: window.__DL_NAME__, texts: out };
    }).catch(() => ({ name: null, texts: [] }));

    const best = (rec.texts || []).sort((a, b) => b.length - a.length)[0];
    if (best && best.length > 50) {
      return {
        name: rec.name || defaultName(site), csv: best,
        via: 'blob-recovery', secs: Math.round((Date.now() - t0) / 1000),
      };
    }

    const why = evalDone ? 'script finished but produced no CSV' : 'script never finished';
    const blocked = loadStatus >= 400 ? ` | page load was HTTP ${loadStatus}, likely bot/geo block` : '';
    const hint = pageErrors.length ? ` | page errors: ${pageErrors.slice(-2).join(' ; ')}` : '';
    const err = new Error(`${why} after ${Math.round((Date.now() - t0) / 1000)}s${blocked}${hint}`);
    if (loadStatus >= 400) err.blocked = true;
    throw err;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await fsp.rm(dlDir, { recursive: true, force: true }).catch(() => {});
  }
}

function defaultName(site) {
  const host = (() => { try { return new URL(site.url).hostname; } catch { return 'site'; } })();
  const slug = (site.name || host).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `${slug}_${RUN_DATE}.csv`;
}

// ---------------------------------------------------------------- upload

async function postToWebApp(payload, tries = 3) {
  let last = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(CFG.appsScriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json.ok) return json;
        last = json.error || 'web app returned ok:false';
        // A rejected secret will never succeed; do not burn retries on it.
        if (/secret/i.test(last)) throw new Error(last);
      } catch (parseErr) {
        if (parseErr.message === last) throw parseErr;
        last = `non-JSON reply (${text.slice(0, 80).replace(/\s+/g, ' ')})`;
      }
    } catch (e) {
      if (/secret/i.test(e.message)) throw e;
      last = e.message;
    }
    if (i < tries) await sleep(i * 2500);
  }
  throw new Error(last);
}

async function upload(fileName, csv, siteUrl, dataRows) {
  if (CFG.dryRun || !CFG.appsScriptUrl) return { ok: true, skipped: true };
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  if (b64.length > 45 * 1024 * 1024) throw new Error('CSV too large for the web app (>45MB encoded)');

  return postToWebApp({
    secret: CFG.runSecret, action: 'file', date: RUN_DATE,
    fileName, csvB64: b64, site: siteUrl, rows: dataRows,
  });
}

async function postLog(results) {
  if (CFG.dryRun || !CFG.appsScriptUrl) return;
  const rows = results.map((r) => [
    RUN_DATE, new Date().toISOString(), r.url, r.status,
    r.rows ?? '', r.fileName ?? '', r.secs ?? '', r.error ?? '',
  ]);
  await fetch(CFG.appsScriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: CFG.runSecret, action: 'log', rows }),
    redirect: 'follow',
  }).catch((e) => console.warn('Log post failed:', e.message));
}

async function fetchDoneSites() {
  if (!CFG.skipExisting || CFG.dryRun || !CFG.appsScriptUrl) return new Set();
  try {
    const j = await postToWebApp({ secret: CFG.runSecret, action: 'manifest', date: RUN_DATE });
    return new Set(j.done || []);
  } catch (e) {
    console.warn(`Manifest lookup failed: ${e.message}. Processing everything.`);
    return new Set();
  }
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

  // Apps Script cold-starts in ~30s. Launch Chrome while we wait rather than after.
  const browserPromise = puppeteer.launch({
    headless: 'new',
    protocolTimeout: CFG.siteTimeout + 120000,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,900',
    ],
  });

  let rows = await loadRows();
  console.log(`Sheet returned ${rows.length} usable row(s)`);

  if (CFG.only) {
    const terms = CFG.only.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    rows = rows.filter((r) => terms.some((t) => `${r.url} ${r.name}`.toLowerCase().includes(t)));
    console.log(`Filter "${CFG.only}" matched ${rows.length} site(s)`);
  }
  const done = await fetchDoneSites();
  if (done.size) {
    const before = rows.length;
    rows = rows.filter((r) => !done.has(r.url));
    console.log(`Already in Drive for ${RUN_DATE}: ${before - rows.length} site(s) skipped, ${rows.length} pending`);
  }

  if (CFG.shardTotal > 1) rows = rows.filter((_, i) => i % CFG.shardTotal === CFG.shardIndex);
  if (CFG.limit > 0 && rows.length > CFG.limit) {
    console.log(`Taking the next ${CFG.limit} of ${rows.length} pending site(s)`);
    rows = rows.slice(0, CFG.limit);
  }

  if (!rows.length) {
    if (!done.size) console.error(
      '\nNo sites to process. A run that scrapes nothing is a failure, not a success.\n' +
      (CFG.only ? `  - The "only" filter was "${CFG.only}" and matched nothing.\n` : '') +
      '  - Otherwise: is the sheet shared as "Anyone with the link"?\n' +
      `  - Does tab "${CFG.sheetTab}" have URLs in column ${CFG.urlCol} and Drive links in column ${CFG.scriptCol}?`
    );
    if (done.size) {
      console.log(`\nNothing pending. All ${done.size} site(s) already have files in Drive for ${RUN_DATE}.`);
      console.log('Set SKIP_EXISTING=0 or use the "force" input to re-scrape them.');
      return;
    }
    process.exit(1);
  }

  console.log(
    `${rows.length} site(s), concurrency ${CFG.concurrency}, ` +
    `timeout ${Math.round(CFG.siteTimeout / 1000)}s, assets ${CFG.blockAssets ? 'blocked' : 'allowed'}` +
    `${CFG.proxyUrl ? ', proxy on' : ''}\n`
  );

  // Pull every scraper script up front, 15 at a time. Doing this inside the worker
  // pool meant each fetch occupied a scraping slot for no reason.
  const preT = Date.now();
  await pool(rows, 15, async (site) => {
    try { await fetchScript(site.scriptLink); } catch (e) { /* surfaced later per-site */ }
  });
  console.log(`Prefetched ${scriptCache.size} script(s) in ${Math.round((Date.now() - preT) / 1000)}s\n`);

  const browser = await browserPromise;
  const started = Date.now();
  const used = new Set();
  const seenHashes = new Map();   // csv sha1 -> filename already uploaded this run
  let launched = 0;

  const results = await pool(rows, CFG.concurrency, async (site) => {
    const label = site.name || site.url;
    if (CFG.maxMinutes && Date.now() - started > CFG.maxMinutes * 60000) {
      return { url: site.url, status: 'skipped', error: 'time budget reached; will resume next run' };
    }
    if (CFG.stagger && launched < CFG.concurrency) await sleep(launched++ * CFG.stagger);

    for (let attempt = 1; attempt <= CFG.attempts; attempt++) {
      try {
        const script = await fetchScript(site.scriptLink);
        const { name, csv, via, secs } = await scrapeOne(browser, site, script);

        const dataRows = Math.max(0, csv.trim().split('\n').length - 1);
        const hash = crypto.createHash('sha1').update(csv).digest('hex');

        // Two sheet rows can point at the same dealer (alias domains, or the same
        // script listed twice). Identical content goes to Drive once, not twice.
        if (seenHashes.has(hash)) {
          const twin = seenHashes.get(hash);
          console.log(`DUP   ${label} -> identical to ${twin}, not uploaded again`);
          return { url: site.url, status: 'duplicate', rows: dataRows, fileName: twin, secs };
        }

        let fileName = name || defaultName(site);
        if (used.has(fileName)) {
          const ext = path.extname(fileName);
          fileName = `${fileName.slice(0, -ext.length)}_${site.rowNumber}${ext}`;
        }
        used.add(fileName);
        seenHashes.set(hash, fileName);

        await fsp.writeFile(path.join(CFG.outDir, fileName), csv, 'utf8');
        await upload(fileName, csv, site.url, dataRows);
        const tag = dataRows === 0 ? 'EMPTY' : 'OK   ';
        console.log(`${tag} ${label} -> ${fileName} (${dataRows} rows, ${secs}s, ${via})`);
        return { url: site.url, status: 'ok', rows: dataRows, fileName, secs, via };
      } catch (err) {
        const msg = err.message || String(err);
        if (err.blocked) {
          // The site refused us at the network layer. A second identical attempt
          // from the same IP will be refused too - do not pay the timeout twice.
          console.error(`FAIL  ${label} -> ${msg}`);
          return { url: site.url, status: 'failed', error: msg, blocked: true };
        }
        if (attempt === CFG.attempts) {
          console.error(`FAIL  ${label} -> ${msg}`);
          return { url: site.url, status: 'failed', error: msg };
        }
        console.warn(`retry ${label} (attempt ${attempt}): ${msg}`);
        await sleep(8000 * attempt);
      }
    }
  });

  await browser.close().catch(() => {});
  await postLog(results);

  const ok = results.filter((r) => r.status === 'ok');
  const dup = results.filter((r) => r.status === 'duplicate');
  const skipped = results.filter((r) => r.status === 'skipped');
  const bad = results.filter((r) => r.status === 'failed');
  console.log(
    `\n${ok.length} succeeded, ${bad.length} failed` +
    `${dup.length ? `, ${dup.length} duplicate` : ''}` +
    `${skipped.length ? `, ${skipped.length} deferred to next run` : ''}` +
    ` in ${Math.round((Date.now() - started) / 1000)}s.`
  );
  const empty = ok.filter((r) => r.rows === 0);
  if (empty.length) {
    console.log(`\nProduced an empty CSV (${empty.length}) - worth checking these scripts:`);
    empty.forEach((r) => console.log(`  ${r.url}`));
  }
  if (bad.length) {
    const blocked = bad.filter((r) => r.blocked);
    console.log('\nFailures:');
    bad.forEach((r) => console.log(`  ${r.url}\n    ${r.error}`));
    if (blocked.length) {
      console.log(`\n${blocked.length} of those look like IP-level blocks. A proxy or a`);
      console.log('self-hosted runner is the fix for those, not more retries.');
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Scrape ${RUN_DATE}`, '',
      `**${ok.length} succeeded, ${bad.length} failed**`, '',
      '| Site | Status | Rows | Secs | Detail |', '|---|---|---|---|---|',
      ...results.map((r) =>
        `| ${r.url} | ${r.status === 'ok' ? 'ok' : 'FAILED'} | ${r.rows ?? ''} | ${r.secs ?? ''} | ${r.fileName || (r.error || '').slice(0, 120)} |`),
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }

  if (bad.length && (CFG.failOnError || ok.length === 0)) process.exit(1);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
