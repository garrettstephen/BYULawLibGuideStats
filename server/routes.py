import os
import json
import re
from flask import render_template, jsonify, request


def register_lib_guide_stats_routes(app, deps):
    require_auth = deps['require_auth']
    data_file = deps['LIB_GUIDE_STATS_DATA_FILE']
    data_dir = os.path.dirname(data_file)

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
