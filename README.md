# Daily inventory scrape → Google Drive

Automates the manual loop — *open URL → open console → paste script → wait → CSV
downloads* — for every dealer site in the sheet, and files the results in Drive.

**Scraper scripts are injected verbatim.** Nothing in column M ever needs editing,
and adding a site means adding a sheet row and nothing else.

## The cycle

```
17:30 IST   Daily inventory scrape        6 parallel shards on GitHub's runners
              ↓ (chained automatically)
            Pickup blocked sites          your Mac, for sites that block datacenter IPs
              ↓
            Drive/<root>/YYYY-MM-DD/Lot-01/*.csv
                                    /_manifest.json
            Sheet "Runs" tab             one row per site per run
```

The second workflow fires whenever the first finishes — scheduled *or* manual — so
triggering the cloud run by hand still completes the full cycle.

## Why it is shaped this way

**Headless Chrome, not plain HTTP.** The scripts never touch the DOM — they're
`fetch()` against JSON APIs plus regex over raw HTML — but they still need a browser:
fetches are origin-relative and inherit cookies, dealer sites run bot protection that
rejects bare HTTP clients, and some scripts read `window` globals.

**An Apps Script web app in the middle.** It runs as you, so it writes to your Drive
on your quota. No service account, which matters because service accounts have no
Drive storage of their own.

**A second runner on your Mac.** Some dealers block datacenter IP ranges outright.
Your home connection reaches them; GitHub's runners do not. Because the manifest
records what's already been collected, the Mac needs no list of blocked sites — it
simply picks up whatever is still missing.

## Files

| Path | What it is |
|---|---|
| `src/run.js` | The whole runner. Both workflows use it. |
| `.github/workflows/daily-scrape.yml` | Cloud run, 6 shards, 17:30 IST weekdays |
| `.github/workflows/pickup-blocked.yml` | Self-hosted run, chained to the above |
| `apps-script/Code.gs` | Drive drop-box. Config lives in Script Properties. |
| `mac-scheduler/` | Optional launchd jobs, for when GitHub's cron runs late |

## Configuration

**GitHub secrets** — Settings → Secrets and variables → Actions:
`SHEET_ID`, `APPS_SCRIPT_URL`, `RUN_SECRET`

**Apps Script** — Project Settings → Script Properties (never in the code, so pasting
a new version cannot wipe them): `SECRET`, `ROOT_FOLDER_ID`, `LOG_SHEET_ID`

**Workflow env** — the knobs worth knowing:

| Setting | Default | What it does |
|---|---|---|
| `CONCURRENCY` | 5 | Sites at once, per shard |
| `SHARD_TOTAL` | 6 | Must equal the number of matrix entries |
| `SITE_TIMEOUT_MS` | 210000 | Per site, per attempt |
| `ATTEMPTS` | 3 | Each retry gets 50% more time than the last |
| `MIN_ROWS_RATIO` | 0.75 | Flag a scrape under 75% of its last good count |
| `LOT_SIZE` | 20 | Files per `Lot-NN` folder, 0 for none |
| `KEEP_DAYS` | 7 | Shard 0 trashes older date folders |
| `CHROME_PATH` | — | Set on the Mac only, to use its installed Chrome |
| `PROXY_URL` / `PROXY_COL` | — | For sites needing a different exit IP |

## The correctness machinery

Most of the complexity here exists because a scrape can fail *quietly*. In rough
order of how much trouble each one saved:

**Row-count baselines.** Scraper scripts paginate with `catch (e) { break; }`, so one
rate-limited page ends collection early and still writes a valid CSV. The runner
compares against the last good count from previous date folders; anything under 75%
is retried with more patience, uploaded with a `LOW` flag, and left unmarked so the
next run tries again.

**Empty CSVs are failures.** A header-only file used to upload and mark the site done.
Now it fails, so the Mac's pickup run gets a shot at it.

**Per-context downloads.** `Browser.setDownloadBehavior` is browser-wide unless scoped
to a context — without that, concurrent sites claimed each other's CSVs and files were
filed under the wrong dealer.

**Content hashing.** Two sheet rows pointing at the same dealer upload once, and the
second is logged `DUP` so you can spot the redundant row.

**Never overwrite bigger with smaller.** A later run can only improve a day's data.

**Fast failure on blocks.** A 4xx page load plus no CSV means an IP-level refusal;
retrying from the same runner is pointless, so it doesn't.

## Reading a run

**Summary tab** of the run — table of every site with status, rows, seconds.
**Runs tab** in the sheet — the same, but accumulating, which is where you spot a
dealer quietly dropping from 400 rows to 12.
**Log tail** — counts, then the low-row list, then failures with reasons, then which
of those look like IP blocks.

Row counts matter more than the green checkmark. A run can succeed and still be wrong.

## Common tasks

**Run everything now** — Actions → Daily inventory scrape → Run workflow, both boxes
empty. Pickup follows automatically.

**Just a few sites** — put comma-separated text in `only`, e.g. `twinpineford,carzup`.
Matched against URL and name, case-insensitive.

**Re-scrape something already collected** — tick `force`.

**Add sites** — add sheet rows. URLs without `https://` are fine; the runner adds it.

**More throughput** — add matrix entries in `daily-scrape.yml` and raise `SHARD_TOTAL`
to match. They must be equal or rows get skipped or done twice. GitHub Free allows 20
concurrent jobs.

## Known rough edges

**Lots can exceed `LOT_SIZE`.** Lot comes from sheet position, so adding rows mid-day
shifts sites between lots and can strand an earlier file. A fix exists in the current
`run.js` and `Code.gs` (a site keeps its lot for the day, and stale copies are cleared).

**Dedupe is per-shard.** Two rows for the same dealer are only caught as `DUP` if they
land in the same shard.

**The Mac must be awake** at pickup time. Locked is fine; asleep is not.
`sudo pmset repeat wakeorpoweron MTWRF 17:25:00` covers it.

**GitHub's cron runs late** — 15 minutes to 2.5 hours observed, and runs are sometimes
dropped entirely. `mac-scheduler/` replaces it with a real clock if that matters.

**Schedules pause after 60 days** of repo inactivity. Any commit resets it.
