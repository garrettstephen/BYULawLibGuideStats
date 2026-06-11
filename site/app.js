/* BYU Law Library Resource Stats — Digital Kiosk
   Single-page 3-column display
   Data: monthly-stats.json + hidden-paths.json + kiosk-config.json + item-overrides.json */

const DATA_URL      = './data/monthly-stats.json';
const HIDDEN_URL    = './data/hidden-paths.json';
const CONFIG_URL    = './data/kiosk-config.json';
const OVERRIDES_URL = './data/item-overrides.json';

// Parse Digital Commons titles: "Article Title" by Author Name → {title, author}
function parseDcTitle(raw) {
  const m = raw.match(/^"(.+?)"\s+by\s+(.+)$/);
  if (m) return { title: m[1].trim(), author: m[2].trim() };
  return { title: raw, author: '' };
}

function qrSrc(url) {
  return 'https://api.qrserver.com/v1/create-qr-code/'
    + '?size=130x130&color=ffffff&bgcolor=001428'
    + '&data=' + encodeURIComponent(url);
}

function renderQr(containerId, url) {
  const el = document.getElementById(containerId);
  if (!el || !url) return;
  const display = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  el.innerHTML = `
    <img src="${qrSrc(url)}" alt="Scan to visit" class="qr-img" width="130" height="130" loading="lazy">
    <div class="qr-text">
      <span class="qr-label">Scan to visit</span>
      <span class="qr-url">${display}</span>
    </div>`;
}

function renderList(containerId, items) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!items || !items.length) {
    el.innerHTML = '<div class="empty-row">No data available.</div>';
    return;
  }
  el.innerHTML = items.slice(0, 10).map((item, i) => {
    const rank  = item.rank || i + 1;
    const title = item.title || 'Untitled';
    const sub   = item.subject || item.author || item.section || '';
    return `
      <div class="item-row">
        <span class="item-rank">${rank}</span>
        <div class="item-info">
          <div class="item-title">${title}</div>
          ${sub ? `<div class="item-sub">${sub}</div>` : ''}
        </div>
      </div>`;
  }).join('');
}

async function boot() {
  // Fetch all data sources in parallel
  const [dataRes, hiddenRes, configRes, overridesRes] = await Promise.allSettled([
    fetch(DATA_URL,      { cache: 'no-store' }),
    fetch(HIDDEN_URL,    { cache: 'no-store' }),
    fetch(CONFIG_URL,    { cache: 'no-store' }),
    fetch(OVERRIDES_URL, { cache: 'no-store' }),
  ]);

  // Stats data is required
  if (dataRes.status === 'rejected' || !dataRes.value.ok) {
    const msg = dataRes.reason?.message || `HTTP ${dataRes.value?.status}`;
    document.getElementById('grid').innerHTML =
      `<div class="error-row">Could not load stats: ${msg}</div>`;
    return;
  }
  const data      = await dataRes.value.json();
  const hidden    = (hiddenRes.status === 'fulfilled' && hiddenRes.value.ok)
    ? await hiddenRes.value.json() : {};
  const config    = (configRes.status === 'fulfilled' && configRes.value.ok)
    ? await configRes.value.json() : {};
  const overrides = (overridesRes.status === 'fulfilled' && overridesRes.value.ok)
    ? await overridesRes.value.json() : {};

  // Header month
  const hdrMonth = document.getElementById('hdr-month');
  if (hdrMonth) hdrMonth.textContent = data.reporting_month?.label || '';

  // Footer updated
  const ftrUpdated = document.getElementById('ftr-updated');
  if (ftrUpdated && data.generated_at) {
    const d = new Date(data.generated_at);
    if (!isNaN(d)) {
      ftrUpdated.textContent = 'Updated ' + d.toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    }
  }

  // Build per-section override maps
  const lgOv = overrides.libguides      || {};
  const hqOv = overrides.hunters_query  || {};
  const dcOv = overrides.digital_commons || {};

  // Hidden-paths filter
  const hiddenLibguides = new Set(hidden.libguides || []);
  const hiddenHQ        = new Set(hidden.hunters_query || []);
  const hiddenDC        = new Set(hidden.digital_commons || []);

  // LibGuides — apply overrides
  let guides = (data.top_guides || [])
    .filter(g => !hiddenLibguides.has(g.url || ''))
    .map(g => {
      const key = g.url || g.title || '';
      const ov = lgOv[key] || {};
      return { ...g, title: ov.title || g.title, author: ov.author || '' };
    });
  guides.forEach((g, i) => { g.rank = i + 1; });

  // Hunter's Query — apply overrides
  let hqArticles = (data.hunters_query?.top_articles || [])
    .filter(a => !hiddenHQ.has(a.path || ''))
    .map(a => {
      const key = a.path || '';
      const ov = hqOv[key] || {};
      return {
        ...a,
        title: ov.title || a.title,
        author: ov.author !== undefined ? ov.author : (a.author || ''),
      };
    });
  hqArticles.forEach((a, i) => { a.rank = i + 1; });

  // Digital Commons — parse title/author, then apply overrides
  let dcItems = (data.digital_commons?.top_items || [])
    .filter(it => !hiddenDC.has(it.path || ''))
    .map(it => {
      const { title: parsedTitle, author: parsedAuthor } = parseDcTitle(it.title);
      const key = it.path || '';
      const ov = dcOv[key] || {};
      return {
        ...it,
        title:  ov.title  || parsedTitle,
        author: ov.author !== undefined ? ov.author : parsedAuthor,
      };
    });
  dcItems.forEach((it, i) => { it.rank = i + 1; });

  // Render lists
  renderList('list-libguides', guides);
  renderList('list-hq', hqArticles);
  renderList('list-dc', dcItems);

  // Render QR codes from kiosk-config
  const sections = config.sections || {};
  renderQr('col-qr-libguides', sections.libguides?.url || '');
  renderQr('col-qr-hq',        sections.hunters_query?.url || '');
  renderQr('col-qr-dc',        sections.digital_commons?.url || '');
}

boot();
