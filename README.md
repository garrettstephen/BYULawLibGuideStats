# BYULawLibGuideStats

A small pipeline for pulling LibGuides statistics, identifying the top guides for a given month, and publishing the results to GitHub Pages.

## Goal

Build a simple public page that shows things like:

- Top guides this month
- Top guides last month
- Month-over-month change
- Optional detail view for a single guide

## Suggested approach

1. Fetch guide statistics from LibGuides with the LibGuides API or the relevant Springshare reporting endpoint.
2. Normalize the data into a small JSON file.
3. Rank guides by page views for the target month.
4. Generate a static HTML or Markdown summary from the JSON.
5. Publish the output to GitHub Pages with GitHub Actions.

## Recommended repo structure

```text
.
├── README.md
├── data/
│   └── monthly-stats.json
├── scripts/
│   └── fetch-libguides-stats.js
├── site/
│   └── index.html
└── .github/
    └── workflows/
        └── publish.yml
```

## Data fields to capture

For each guide, store something like:

- `guide_id`
- `title`
- `url`
- `views`
- `month`
- `year`
- `rank`

Optional fields:

- `views_previous_month`
- `change`
- `change_percent`
- `subject` or `category`

## GitHub Pages plan

Use a scheduled GitHub Action to:

- run the fetch script once per day or once per month
- write the newest JSON and HTML output into the repository
- publish the `site/` or `docs/` folder through GitHub Pages

## Secrets

Keep API credentials in GitHub Secrets, not in the browser page.

Possible secrets:

- `LIBGUIDES_API_KEY`
- `LIBGUIDES_API_SECRET`
- `LIBGUIDES_BASE_URL`

## Next steps

- Confirm the exact LibGuides reporting endpoint you want to use.
- Decide whether the source should be raw LibGuides stats or a LibInsight export.
- Write the fetch script.
- Add a GitHub Actions workflow.
- Generate the public page.

## Notes

If the LibGuides endpoint requires private auth, the request should run in GitHub Actions or another server-side job rather than in client-side JavaScript.
