import os
import json
from flask import render_template, jsonify


def register_lib_guide_stats_routes(app, deps):
    require_auth = deps['require_auth']
    data_file = deps['LIB_GUIDE_STATS_DATA_FILE']

    @app.route('/lib-guide-stats')
    @require_auth
    def lib_guide_stats_app():
        return render_template('lib_guide_stats.html')

    @app.route('/api/lib-guide-stats/data')
    @require_auth
    def lib_guide_stats_data():
        if not os.path.exists(data_file):
            return jsonify({
                'error': 'No data file found.',
                'hint': (
                    'Run the GitHub Actions workflow or configure LIBGUIDES_* environment '
                    'variables and execute scripts/fetch-libguides-stats.js locally.'
                )
            }), 404
        try:
            with open(data_file, 'r') as f:
                data = json.load(f)
            return jsonify(data)
        except Exception as e:
            return jsonify({'error': f'Failed to read stats data: {e}'}), 500
