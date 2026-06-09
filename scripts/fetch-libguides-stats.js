#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const DATA_OUT = path.join(ROOT, "data", "monthly-stats.json");
const SITE_DATA_OUT = path.join(ROOT, "site", "data", "monthly-stats.json");
const SAMPLE_DATA = path.join(ROOT, "site", "data", "monthly-stats.json");

const args = new Set(process.argv.slice(2));

function env(name, fallback = "") {
  const value = process.env[name];
  return value == null || value === "" ? fallback : value;
}

function trimSlash(value) {
  return value.replace(/\/+$/, "");
}

function parseBoolean(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function monthWindow() {
  const requested = env("REPORT_MONTH");
  const now = new Date();
  const base = requested && /^\d{4}-\d{2}$/.test(requested)
    ? new Date(`${requested}-01T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + 1;
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const endDate = new Date(Date.UTC(year, month, 0));
  const end = endDate.toISOString().slice(0, 10);
  const prevBase = new Date(Date.UTC(year, month - 2, 1));
  const prevYear = prevBase.getUTCFullYear();
  const prevMonth = prevBase.getUTCMonth() + 1;
  const previousStart = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
  const previousEnd = new Date(Date.UTC(prevYear, prevMonth, 0)).toISOString().slice(0, 10);
  const label = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(base);
  const previousLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(prevBase);
  return { year, month, start, end, label, previous_label: previousLabel, previous_start: previousStart, previous_end: previousEnd };
}

function endpointUrl(endpoint, config, reportMonth) {
  if (!endpoint) return null;
  const url = new URL(endpoint, `${config.baseUrl}/`);
  const params = {
    [config.siteParam]: config.siteId,
    [config.startParam]: reportMonth.start,
    [config.endParam]: reportMonth.end,
    [config.monthParam]: `${reportMonth.year}-${String(reportMonth.month).padStart(2, "0")}`
  };

  for (const [key, value] of Object.entries(params)) {
    if (key && value && !url.searchParams.has(key)) {
      url.searchParams.set(key, value);
    }
  }

  if (config.apiKey && config.apiKeyParam && !url.searchParams.has(config.apiKeyParam)) {
    url.searchParams.set(config.apiKeyParam, config.apiKey);
  }

  return url;
}

async function getGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret })
  });
  const t = await r.json();
  if (!t.access_token) throw new Error(`Google token refresh failed: ${t.error} — ${t.error_description}`);
  return t.access_token;
}

async function fetchGa4Pages(propertyId, accessToken, from, to, limit = 30) {
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: "pageTitle" }, { name: "pagePath" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit
    })
  });
  const d = await r.json();
  if (d.error) {
    if (d.error.code === 403) return null;
    throw new Error(`GA4 error for property ${propertyId}: ${d.error.message}`);
  }
  return d.rows || [];
}

function cleanTitle(title) {
  return String(title || "").replace(/ - Library Guides at BYU Law Library$/i, "").replace(/ - BYU Law Library LibGuides$/i, "").trim() || "Untitled";
}

function inferSubject(title, path) {
  const t = (title + " " + path).toLowerCase();
  if (t.includes("fcil") || t.includes("foreign") || t.includes("international")) return "FCIL";
  if (t.includes("family") || t.includes("landlord") || t.includes("housing") || t.includes("immigration") || t.includes("legal aid") || t.includes("low-cost") || t.includes("free and")) return "Public Services";
  if (t.includes("research guide") || t.includes("home") || t.includes("getting started")) return "General Research";
  if (t.includes("criminal") || t.includes("tort") || t.includes("civil")) return "Litigation";
  if (t.includes("business") || t.includes("corporate") || t.includes("tax")) return "Business & Tax";
  if (t.includes("constitutional") || t.includes("admin") || t.includes("government")) return "Public Law";
  if (t.includes("intellectual") || t.includes("patent") || t.includes("copyright")) return "IP Law";
  return "Other";
}

async function authHeaders(config) {
  const headers = { Accept: "application/json" };

  if (config.clientId && config.clientSecret) {
    const tokenUrl = config.tokenUrl || `${config.baseUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.clientId,
      client_secret: config.clientSecret
    });
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    if (!response.ok) {
      throw new Error(`LibGuides token request failed with HTTP ${response.status}`);
    }
    const token = await response.json();
    const accessToken = token.access_token || token.token;
    if (!accessToken) throw new Error("LibGuides token response did not include an access token.");
    headers.Authorization = `Bearer ${accessToken}`;
  }

  if (config.apiKey && config.apiKeyHeader) {
    headers[config.apiKeyHeader] = config.apiKey;
  }

  return headers;
}

