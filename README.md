# BYULawLibGuideStats

A static public dashboard for BYU Law Library LibGuide usage. Private LibGuides credentials stay server-side in GitHub Actions or a local `.env`; the published page only receives aggregate JSON.

## What It Shows

- Top guides for the reporting month
- Month-over-month guide-view movement
- Most used LibGuide asset types
- Guide views by subject/category
- Recently updated guides
- Methodology and privacy notes

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
