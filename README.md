# Daily inventory scrape → Google Drive

Automates the manual loop — *open URL → open console → paste script → wait → CSV downloads* —
and files each result in Drive under `YYYY-MM-DD/`.

**Your scraper scripts are injected verbatim.** Nothing in column M needs editing, now or when
you add sites.

```
Google Sheet "Main"          GitHub Actions (daily cron)         Apps Script Web App
 col L = site URL      ──▶   headless Chrome                ──▶  runs as YOU
 col M = Drive JS link       injects the script                  Drive/root/2026-08-04/*.csv
                             catches the download                logs to sheet tab "Runs"
```

## Why this shape

The Twin Pine script never touches the DOM — it's `fetch()` against a JSON API plus regex over
raw HTML. But it still needs a browser: the fetches are origin-relative and inherit cookies and
`Referer`, dealer sites run bot protection that rejects bare HTTP clients, and the script reads
`window.DlronGlobal_DealerId`. Puppeteer gives you all of that for free and keeps every script
usable in both places — you can still paste them into your own console to debug.

The Apps Script hop exists so no service account is needed. Service accounts have no Drive
storage quota of their own and fail on personal Gmail. A web app deployed as *you* writes to
*your* Drive on *your* quota, identically on personal and Workspace accounts.

---

## Setup

### 1. Drive folder

Create the folder that will hold the dated subfolders. From its URL:
`drive.google.com/drive/folders/`**`THIS_PART`** — that's `ROOT_FOLDER_ID`.

### 2. Apps Script web app

1. In your sheet: **Extensions → Apps Script**.
2. Paste `apps-script/Code.gs` over `Code.gs`.
3. Fill in the top four constants. For `SECRET`, generate a long random string
   (`openssl rand -hex 24`) and keep a copy.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Authorize when prompted (the "unverified app" warning is expected for your own script —
   *Advanced → Go to …*).
6. Copy the `/exec` URL.

"Anyone" only means anyone can send a request. The secret gates it, and the app can only ever
write into `ROOT_FOLDER_ID`.

Test it: open the `/exec` URL in a browser. You should see `{"ok":true,...}`.

### 3. Sheet sharing

The runner reads `Main` over plain HTTP, so set sharing to **Anyone with the link → Viewer**.
If you'd rather keep it private, tell me and I'll switch the reader to go through the same
web app instead.

### 4. GitHub

Push this repo, then **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SHEET_ID` | `1GGUZPI3-i7aMscZaWqkBrTIh0mPJcRiMZO9favMxOnM` |
| `APPS_SCRIPT_URL` | the `/exec` URL |
| `RUN_SECRET` | the same random string as `SECRET` |

Then **Actions → Daily inventory scrape → Run workflow** to test before trusting the cron.

Use a **public** repo for unlimited free minutes, or private for 2,000/month. Nothing sensitive
lives in the code — all three secrets are in GitHub Secrets.

---

## Running it

| Where | How |
|---|---|
| Scheduled | 09:00 UTC daily. Cron is always UTC and does not follow DST — edit the `cron:` line to shift it. |
| Manual | Actions → Run workflow. The **only** input filters to sites whose URL contains that text — handy for testing one dealer. |
| Locally | `npm install`, set the env vars, `npm start`. `npm run dry` skips upload and just writes to `out/`. |

Every run writes a summary table to the Actions page, appends to the **Runs** tab of your sheet,
and keeps the CSVs as a downloadable artifact for 7 days.

## Knobs

| Env var | Default | Notes |
|---|---|---|
| `CONCURRENCY` | `3` | Sites at once. Raise carefully — it's a load question, not a CPU one. |
| `SITE_TIMEOUT_MS` | `360000` | Per site. Twin Pine takes 30–60s; big stores need more. |
| `ATTEMPTS` | `2` | Retries per site before giving up. |
| `TIMEZONE` | `America/New_York` | Decides which date the folder is named after. |
| `URL_COL` / `SCRIPT_COL` | `L` / `M` | Change if the sheet layout moves. |
| `NAME_COL` | — | Optional column with a site label, used in logs and fallback filenames. |
| `ONLY` | — | Substring filter on URL. |
| `FAIL_ON_ERROR` | `0` | By default the run is only red if *every* site failed. |

---

## When something breaks

**One site fails, others fine.** Almost always the site changed. In the Twin Pine case the usual
culprit is the `PIDS` page IDs — the script's own header comment tells you how to re-read them.
Open the URL in your own Chrome, paste the script, and watch the console.

**Everything fails at once.** Suspect the sheet URL, the secret, or the web app deployment.
Note that editing the Apps Script requires **Deploy → Manage deployments → Edit → New version**;
saving alone does not update the live `/exec`.

**A site returns 403 / a challenge page.** This is the one real risk of running in the cloud:
Cloudflare treats GitHub's datacenter IPs more harshly than your laptop. If a dealer starts
blocking, options are a stealth plugin, a residential proxy, or moving that one site to a
self-hosted runner on your own machine. Worth knowing about now rather than being surprised.

**A script needs a login.** Ask me — cookie injection is a small addition to `scrapeOne`.

## Scaling past ~100 sites

The workflow is one job. To parallelise, add a matrix and pass the shard vars — the runner
already honours them:

```yaml
strategy:
  matrix:
    shard: [0, 1, 2, 3]
env:
  SHARD_INDEX: ${{ matrix.shard }}
  SHARD_TOTAL: '4'
```

## Note on testing

The parsing layer (sheet CSV, column letters, Drive link → file ID, including quoted fields
containing commas) is unit-tested and passing. The browser layer could not be exercised in my
sandbox — Chrome's download host is outside my allowlist — so the first real validation is your
manual workflow run. Start with `ONLY` set to `twinpineford` and compare the row count against
the 646 in the script header.