async function fetchJson(url, headers) {
  const safeUrl = new URL(url);
  for (const key of ["key", "api_key", "apikey", "token", "access_token"]) {
    if (safeUrl.searchParams.has(key)) safeUrl.searchParams.set(key, "[redacted]");
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`LibGuides request failed with HTTP ${response.status}: ${safeUrl.toString()}`);
  }
  return response.json();
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] != null && row[key] !== "") return row[key];
  }
  return undefined;
}

function numericValue(row, keys) {
  const value = firstValue(row, keys);
  const parsed = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function arrayFrom(value, preferredKeys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of preferredKeys) {
    if (Array.isArray(value[key])) return value[key];
  }
  for (const nested of Object.values(value)) {
    if (Array.isArray(nested)) return nested;
    if (nested && typeof nested === "object") {
      const result = arrayFrom(nested, preferredKeys);
      if (result.length) return result;
    }
  }
  return [];
}

function percentChange(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function normalizeGuide(row, index) {
  const views = numericValue(row, ["views", "guide_views", "page_views", "pageviews", "hits", "sessions", "count", "total"]);
  const previous = numericValue(row, ["views_previous_month", "previous_views", "prior_views", "last_month_views", "previous", "prior"]);
  const change = firstValue(row, ["change"]) != null ? numericValue(row, ["change"]) : views - previous;
  const changePercent = firstValue(row, ["change_percent", "percent_change", "change_pct"]) != null
    ? numericValue(row, ["change_percent", "percent_change", "change_pct"])
    : percentChange(views, previous);

  return {
    guide_id: String(firstValue(row, ["guide_id", "id", "guideId", "content_id", "slug"]) ?? `guide-${index + 1}`),
    title: String(firstValue(row, ["title", "name", "guide_title", "guideName"]) ?? "Untitled guide"),
    url: String(firstValue(row, ["url", "friendly_url", "public_url", "link"]) ?? "#"),
    views,
    views_previous_month: previous,
    change,
    change_percent: changePercent,
    rank: index + 1,
    subject: String(firstValue(row, ["subject", "category", "group", "type"]) ?? "Uncategorized"),
    updated: firstValue(row, ["updated", "updated_at", "last_updated", "modified", "modified_at"]) || ""
  };
}

function normalizeAsset(row) {
  const clicks = numericValue(row, ["clicks", "asset_clicks", "views", "hits", "count", "total"]);
  return {
    asset_id: String(firstValue(row, ["asset_id", "id", "assetId", "slug"]) ?? "asset"),
    title: String(firstValue(row, ["title", "name", "asset_title"]) ?? "Untitled asset"),
    type: String(firstValue(row, ["type", "asset_type", "format", "category"]) ?? "Asset"),
    url: String(firstValue(row, ["url", "link", "public_url"]) ?? ""),
    clicks
  };
}

function buildCategories(guides, rawCategories) {
  const categoryRows = arrayFrom(rawCategories, ["category_views", "categories", "subjects"]);
  if (categoryRows.length) {
    return categoryRows
      .map((row) => ({
        category: String(firstValue(row, ["category", "subject", "name", "title"]) ?? "Uncategorized"),
        views: numericValue(row, ["views", "guide_views", "page_views", "hits", "count", "total"])
      }))
      .filter((row) => row.views > 0)
      .sort((a, b) => b.views - a.views);
  }

  const totals = new Map();
  for (const guide of guides) {
    totals.set(guide.subject, (totals.get(guide.subject) || 0) + guide.views);
  }
  return [...totals.entries()]
    .map(([category, views]) => ({ category, views }))
    .sort((a, b) => b.views - a.views);
}

function normalizeWeeklyTrend(rawTrend) {
  return arrayFrom(rawTrend, ["weekly_trend", "trend", "weeks"]).map((row, index) => ({
    label: String(firstValue(row, ["label", "week"]) ?? `Week ${index + 1}`),
    range: String(firstValue(row, ["range", "date_range"]) ?? ""),
    views: numericValue(row, ["views", "guide_views", "page_views", "current", "count"]),
    previous_views: numericValue(row, ["previous_views", "prior_views", "previous", "last_month"])
  }));
}

function normalizeUpdates(guides, rawUpdates) {
  const updates = arrayFrom(rawUpdates, ["updates", "recent_updates"]);
  const rows = updates.length ? updates : guides;
  return rows
    .map((row) => ({
      title: String(firstValue(row, ["title", "name", "guide_title"]) ?? row.title ?? "Untitled guide"),
      url: String(firstValue(row, ["url", "friendly_url", "public_url", "link"]) ?? row.url ?? "#"),
      updated: String(firstValue(row, ["updated", "updated_at", "last_updated", "modified", "modified_at"]) ?? row.updated ?? "")
    }))
    .filter((row) => row.updated)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 8);
}

