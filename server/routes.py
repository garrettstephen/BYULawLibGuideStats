import os
import json
import re
import base64
import urllib.request
import urllib.error
import threading
from flask import render_template, jsonify, request

SECTIONS = ('libguides', 'hunters_query', 'digital_commons')
GITHUB_TIMEOUT = 20


def guide_key(g):
    """Identity of a LibGuides row for hide/override/all-time purposes.

    Data fetched before 2026-10-30 stored every content page as a bare '/c.php' (GA4's
    pagePath drops the ?g=&p= query), so for those rows the title is the only thing
    that tells guides apart."""
    url = g.get('url') or ''
    if not url or url.split('?')[0] in ('/c.php', '/content.php') and '?' not in url:
        return g.get('title') or url
    return url


def register_lib_guide_stats_routes(app, deps):
    require_auth = deps['require_auth']
    data_file = deps['LIB_GUIDE_STATS_DATA_FILE']
    data_dir = os.path.dirname(data_file)
    github_pat   = deps.get('GITHUB_PAT', '')
    github_owner = deps.get('GITHUB_REPO_OWNER', '')
    github_repo  = deps.get('GITHUB_REPO_NAME', '')

    # Dashboard-edited config (hidden paths, kiosk config, item overrides, DC annual
    # stats) is written to state_dir, which is outside the git-tracked tree (*.json is
    # gitignored outside site/data/). Writing into site/data/ used to leave the clone
    # dirty, which made the hourly `git pull --ff-only` cron fail indefinitely.
    # Push-to-kiosk still publishes these files to site/data/ on GitHub for the public
    # site. Reads fall back to the repo copy until a file has been saved here once.
    state_dir = os.path.join(os.path.dirname(os.path.dirname(data_dir)), 'state')
    # One process, several request threads: serialize read-modify-write of state files.
    state_lock = threading.Lock()

    def _state_read_path(name):
        p = os.path.join(state_dir, name)
        return p if os.path.exists(p) else os.path.join(data_dir, name)

    def _read_state(name, default):
        p = _state_read_path(name)
        if os.path.exists(p):
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception:
                pass
        return default

    def _write_state(name, obj):
        os.makedirs(state_dir, exist_ok=True)
        p = os.path.join(state_dir, name)
        tmp = f'{p}.tmp.{os.getpid()}'
        with open(tmp, 'w') as f:
            json.dump(obj, f, indent=2)
            f.write('\n')
        os.replace(tmp, p)

    def _available_months():
        if not os.path.isdir(data_dir):
            return []
        months = []
        for fn in os.listdir(data_dir):
            m = re.match(r'^(\d{4}-\d{2})\.json$', fn)
            if m:
                months.append(m.group(1))
        return sorted(months)

    def _load_data(month=None):
        # month comes straight from the query string -- only ever allow YYYY-MM so it
        # can't be used to walk out of data_dir (e.g. month=../../../admin/config/users).
        if month and not re.fullmatch(r'\d{4}-\d{2}', month):
            return None, 'Invalid month (expected YYYY-MM).'
        path = os.path.join(data_dir, f'{month}.json') if month else data_file
        if not os.path.exists(path):
            return None, f'No data for {month}' if month else 'No data file found.'
        try:
            with open(path) as f:
                return json.load(f), None
        except Exception as e:
            return None, f'Failed to read: {e}'

    def _get_hidden():
        return _read_state('hidden-paths.json',
                           {'libguides': [], 'hunters_query': [], 'digital_commons': []})

    def _save_hidden(hp):
        _write_state('hidden-paths.json', hp)

    # ── Page routes ──────────────────────────────────────────────────

    @app.route('/lib-guide-stats')
    @require_auth
    def lib_guide_stats_app():
        return render_template('lib_guide_stats.html')

    @app.route('/lib-guide-stats/hunters-query')
    @require_auth
    def lib_guide_stats_hq():
        return render_template('lib_guide_stats_alltime.html',
                               section='hunters_query',
                               page_title="Hunter's Query",
                               page_subtitle="Top Articles — All Time")

    @app.route('/lib-guide-stats/digital-commons')
    @require_auth
    def lib_guide_stats_dc():
        return render_template('lib_guide_stats_alltime.html',
                               section='digital_commons',
                               page_title="Digital Commons",
                               page_subtitle="Top Items — All Time")

    @app.route('/lib-guide-stats/fcil')
    @require_auth
    def lib_guide_stats_fcil():
        return render_template('lib_guide_stats_alltime.html',
                               section='fcil',
                               page_title="FCIL LibGuides",
                               page_subtitle="All-Time Statistics")

    # ── API routes ───────────────────────────────────────────────────

    @app.route('/api/lib-guide-stats/data')
    @require_auth
    def lib_guide_stats_data():
        month = request.args.get('month')
        if month and not re.fullmatch(r'\d{4}-\d{2}', month):
            return jsonify({'error': 'Invalid month (expected YYYY-MM).'}), 400
        data, err = _load_data(month)
        if err:
            return jsonify({
                'error': err,
                'hint': 'Run the GitHub Actions workflow or execute scripts/fetch-libguides-stats.js locally.'
            }), 404
        data['hidden_paths'] = _get_hidden()
        data['available_months'] = _available_months()
        return jsonify(data)

    @app.route('/api/lib-guide-stats/months')
    @require_auth
    def lib_guide_stats_months():
        return jsonify({'months': _available_months()})

    @app.route('/api/lib-guide-stats/hidden', methods=['POST'])
    @require_auth
    def lib_guide_stats_toggle_hidden():
        body = request.get_json(force=True, silent=True) or {}
        section = body.get('section')
        path = body.get('path')
        hidden = body.get('hidden', True)

        if section not in SECTIONS or not isinstance(path, str) or not path:
            return jsonify({'error': 'valid section and path required'}), 400

        with state_lock:
            hp = _get_hidden()
            if section not in hp:
                hp[section] = []
            if hidden and path not in hp[section]:
                hp[section].append(path)
            elif not hidden:
                hp[section] = [p for p in hp[section] if p != path]
            _save_hidden(hp)
        return jsonify({'ok': True, 'hidden_paths': hp})

    @app.route('/api/lib-guide-stats/all-time/<section>')
    @require_auth
    def lib_guide_stats_all_time(section):
        if section not in SECTIONS + ('fcil',):
            return jsonify({'error': f'Unknown section: {section}'}), 404
        months = _available_months()
        if not months:
            return jsonify({'error': 'No archived data available yet.', 'months': []}), 404

        # Months are walked oldest -> newest, so titles/subjects end up as the latest ones.
        agg = {}

        def add_guide(g, with_subject):
            key = guide_key(g)
            row = agg.setdefault(key, {'path': key, 'views': 0, 'users': 0})
            row['title'] = g.get('title') or row.get('title') or 'Untitled'
            if g.get('link'):
                row['link'] = g['link']
            if with_subject:
                row['subject'] = g.get('subject', '')
            row['views'] += g.get('views', 0) or 0

        def add_item(item, extra=()):
            key = item.get('path') or item.get('title', '')
            row = agg.setdefault(key, {'path': key, 'views': 0, 'users': 0})
            row['title'] = item.get('title') or row.get('title') or 'Untitled'
            for f in extra:
                row[f] = item.get(f, '')
            row['views'] += item.get('views', 0) or 0
            row['users'] += item.get('users', 0) or 0

        for month in months:
            data, err = _load_data(month)
            if err or not data:
                continue
            if section == 'libguides':
                for g in data.get('top_guides', []):
                    add_guide(g, True)
            elif section == 'fcil':
                # Newer data carries a dedicated FCIL list (FCIL guides rarely make the overall
                # top 25); older months only have whatever FCIL guides made the top 25.
                fcil = (data.get('fcil') or {}).get('top_guides')
                if fcil is None:
                    fcil = [g for g in data.get('top_guides', []) if g.get('subject') == 'FCIL']
                for g in fcil:
                    add_guide(g, False)
            elif section == 'hunters_query':
                for item in data.get('hunters_query', {}).get('top_articles', []):
                    add_item(item, ('author',))
            elif section == 'digital_commons':
                for item in data.get('digital_commons', {}).get('top_items', []):
                    add_item(item, ('section',))

        items = sorted(agg.values(), key=lambda x: -x['views'])
        for i, it in enumerate(items):
            it['rank'] = i + 1

        hp = _get_hidden()
        hp_section = 'libguides' if section in ('fcil', 'libguides') else section

        return jsonify({
            'section': section,
            'months': months,
            'total_months': len(months),
            'items': items,
            'hidden_paths': hp.get(hp_section, [])
        })

    # ── Kiosk config ─────────────────────────────────────────────────

    DEFAULT_KIOSK_CONFIG = {
        'sections': {
            'libguides':      {'url': 'https://guides.law.byu.edu/research'},
            'hunters_query':  {'url': 'https://huntersquery.byu.edu/'},
            'digital_commons':{'url': 'https://digitalcommons.law.byu.edu/'},
        }
    }

    def _get_kiosk_config():
        return _read_state('kiosk-config.json', DEFAULT_KIOSK_CONFIG)

    def _save_kiosk_config(cfg):
        _write_state('kiosk-config.json', cfg)

    @app.route('/api/lib-guide-stats/kiosk-config', methods=['GET'])
    @require_auth
    def lib_guide_stats_get_kiosk_config():
        return jsonify(_get_kiosk_config())

    @app.route('/api/lib-guide-stats/kiosk-config', methods=['POST'])
    @require_auth
    def lib_guide_stats_save_kiosk_config():
        body = request.get_json(force=True, silent=True) or {}
        sections = body.get('sections')
        if not sections or not isinstance(sections, dict):
            return jsonify({'error': 'sections dict required'}), 400
        clean = {}
        for name in SECTIONS:
            url = ((sections.get(name) or {}).get('url') or '').strip()
            if url and not re.match(r'^https?://\S+$', url):
                return jsonify({'error': f'{name} URL must start with http:// or https://'}), 400
            clean[name] = {'url': url}
        with state_lock:
            _save_kiosk_config({'sections': clean})
        return jsonify({'ok': True})

    # ── Item display overrides ───────────────────────────────────────────

    def _get_item_overrides():
        return _read_state('item-overrides.json',
                           {'digital_commons': {}, 'hunters_query': {}, 'libguides': {}})

    def _save_item_overrides(d):
        _write_state('item-overrides.json', d)

    @app.route('/api/lib-guide-stats/item-overrides', methods=['GET'])
    @require_auth
    def lib_guide_stats_get_item_overrides():
        return jsonify(_get_item_overrides())

    @app.route('/api/lib-guide-stats/item-overrides/item', methods=['POST'])
    @require_auth
    def lib_guide_stats_save_item_override():
        body = request.get_json(force=True, silent=True) or {}
        section = body.get('section')
        key = body.get('key')
        if section not in SECTIONS or not isinstance(key, str) or not key:
            return jsonify({'error': 'valid section and key required'}), 400
        title = str(body.get('title') or '').strip()
        author = str(body.get('author') or '').strip()
        with state_lock:
            ov = _get_item_overrides()
            if section not in ov:
                ov[section] = {}
            if title or author:
                ov[section][key] = {}
                if title:  ov[section][key]['title'] = title
                if author: ov[section][key]['author'] = author
            else:
                ov[section].pop(key, None)
            _save_item_overrides(ov)
        return jsonify({'ok': True, 'override': ov[section].get(key, {})})

    # ── DC annual statistics ─────────────────────────────────────────────

    def _get_dc_annual_stats():
        return _read_state('dc-annual-stats.json', {'datasets': []})

    def _save_dc_annual_stats(d):
        _write_state('dc-annual-stats.json', d)

    @app.route('/api/lib-guide-stats/dc-annual-stats', methods=['GET'])
    @require_auth
    def lib_guide_stats_get_dc_annual():
        return jsonify(_get_dc_annual_stats())

    @app.route('/api/lib-guide-stats/dc-annual-stats', methods=['POST'])
    @require_auth
    def lib_guide_stats_save_dc_annual():
        body = request.get_json(force=True, silent=True) or {}
        datasets = body.get('datasets')
        if not isinstance(datasets, list) or not all(
                isinstance(ds, dict) and isinstance(ds.get('years', []), list) for ds in datasets):
            return jsonify({'error': 'datasets array required'}), 400
        with state_lock:
            _save_dc_annual_stats({'datasets': datasets})
        return jsonify({'ok': True})

    # ── Push to public kiosk ─────────────────────────────────────────

    @app.route('/api/lib-guide-stats/push-to-kiosk', methods=['POST'])
    @require_auth
    def lib_guide_stats_push_to_kiosk():
        if not github_pat or not github_owner or not github_repo:
            return jsonify({
                'error': 'GitHub not configured. Add GITHUB_PAT, GITHUB_REPO_OWNER, '
                         'and GITHUB_REPO_NAME to your .env file.'
            }), 503

        api_base = f'https://api.github.com/repos/{github_owner}/{github_repo}'
        gh_headers = {
            'Authorization': f'Bearer {github_pat}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'BYULawLibrary-Admin',
        }

        def _push_file(repo_path, local_path, commit_message):
            """Commit a single local file to GitHub. Returns error string or None."""
            try:
                with open(local_path) as f:
                    content = f.read()
            except FileNotFoundError:
                return f'{os.path.basename(local_path)} not found locally.'

            # Get current SHA if file exists
            sha = ''
            try:
                req = urllib.request.Request(
                    f'{api_base}/contents/{repo_path}', headers=gh_headers)
                with urllib.request.urlopen(req, timeout=GITHUB_TIMEOUT) as resp:
                    sha = json.loads(resp.read()).get('sha', '')
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    return f'GitHub API error (get {repo_path}): {e.code}'
            except (urllib.error.URLError, TimeoutError) as e:
                return f'Could not reach GitHub: {e}'

            put_body = {
                'message': commit_message,
                'content': base64.b64encode(content.encode()).decode(),
                'branch': 'main',
            }
            if sha:
                put_body['sha'] = sha
            try:
                req = urllib.request.Request(
                    f'{api_base}/contents/{repo_path}',
                    data=json.dumps(put_body).encode(),
                    headers=gh_headers,
                    method='PUT',
                )
                with urllib.request.urlopen(req, timeout=GITHUB_TIMEOUT):
                    pass
            except urllib.error.HTTPError as e:
                body_txt = e.read().decode('utf-8', errors='replace')
                return f'GitHub API error (put {repo_path}): {e.code} — {body_txt[:200]}'
            except (urllib.error.URLError, TimeoutError) as e:
                return f'Could not reach GitHub: {e}'
            return None

        # Push kiosk-config.json
        err = _push_file(
            'site/data/kiosk-config.json',
            _state_read_path('kiosk-config.json'),
            'Update kiosk config [auto]',
        )
        if err:
            return jsonify({'error': err}), 502

        # Push hidden-paths.json so visibility changes take effect on kiosk
        err = _push_file(
            'site/data/hidden-paths.json',
            _state_read_path('hidden-paths.json'),
            'Update hidden paths [auto]',
        )
        if err:
            return jsonify({'error': err}), 502

        # Push item-overrides.json so title/author edits appear on kiosk
        if not os.path.exists(_state_read_path('item-overrides.json')):
            _save_item_overrides({'digital_commons': {}, 'hunters_query': {}, 'libguides': {}})
        err = _push_file(
            'site/data/item-overrides.json',
            _state_read_path('item-overrides.json'),
            'Update item overrides [auto]',
        )
        if err:
            return jsonify({'error': err}), 502

        # Trigger workflow_dispatch
        try:
            req = urllib.request.Request(
                f'{api_base}/actions/workflows/publish.yml/dispatches',
                data=json.dumps({'ref': 'main'}).encode(),
                headers=gh_headers,
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=GITHUB_TIMEOUT):
                pass
        except urllib.error.HTTPError as e:
            return jsonify({'error': f'GitHub API error (dispatch): {e.code}'}), 502
        except (urllib.error.URLError, TimeoutError) as e:
            return jsonify({'error': f'Could not reach GitHub: {e}'}), 502

        return jsonify({'ok': True, 'message': 'Config and visibility pushed, workflow triggered.'})
