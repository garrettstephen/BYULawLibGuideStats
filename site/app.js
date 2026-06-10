/* BYU Law Library Resource Stats — Digital Kiosk
   Single-page 3-column display
   Data: ./data/monthly-stats.json + ./data/kiosk-config.json */

const DATA_URL   = './data/monthly-stats.json';
const CONFIG_URL = './data/kiosk-config.json';

const numFmt = new Intl.NumberFormat('en-US');
function fmtN(v) { const n = Number(v); return numFmt.format(isFinite(n) ? n : 0); }

function qrSrc(url) {
  return 'https://api.qrserver.com/v1/create-qr-code/'
    + '?size=88x88&color=ffffff&bgcolor=001428'
    + '&data=' + encodeURIComponent(url);
}

function renderQr(containerId, url) {
  const el = document.getElementById(containerId);
  if (!el || !url) return;
  el.innerHTML = `
    <img src="${qrSrc(url)}" alt="Scan to visit" class="qr-img" width="88" height="88" loading="lazy">
    <span class="qr-label">Scan to visit</span>`;
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
    const sub   = item.subject || item.section || '';
    const views = item.views || 0;
    return `
      <div class="item-row">
        <span class="item-rank">${rank}</span>
        <div class="item-info">
          <div class="item-title">${title}</div>
          ${sub ? `<div class="item-sub">${sub}</div>` : ''}
        </div>
        <div class="item-views">
          <span class="item-views-num">${fmtN(views)}</span>
          <span class="item-views-label">views</span>
        </div>
      </div>`;
  }).join('');
}

async function boot() {
  let data, config;

  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    document.getElementById('grid').innerHTML =
      `<div class="error-row">Could not load stats: ${err.message}</div>`;
    return;
  }

  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-store' });
    config = res.ok ? await res.json() : {};
  } catch (_) {
    config = {};
  }

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

  // Apply hidden-paths filter
  const hiddenLibguides = new Set(data.hidden_paths?.libguides || []);
  const hiddenHQ        = new Set(data.hidden_paths?.hunters_query || []);
  const hiddenDC        = new Set(data.hidden_paths?.digital_commons || []);

  let guides = (data.top_guides || []).filter(g => !hiddenLibguides.has(g.url || ''));
  guides.forEach((g, i) => { g.rank = i + 1; });

  let hqArticles = (data.hunters_query?.top_articles || []).filter(a => !hiddenHQ.has(a.path || ''));
  hqArticles.forEach((a, i) => { a.rank = i + 1; });

  let dcItems = (data.digital_commons?.top_items || []).filter(it => !hiddenDC.has(it.path || ''));
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