function unwrapLibInsight(raw) {
  // LibInsight wraps every response in {type, message, payload}
  if (raw && typeof raw === "object" && raw.type === "success" && "payload" in raw) {
    return raw.payload;
  }
  return raw;
}

function normalize(raw, reportMonth) {
  // Unwrap LibInsight envelope at the top level and in nested guide/asset responses
  raw = unwrapLibInsight(raw);
  if (raw && typeof raw === "object") {
    if (raw.guides)  raw = { ...raw, guides:  unwrapLibInsight(raw.guides) };
    if (raw.assets)  raw = { ...raw, assets:  unwrapLibInsight(raw.assets) };
  }

  const guideRows = arrayFrom(
    raw.guides ?? raw.guideStats ?? raw.records ?? raw,
    ["guides", "guide_stats", "records", "stats", "results", "data"]
  );
  const assetRows = arrayFrom(raw.assets ?? raw.assetStats ?? {}, ["assets", "asset_stats", "stats", "results", "data"]);

  const topGuides = guideRows
    .map(normalizeGuide)
    .filter((guide) => guide.views > 0)
    .sort((a, b) => b.views - a.views)
    .map((guide, index) => ({ ...guide, rank: index + 1 }));

  const assetTotal = assetRows.reduce((sum, row) => sum + numericValue(row, ["clicks", "asset_clicks", "views", "hits", "count", "total"]), 0);
  const topAssets = assetRows
    .map(normalizeAsset)
    .filter((asset) => asset.clicks > 0)
    .sort((a, b) => b.clicks - a.clicks)
    .map((asset) => ({
      ...asset,
      percent_of_total: assetTotal ? Number(((asset.clicks / assetTotal) * 100).toFixed(1)) : 0
    }));

  const guideViews = topGuides.reduce((sum, guide) => sum + guide.views, 0);
  const guideViewsPrevious = topGuides.reduce((sum, guide) => sum + guide.views_previous_month, 0);
  const assetClicks = topAssets.reduce((sum, asset) => sum + asset.clicks, 0);

  return {
    generated_at: new Date().toISOString(),
    source: "libguides",
    reporting_month: reportMonth,
    summary: {
      guide_views: guideViews,
      guide_views_change_percent: percentChange(guideViews, guideViewsPrevious),
      unique_users: numericValue(raw.summary || raw, ["unique_users", "users", "visitors"]),
      unique_users_change_percent: numericValue(raw.summary || raw, ["unique_users_change_percent", "users_change_percent"]),
      asset_clicks: assetClicks,
      asset_clicks_change_percent: numericValue(raw.summary || raw, ["asset_clicks_change_percent", "clicks_change_percent"]),
      average_time_on_guide: String(firstValue(raw.summary || raw, ["average_time_on_guide", "avg_time_on_guide", "average_time"]) ?? "Not tracked"),
      average_time_change_percent: numericValue(raw.summary || raw, ["average_time_change_percent", "avg_time_change_percent"]),
      published_guides: numericValue(raw.summary || raw, ["published_guides", "guide_count", "guides_published"]) || topGuides.length,
      published_guides_change_percent: numericValue(raw.summary || raw, ["published_guides_change_percent", "guide_count_change_percent"])
    },
    top_guides: topGuides.slice(0, 25),
    top_assets: topAssets.slice(0, 25),
    category_views: buildCategories(topGuides, raw.categories ?? raw.categoryStats ?? raw),
    weekly_trend: normalizeWeeklyTrend(raw.weeklyTrend ?? raw.trend ?? raw),
    updates: normalizeUpdates(topGuides, raw.updates ?? raw.recentUpdates ?? raw),
    methodology: "Guide views are counted when a guide page is loaded. Asset clicks are counted when users follow links to reusable LibGuides assets or external resources.",
    privacy: "This dashboard reports aggregate, de-identified usage data only. No personal identifiers are collected or displayed."
  };
}

