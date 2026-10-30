# Digital Library Stats (repo: BYULawLibGuideStats)

Monthly usage stats for the BYU Law Library's LibGuides, Hunter's Query blog, and Digital Commons. Named "LibGuide Stats" until 2026-10-30; the repo name, `lib_guide_stats` app key, `/lib-guide-stats` URLs, and `hunterlaw-lib-guide-stats` service keep the old name.

There are two front ends:

- **Public kiosk** (`site/`, GitHub Pages) -- a 3-column top-10 display with QR codes. It only ever receives aggregate JSON.
- **Internal dashboard** (`server/routes.py` + `apps/admin/templates/lib_guide_stats*.html`, behind the Library Tools login) -- monthly tables with month-over-month change, all-time rollups (incl. FCIL), hide/show and title/author edits for the kiosk, Digital Commons annual statistics, kiosk QR URLs, and a "Push to Public Kiosk" button.

## Where the numbers come from

`scripts/fetch-libguides-stats.js` runs daily in GitHub Actions and rebuilds the previous month (set `REPORT_MONTH=YYYY-MM` to rebuild a specific month):

- Site-wide guide views/users: LibInsight's Google Analytics dataset.
- Per-guide rows: GA4 Data API over the LibGuides, Research Guides, and FCIL properties. These properties **overlap** (LibGuides covers the whole site; the other two are subsets), so per-page and per-day numbers take the max across properties, never the sum. Pages are keyed by `pagePathPlusQueryString`, trimmed to the identifying params (`/c.php?g=…&p=…`). Pages tracked by the FCIL property are tagged FCIL and also saved in a separate `fcil.top_guides` list.
- Hunter's Query and Digital Commons: their own GA4 properties (HQ authors come from the WordPress API).

Before 2026-10-30 the script used `pagePath` (every content page collapsed to `/c.php`) and summed the overlapping properties (per-guide views were about 2x too high). The dashboard and kiosk fall back to the guide title as the key for those older `/c.php` rows.

## Dashboard state

Hide/show, title edits, kiosk URLs, and DC annual stats are saved to `state/` (untracked) so the hourly `git pull --ff-only` cron never hits a dirty tree. "Push to Public Kiosk" commits the kiosk-relevant files to `site/data/` on GitHub and triggers the publish workflow.

## Repo Structure

```text
.
|-- README.md
|-- data/
|   `-- monthly-stats.json
|-- scripts/
|   `-- fetch-libguides-stats.js
|-- site/
|   |-- index.html
|   |-- styles.css
|   |-- app.js
|   `-- data/
|       `-- monthly-stats.json
`-- .github/
    `-- workflows/
        `-- publish.yml
```

## Local Preview

The repository includes sample aggregate data so the page can be previewed before LibGuides API credentials are configured.

```powershell
node scripts/fetch-libguides-stats.js --sample
python -m http.server 8000 -d site
```

Then open `http://localhost:8000`.

## Secure LibGuides API Setup

Do not call LibGuides from browser JavaScript. The dashboard uses this safer flow:

1. GitHub Actions runs `scripts/fetch-libguides-stats.js` on a schedule.
2. The script reads credentials from GitHub Secrets.
3. It calls the LibGuides/Springshare API or a JSON export server-side.
4. It normalizes the response into `site/data/monthly-stats.json`.
5. GitHub Pages publishes only the static files and aggregate JSON.

Springshare's public LibGuides product information confirms RESTful API support and content-use statistics, but the exact OpenAPI endpoints are account-specific and available in LibApps Admin > API. Configure the endpoint secrets from that screen rather than exposing credentials in the page.

## Required GitHub Secrets

Set these in GitHub repository settings under Secrets and variables > Actions.

- `LIBGUIDES_API_BASE_URL`: usually a regional LibApps API base URL.
- `LIBGUIDES_SITE_ID`: your LibGuides site ID, if the endpoint requires it.
- `LIBGUIDES_GUIDE_STATS_ENDPOINT`: the guide statistics endpoint path or full URL from Admin > API.
- `LIBGUIDES_ASSET_STATS_ENDPOINT`: the asset statistics endpoint path or full URL from Admin > API.

Use one authentication mode:

- OAuth/client credentials: `LIBGUIDES_CLIENT_ID`, `LIBGUIDES_CLIENT_SECRET`, and optionally `LIBGUIDES_TOKEN_URL`.
- API key fallback: `LIBGUIDES_API_KEY`, plus `LIBGUIDES_API_KEY_PARAM` or `LIBGUIDES_API_KEY_HEADER` if your endpoint uses a nonstandard key location.

Optional endpoint parameter secrets:

- `LIBGUIDES_SITE_PARAM`: defaults to `site_id`; set blank if not needed.
- `LIBGUIDES_START_PARAM`: defaults to `start`; set blank if not needed.
- `LIBGUIDES_END_PARAM`: defaults to `end`; set blank if not needed.
- `LIBGUIDES_MONTH_PARAM`: optional `YYYY-MM` parameter name.

## Local Raw Export Option

If the relevant LibGuides stats are available as a JSON export instead of an API endpoint, place the export outside the public `site/` directory and run:

```powershell
$env:LIBGUIDES_RAW_STATS_FILE = "exports/raw-libguides-stats.json"
node scripts/fetch-libguides-stats.js
```

The script accepts common field names such as `views`, `page_views`, `hits`, `clicks`, `subject`, `category`, `updated_at`, and `friendly_url`, then writes the normalized public data file.

## Publish

The included workflow deploys the `site/` directory to GitHub Pages. After secrets are configured, enable Pages for GitHub Actions in repository settings and run the workflow manually once from the Actions tab.

## Data Safety

- No credentials are stored in committed files.
- `.env` files are ignored by git.
- The public JSON contains aggregate guide and asset metrics only.
- Personal identifiers should not be requested from the API or included in exports.
- If an endpoint returns more detail than needed, reduce it in `scripts/fetch-libguides-stats.js` before publishing.
