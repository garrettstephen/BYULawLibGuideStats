/* BYU Law Library LibGuide Stats — Digital Display
   Auto-cycling panel kiosk view
   Data source: ./data/monthly-stats.json  */

const DATA_URL   = './data/monthly-stats.json';
const PANEL_DURATION = 12000; // ms each panel is shown

const numFmt  = new Intl.NumberFormat('en-US');
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function num(v)       { const n = Number(v); return isFinite(n) ? n : 0; }
function fmtN(v)      { return numFmt.format(num(v)); }
function fmtDate(v)   {
  if (!v) return '';
  const d = new Date(`${v}T00:00:00`);
  return isNaN(d) ? String(v) : dateFmt.format(d);
}

function chgHtml(pct) {
  const p = num(pct);
  if (p === 0) return '<span class="flat">&#8212;</span>';
  const cls   = p > 0 ? 'up' : 'down';
  const arrow = p > 0 ? '▲' : '▼';
  return `<span class="${cls}">${arrow} ${Math.abs(p).toFixed(1)}%</span>`;
}

// ── Panel builders ──────────────────────────────────────────────

function buildKpiPanel(data) {
  const s    = data.summary || {};
  const prev = data.reporting_month?.previous_label || 'prior month';

  const cards = [
    { label: 'Guide Views',  value: fmtN(s.guide_views),  pct: s.guide_views_change_percent },
    { label: 'Unique Users', value: fmtN(s.unique_users), pct: s.unique_users_change_percent },
  ].map(c => `
    <div class="kpi-card">
      <span class="kpi-label">${c.label}</span>
      <strong class="kpi-value">${c.value}</strong>
      <span class="kpi-change">vs ${prev} ${chgHtml(c.pct)}</span>
    </div>`).join('');

  return `
    <p class="panel-title">Monthly Highlights</p>
    <div class="kpi-grid">${cards}</div>`;
}

function buildGuidesPanel(data) {
  const guides = (data.top_guides || []).slice(0, 7);
  if (!guides.length) return null;

  const rows = guides.map(g => {
    const pct = num(g.change_percent);
    const cls = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
    const chg = pct === 0 ? '—' : `${arrow} ${Math.abs(pct).toFixed(1)}%`;
    return `
      <div class="guide-row">
        <span class="guide-rank">${g.rank || ''}</span>
        <div class="guide-info">
          <div class="guide-title">${g.title || 'Untitled'}</div>
          <div class="guide-subject">${g.subject || ''}</div>
        </div>
        <div class="guide-stats">
          <div class="guide-views">${fmtN(g.views)}</div>
          <span class="guide-chg ${cls}">${chg}</span>
        </div>
      </div>`;
  }).join('');

  return `
    <p class="panel-title">Top Guides This Month</p>
    <div class="guide-list">${rows}</div>`;
}

function buildSubjectsPanel(data) {
  const cats = (data.category_views || []).slice(0, 8);
  if (!cats.length) return null;

  const maxV = Math.max(...cats.map(c => num(c.views)), 1);

  const cards = cats.map(c => {
    const w = Math.max(6, Math.round(num(c.views) / maxV * 100));
    return `
      <div class="subject-card">
        <div class="subject-name">${c.category || 'Uncategorized'}</div>
        <div class="subject-track">
          <div class="subject-fill" style="width:${w}%"></div>
        </div>
        <div class="subject-count">${fmtN(c.views)} views</div>
      </div>`;
  }).join('');

  return `
    <p class="panel-title">Views by Subject</p>
    <div class="subject-grid">${cards}</div>`;
}

function buildHighlightsPanel(data) {
  const s      = data.summary || {};
  const guides = data.top_guides || [];
  const top    = guides[0] || {};

  const published = num(s.published_guides);
  const avgTime   = s.average_time_on_guide || 'Not tracked';

  const noteText = data.methodology
    ? data.methodology
    : 'Guide views counted when a guide page is loaded. Asset clicks counted when users follow links to LibGuides assets.';

  return `
    <p class="panel-title">By the Numbers</p>
    <div class="highlights-layout">
      <div class="highlights-left">
        <div class="highlight-stat">
          <div class="highlight-number">${published > 0 ? fmtN(published) : '—'}</div>
          <div class="highlight-desc">Published Guides</div>
        </div>
        <div class="highlight-stat">
          <div class="highlight-number">${avgTime}</div>
          <div class="highlight-desc">Avg. Time on Guide</div>
        </div>
      </div>
      <div class="highlights-right">
        ${top.title ? `
        <div class="top-guide-showcase">
          <div class="showcase-label">&#9733; Most Viewed Guide</div>
          <div class="showcase-title">${top.title}</div>
          <div class="showcase-views">${fmtN(top.views)}</div>
          <div class="showcase-views-label">guide views this month</div>
        </div>` : ''}
        <div class="note-box">${noteText}</div>
      </div>
    </div>`;
}