async function writeReport(report) {
  await fs.mkdir(path.dirname(DATA_OUT), { recursive: true });
  await fs.mkdir(path.dirname(SITE_DATA_OUT), { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(DATA_OUT, json, "utf8");
  await fs.writeFile(SITE_DATA_OUT, json, "utf8");
}

async function sampleReport() {
  return JSON.parse(await fs.readFile(SAMPLE_DATA, "utf8"));
}

function buildGaUrl(endpoint, baseUrl, from, to) {
  const url = new URL(endpoint, `${baseUrl}/`);
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  return url;
}

function extractGaRecord(trendsPayload) {
  const records = trendsPayload?.records;
  if (!Array.isArray(records) || !records.length) return null;
  const rec = records[records.length - 1] || {};
  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
  return {
    pageviews: n(rec.pageviews ?? rec.page_views),
    sessions: n(rec.sessions),
    visitors: n(rec.visitors ?? rec.users)
  };
}

async function main() {
  const reportMonth = monthWindow();
  const config = {
    baseUrl: trimSlash(env("LIBGUIDES_API_BASE_URL", "https://lgapi-us.libapps.com/1.2")),
    tokenUrl: env("LIBGUIDES_TOKEN_URL"),
    siteId: env("LIBGUIDES_SITE_ID"),
    clientId: env("LIBGUIDES_CLIENT_ID"),
    clientSecret: env("LIBGUIDES_CLIENT_SECRET"),
    apiKey: env("LIBGUIDES_API_KEY"),
    apiKeyParam: env("LIBGUIDES_API_KEY_PARAM", "key"),
    apiKeyHeader: env("LIBGUIDES_API_KEY_HEADER"),
    guideStatsEndpoint: env("LIBGUIDES_GUIDE_STATS_ENDPOINT"),
    assetStatsEndpoint: env("LIBGUIDES_ASSET_STATS_ENDPOINT"),
    guideMetadataEndpoint: env("LIBGUIDES_GUIDE_METADATA_ENDPOINT"),
    gaOverviewEndpoint: env("LIBINSIGHT_GA_OVERVIEW_ENDPOINT"),
    gaTrendsEndpoint: env("LIBINSIGHT_GA_TRENDS_ENDPOINT"),
    googleClientId: env("GOOGLE_OAUTH_CLIENT_ID"),
    googleClientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
    googleRefreshToken: env("GOOGLE_OAUTH_REFRESH_TOKEN"),
    ga4Properties: [
      env("GA4_PROPERTY_RESEARCH_GUIDES"),
      env("GA4_PROPERTY_LIBGUIDES"),
      env("GA4_PROPERTY_FCIL"),
    ].filter(Boolean),
    siteParam: env("LIBGUIDES_SITE_PARAM", "site_id"),
    startParam: env("LIBGUIDES_START_PARAM", "start"),
    endParam: env("LIBGUIDES_END_PARAM", "end"),
    monthParam: env("LIBGUIDES_MONTH_PARAM")
  };

  if (args.has("--sample") || parseBoolean(env("ALLOW_SAMPLE_DATA"))) {
    const report = await sampleReport();
    report.generated_at = new Date().toISOString();
    await writeReport(report);
    console.log("Wrote sample LibGuide stats data.");
    return;
  }

  if (env("LIBGUIDES_RAW_STATS_FILE")) {
    const raw = JSON.parse(await fs.readFile(path.resolve(ROOT, env("LIBGUIDES_RAW_STATS_FILE")), "utf8"));
    await writeReport(normalize(raw, reportMonth));
    console.log("Wrote LibGuide stats data from local raw export.");
    return;
  }

  const hasGuideEndpoints = config.guideStatsEndpoint || config.assetStatsEndpoint || config.guideMetadataEndpoint;
  const hasGaEndpoints = config.gaOverviewEndpoint || config.gaTrendsEndpoint;

  if (!hasGuideEndpoints && !hasGaEndpoints) {
    throw new Error(
      "No endpoints configured. Set LIBGUIDES_GUIDE_STATS_ENDPOINT or LIBINSIGHT_GA_TRENDS_ENDPOINT, or run with --sample."
    );
  }

  const headers = await authHeaders(config);
  const requests = {};

  // Guide inventory counts (published_guide_count, total_guide_count per day)
  if (config.guideStatsEndpoint) {
    requests.guides = unwrapLibInsight(await fetchJson(endpointUrl(config.guideStatsEndpoint, config, reportMonth), headers));
  }
  if (config.assetStatsEndpoint) {
    requests.assets = unwrapLibInsight(await fetchJson(endpointUrl(config.assetStatsEndpoint, config, reportMonth), headers));
  }
  if (config.guideMetadataEndpoint && !requests.guides) {
    requests.guides = unwrapLibInsight(await fetchJson(endpointUrl(config.guideMetadataEndpoint, config, reportMonth), headers));
  }

  // Google Analytics: fetch current month and previous month separately for accurate MoM comparison
  if (config.gaTrendsEndpoint) {
    const [rawCur, rawPrev] = await Promise.all([
      fetchJson(buildGaUrl(config.gaTrendsEndpoint, config.baseUrl, reportMonth.start, reportMonth.end), headers).then(unwrapLibInsight),
      fetchJson(buildGaUrl(config.gaTrendsEndpoint, config.baseUrl, reportMonth.previous_start, reportMonth.previous_end), headers).then(unwrapLibInsight)
    ]);
    const cur = extractGaRecord(rawCur);
    const prev = extractGaRecord(rawPrev);
    if (cur && (cur.pageviews > 0 || cur.sessions > 0)) {
      requests.ga = { ...cur, pageviews_previous: prev?.pageviews || 0, sessions_previous: prev?.sessions || 0, visitors_previous: prev?.visitors || 0 };
    }
  }

  // GA4 Data API — per-guide page breakdown for top guides table
  if (config.googleClientId && config.googleClientSecret && config.googleRefreshToken && config.ga4Properties.length) {
    const googleToken = await getGoogleAccessToken(config.googleClientId, config.googleClientSecret, config.googleRefreshToken);
    const allRows = [];
    for (const propId of config.ga4Properties) {
      const rows = await fetchGa4Pages(propId, googleToken, reportMonth.start, reportMonth.end, 50);
      if (rows) allRows.push(...rows);
    }
    if (allRows.length) {
      // Aggregate by cleaned title (in case same guide appears across properties)
      const byTitle = new Map();
      for (const row of allRows) {
        const rawTitle = row.dimensionValues[0].value;
        const path = row.dimensionValues[1].value;
        const views = Number(row.metricValues[0].value) || 0;
        const users = Number(row.metricValues[1].value) || 0;
        if (rawTitle === "(not set)" || views === 0) continue;
        const title = cleanTitle(rawTitle);
        const existing = byTitle.get(title);
        if (existing) { existing.views += views; existing.users += users; }
        else byTitle.set(title, { title, path, views, users, subject: inferSubject(rawTitle, path) });
      }
      requests.ga4Guides = [...byTitle.values()].sort((a, b) => b.views - a.views);
    }
  }

  const report = normalize(requests, reportMonth);

  // Merge GA data into summary if available
  if (requests.ga) {
    const ga = requests.ga;
    report.summary.guide_views = ga.pageviews;
    report.summary.guide_views_change_percent = percentChange(ga.pageviews, ga.pageviews_previous);
    report.summary.unique_users = ga.visitors;
    report.summary.unique_users_change_percent = percentChange(ga.visitors, ga.visitors_previous);
    report.source = "libinsight-ga";
  }

  // Inject GA4 per-guide data into report
  if (requests.ga4Guides && requests.ga4Guides.length) {
    report.top_guides = requests.ga4Guides.slice(0, 25).map((g, i) => ({
      guide_id: String(i + 1),
      title: g.title,
      url: g.path,
      views: g.views,
      views_previous_month: 0,
      change: 0,
      change_percent: 0,
      rank: i + 1,
      subject: g.subject,
      updated: ""
    }));
    // Rebuild category_views from actual guide subjects
    const subjectTotals = new Map();
    for (const g of requests.ga4Guides) {
      subjectTotals.set(g.subject, (subjectTotals.get(g.subject) || 0) + g.views);
    }
    report.category_views = [...subjectTotals.entries()]
      .map(([category, views]) => ({ category, views }))
      .sort((a, b) => b.views - a.views);
  }

  // Published guide count from LibGuides dataset (today's snapshot)
  if (requests.guides?.records) {
    const libId = Object.keys(requests.guides.records)[0];
    const days = requests.guides.records[libId] || {};
    const today = Object.keys(days).sort().pop();
    if (today) {
      const snap = days[today];
      report.summary.published_guides = snap.published_guide_count || 0;
      report.summary.total_guides = snap.total_guide_count || 0;
    }
  }

  await writeReport(report);
  console.log("Wrote LibGuide stats data.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
