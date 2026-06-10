import os
import json
import re
import base64
import urllib.request
import urllib.error
from flask import render_template, jsonify, request


def register_lib_guide_stats_routes(app, deps):
    require_auth = deps['require_auth']
    data_file = deps['LIB_GUIDE_STATS_DATA_FILE']
    data_dir = os.path.dirname(data_file)
    github_pat   = deps.get('GITHUB_PAT', '')
    github_owner = deps.get('GITHUB_REPO_OWNER', '')
    github_repo  = deps.get('GITHUB_REPO_NAME', '')

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
        path = os.path.join(data_dir, f'{month}.json') if month else data_file
        if not os.path.exists(path):
            return None, f'No data for {month}' if month else 'No data file found.'
        try:
            with open(path) as f:
                return json.load(f), None
        except Exception as e:
            return None, f'Failed to read: {e}'

    def _get_hidden():
        hp_file = os.path.join(data_dir, 'hidden-paths.json')
        if os.path.exists(hp_file):
            try:
                with open(hp_file) as f:
                    return json.load(f)
            except Exception:
                pass
        return {'libguides': [], 'hunters_query': [], 'digital_commons': []}

    def _save_hidden(hp):
        hp_file = os.path.join(data_dir, 'hidden-paths.json')
        with open(hp_file, 'w') as f:
            json.dump(hp, f, indent=2)

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

        if not section or not path:
            return jsonify({'error': 'section and path required'}), 400

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
        months = _available_months()
        if not months:
            return jsonify({'error': 'No archived data available yet.', 'months': []}), 404

        agg = {}
        for month in months:
            data, err = _load_data(month)
            if err or not data:
                continue

            if section == 'hunters_query':
                for item in data.get('hunters_query', {}).get('top_articles', []):
                    key = item['path']
                    if key not in agg:
                        agg[key] = {'title': item['title'], 'path': key, 'views': 0, 'users': 0}
                    agg[key]['views'] += item.get('views', 0)
                    agg[key]['users'] += item.get('users', 0)

            elif section == 'digital_commons':
                for item in data.get('digital_commons', {}).get('top_items', []):
                    key = item['path']
                    if key not in agg:
                        agg[key] = {'title': item['title'], 'path': key,
                                    'section': item.get('section', ''), 'views': 0, 'users': 0}
                    agg[key]['views'] += item.get('views', 0)
                    agg[key]['users'] += item.get('users', 0)

            elif section == 'fcil':
                for g in data.get('top_guides', []):
                    if g.get('subject') != 'FCIL':
                        continue
                    key = g.get('url') or g.get('title', '')
                    if key not in agg:
                        agg[key] = {'title': g['title'], 'path': key, 'views': 0, 'users': 0}
                    agg[key]['views'] += g.get('views', 0)

        items = sorted(agg.values(), key=lambda x: -x['views'])
        for i, it in enumerate(items):
            it['rank'] = i + 1

        hp = _get_hidden()
        hp_section = 'libguides' if section == 'fcil' else section

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
        cfg_file = os.path.join(data_dir, 'kiosk-config.json')
        if os.path.exists(cfg_file):
            try:
                with open(cfg_file) as f:
                    return json.load(f)
            except Exception:
                pass
        return DEFAULT_KIOSK_CONFIG

    def _save_kiosk_config(cfg):
        cfg_file = os.path.join(data_dir, 'kiosk-config.json')
        with open(cfg_file, 'w') as f:
            json.dump(cfg, f, indent=2)
            f.write('\n')

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
        cfg = {'sections': sections}
        _save_kiosk_config(cfg)
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
                with urllib.request.urlopen(req) as resp:
                    sha = json.loads(resp.read()).get('sha', '')
            except urllib.error.HTTPError as e:
                if e.code != 404:
                    return f'GitHub API error (get {repo_path}): {e.code}'

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
                with urllib.request.urlopen(req):
                    pass
            except urllib.error.HTTPError as e:
                body_txt = e.read().decode('utf-8', errors='replace')
                return f'GitHub API error (put {repo_path}): {e.code} — {body_txt[:200]}'
            return None

        # Push kiosk-config.json
        err = _push_file(
            'site/data/kiosk-config.json',
            os.path.join(data_dir, 'kiosk-config.json'),
            'Update kiosk config [auto]',
        )
        if err:
            return jsonify({'error': err}), 502

        # Push hidden-paths.json so visibility changes take effect on kiosk
        err = _push_file(
            'site/data/hidden-paths.json',
            os.path.join(data_dir, 'hidden-paths.json'),
            'Update hidden paths [auto]',
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
            with urllib.request.urlopen(req):
                pass
        except urllib.error.HTTPError as e:
            return jsonify({'error': f'GitHub API error (dispatch): {e.code}'}), 502

        return jsonify({'ok': True, 'message': 'Config and visibility pushed, workflow triggered.'})