// ── Panel cycling logic ──────────────────────────────────────────

let panels     = [];
let current    = 0;
let timer      = null;
let progTimer  = null;

function showPanel(index) {
  const stage = document.getElementById('panel-stage');
  const dots  = document.getElementById('panel-dots');

  // Mark old active as exit
  stage.querySelectorAll('.panel.active').forEach(el => {
    el.classList.remove('active');
    el.classList.add('exit');
    setTimeout(() => el.remove(), 700);
  });

  // Build new panel
  const el = document.createElement('div');
  el.className = 'panel';
  el.setAttribute('aria-label', panels[index].label);
  el.innerHTML = panels[index].html;
  stage.appendChild(el);

  // Trigger transition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('active'));
  });

  // Update dots
  dots.querySelectorAll('.panel-dot').forEach((dot, i) => {
    dot.classList.toggle('active', i === index);
  });

  // Footer label
  const footerLabel = document.getElementById('footer-panel-label');
  if (footerLabel) footerLabel.textContent = `${index + 1} / ${panels.length}`;

  // Progress bar
  clearInterval(progTimer);
  const fill = document.getElementById('progress-fill');
  if (fill) {
    fill.style.transition = 'none';
    fill.style.width = '0%';
    // Force reflow
    void fill.offsetWidth;
    fill.style.transition = `width ${PANEL_DURATION}ms linear`;
    fill.style.width = '100%';
  }

  current = index;
}

function advance() {
  showPanel((current + 1) % panels.length);
}

function startCycle() {
  clearInterval(timer);
  timer = setInterval(advance, PANEL_DURATION);
}

function showError(msg) {
  const stage = document.getElementById('panel-stage');
  stage.innerHTML = `
    <div class="display-error" role="alert">
      <h2>Unable to load stats</h2>
      <p>${msg}</p>
    </div>`;
}

// ── Boot ─────────────────────────────────────────────────────────

async function boot() {
  let data;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    showError(`Could not load <code>data/monthly-stats.json</code>. ${err.message}`);
    return;
  }

  // Header month
  const month = data.reporting_month?.label || 'Current Report';
  const hdrMonth = document.getElementById('hdr-month');
  if (hdrMonth) hdrMonth.textContent = month;

  // Apply hidden-path filter to data
  const hiddenLibguides = new Set((data.hidden_paths?.libguides || []));
  const hiddenHQ = new Set((data.hidden_paths?.hunters_query || []));
  const hiddenDC = new Set((data.hidden_paths?.digital_commons || []));
  if (hiddenLibguides.size) {
    data.top_guides = (data.top_guides || []).filter(g => !hiddenLibguides.has(g.url || g.title || ''));
    // re-rank
    data.top_guides.forEach((g, i) => { g.rank = i + 1; });
  }
  if (hiddenHQ.size && data.hunters_query) {
    data.hunters_query.top_articles = (data.hunters_query.top_articles || [])
      .filter(a => !hiddenHQ.has(a.path || ''));
    data.hunters_query.top_articles.forEach((a, i) => { a.rank = i + 1; });
  }
  if (hiddenDC.size && data.digital_commons) {
    data.digital_commons.top_items = (data.digital_commons.top_items || [])
      .filter(it => !hiddenDC.has(it.path || ''));
    data.digital_commons.top_items.forEach((it, i) => { it.rank = i + 1; });
  }

  // Build panel list (skip null builders)
  const builders = [
    { fn: buildKpiPanel,        label: 'Monthly Highlights' },
    { fn: buildGuidesPanel,     label: 'Top Guides'         },
    { fn: buildSubjectsPanel,   label: 'Subject Views'      },
    { fn: buildHighlightsPanel, label: 'By the Numbers'     },
  ];

  panels = builders.reduce((acc, b) => {
    const html = b.fn(data);
    if (html) acc.push({ html, label: b.label });
    return acc;
  }, []);

  if (!panels.length) {
    showError('No displayable data in monthly-stats.json.');
    return;
  }

  // Build dots
  const dotsEl = document.getElementById('panel-dots');
  if (dotsEl) {
    dotsEl.innerHTML = panels.map((_, i) =>
      `<span class="panel-dot${i === 0 ? ' active' : ''}" aria-hidden="true"></span>`
    ).join('');
  }

  // Show first panel and start cycling
  showPanel(0);
  startCycle();
}

boot();
