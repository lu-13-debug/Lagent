"""Fixed named operations. Input is trusted-schema JSON, never executable code or paths."""
import sys
import os
import json
import math
import io
import re
import warnings

# Linux containers get kernel CPU/address-space/file limits in addition to the Node timeout.
try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (25, 25))
    resource.setrlimit(resource.RLIMIT_AS, (2 * 1024**3, 2 * 1024**3))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024**2, 8 * 1024**2))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
except ImportError:
    pass

def audit(event, args):
    if event.startswith(('socket.', 'subprocess.', 'os.system', 'os.exec', 'os.spawn')):
        raise PermissionError('Tool network and subprocess access is disabled')

# Install before loading libraries. Matplotlib font discovery uses no external commands here.
sys.addaudithook(audit)
warnings.filterwarnings('ignore')

try:
    import numpy as np
    import pandas as pd
except ImportError:
    print(json.dumps({'ok': False, 'error': 'Python 工具依赖缺失，请安装 server/tools/requirements.txt'}))
    sys.exit(0)

def finite(value):
    if value is None:
        return None
    return float(value) if np.isfinite(value) else None

def frame(payload, table=None):
    records = payload['records']
    name = table or ('payments' if 'payments' in records else next(iter(records), None))
    if name not in records:
        raise ValueError('请求的数据表不存在')
    return name, pd.DataFrame(records[name])

def selected_numeric(df, requested=None):
    columns = requested or list(df.select_dtypes(include='number').columns)
    if not columns or any(c not in df.columns for c in columns):
        raise ValueError('请求的数值字段不存在或没有可用数值')
    return df[columns].apply(pd.to_numeric, errors='coerce')

def describe(df):
    result = {}
    for name in df.columns:
        values = df[name].dropna()
        result[name] = {'count': int(values.count()), 'missing': int(df[name].isna().sum()),
                        'mean': finite(values.mean()), 'std': finite(values.std(ddof=1)),
                        'min': finite(values.min()), 'q25': finite(values.quantile(.25)),
                        'median': finite(values.median()), 'q75': finite(values.quantile(.75)),
                        'max': finite(values.max())}
    return {'columns': result}

def chart(payload, args):
    kind = args['kind']
    source = args.get('source', 'retention' if kind == 'heatmap' else 'daily')
    if args.get('table'):
        source, df = frame(payload, args['table'])
    else:
        df = pd.DataFrame(payload['report'].get(source, []))
    if df.empty:
        raise ValueError('缺少图表所需数据，无法生成')
    x = args.get('x', 'name' if source == 'channels' else 'label' if source == 'weekday' else 'date')
    y = args.get('y', 'users' if source == 'channels' else 'd1' if kind == 'heatmap' else 'dau')
    if y not in df or (kind != 'histogram' and x not in df):
        raise ValueError('缺少图表所需字段，无法生成')
    if args.get('table') and kind in ['line', 'bar'] and x in ['registered_at', 'event_time', 'paid_at', 'created_at', 'start_at', 'end_at', 'check_in', 'check_out', 'close_at', 'started_at', 'completed_at', 'renewal_at']:
        parsed = pd.to_datetime(df[x], utc=True, errors='coerce')
        if parsed.isna().any():
            raise ValueError('日期图表包含缺失或无效时间，请先核对数据')
        df[x] = (parsed + pd.to_timedelta(payload['timezoneOffsetMinutes'], unit='m')).dt.strftime('%Y-%m-%d')
    title = args.get('title', {'line': '趋势分析', 'bar': '分组比较', 'histogram': '数值分布', 'scatter': '数值关系', 'heatmap': '留存热力图'}[kind])
    unit = args.get('unit', '')
    # Import only for chart operations, use a headless backend, never pyplot interactive state.
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib.figure import Figure
    from matplotlib import font_manager
    available = {f.name for f in font_manager.fontManager.ttflist}
    font = next((f for f in ['Microsoft YaHei', 'Noto Sans CJK SC', 'Noto Sans CJK JP', 'SimHei', 'DejaVu Sans'] if f in available), 'DejaVu Sans')
    matplotlib.rcParams.update({'font.family': font, 'svg.fonttype': 'none', 'axes.unicode_minus': False})
    fig = Figure(figsize=(9, 4.4), dpi=120, layout='constrained')
    ax = fig.subplots()
    caption = '数据来自已核验报告聚合表。' if not args.get('table') else '数据来自服务器固定字段聚合，不含原始标识。'
    if kind == 'histogram':
        values = pd.to_numeric(df[y], errors='coerce').dropna()
        if values.empty:
            raise ValueError('分布图没有有效数值')
        counts, edges = np.histogram(values, bins=args.get('bins', min(12, max(2, int(math.sqrt(len(values)))))))
        data = [{'lower': float(edges[i]), 'upper': float(edges[i+1]), 'count': int(count)} for i, count in enumerate(counts)]
        ax.bar(edges[:-1], counts, width=np.diff(edges), align='edge', color='#2b7a78', edgecolor='white')
        ax.set_xlabel(f'{y} ({unit})' if unit else y)
        ax.set_ylabel('频数')
    elif kind == 'heatmap':
        columns = [c for c in ['d1', 'd7'] if c in df]
        if not columns:
            raise ValueError('缺少留存字段，无法生成热力图')
        if len(df) > 40:
            raise ValueError('留存热力图最多展示 40 个 cohort，请缩小来源范围')
        matrix = df[columns].apply(pd.to_numeric, errors='coerce')
        data = [{x: str(df.iloc[i][x]), **{c: finite(matrix.iloc[i][c]) for c in columns}} for i in range(len(df))]
        if matrix.isna().all().all():
            raise ValueError('留存窗口尚未成熟，没有可绘制数值')
        fig.set_size_inches(9, min(12, max(4.4, len(df) * .25)))
        image = ax.pcolormesh(np.ma.masked_invalid(matrix.to_numpy()), vmin=0, vmax=100, cmap='YlGnBu', edgecolors='white', linewidth=.8)
        ax.invert_yaxis()
        ax.set_xticks(np.arange(len(columns)) + .5, columns)
        ax.set_yticks(np.arange(len(df)) + .5, [str(v) for v in df[x]])
        ax.set_aspect('auto')
        colorbar = fig.colorbar(image, ax=ax, label='留存率 (%)')
        if colorbar.solids is not None:
            colorbar.solids.set_rasterized(False)
    elif kind == 'scatter':
        pairs = df[[x, y]].apply(pd.to_numeric, errors='coerce').dropna()
        if pairs.empty:
            raise ValueError('散点图需要两个数值字段')
        # Raw records are reduced to bins before any result leaves the process.
        if args.get('table') and pairs[x].nunique() > 1:
            pairs = pairs.assign(_bin=pd.cut(pairs[x], bins=min(40, max(2, pairs[x].nunique())), duplicates='drop')).groupby('_bin', observed=True).agg(**{x: (x, 'mean'), y: (y, 'mean'), 'count': (y, 'size')}).reset_index(drop=True)
            caption += '散点按横轴区间展示均值。'
        else:
            pairs = pairs.groupby([x, y], dropna=False).size().reset_index(name='count')
        data = json.loads(pairs.to_json(orient='records'))
        ax.scatter(pairs[x], pairs[y], color='#2b7a78', alpha=.8)
        ax.set_xlabel(x)
        ax.set_ylabel(f'{y} ({unit})' if unit else y)
    else:
        values = df[[x, y]].copy()
        values[y] = pd.to_numeric(values[y], errors='coerce')
        if values[y].isna().all():
            raise ValueError('图表没有有效数值，无法生成')
        # min_count preserves unavailable observations instead of inventing zero.
        values = values.groupby(x, dropna=False, sort=kind == 'line')[y].sum(min_count=1).reset_index()
        if len(values) > 200:
            raise ValueError('图表最多展示 200 个聚合点，请缩小来源范围')
        data = json.loads(values.to_json(orient='records'))
        labels = [str(v) for v in values[x]]
        positions = np.arange(len(values))
        if kind == 'line':
            ax.plot(positions, values[y], color='#2b7a78', linewidth=2, marker='o' if len(values) <= 30 else None)
        else:
            ax.bar(positions, values[y], color='#2b7a78')
        tick_positions = list(range(0, len(values), max(1, math.ceil(len(values)/12))))
        ax.set_xticks(tick_positions, [labels[i] for i in tick_positions], rotation=25, ha='right')
        ax.set_xlabel(x)
        ax.set_ylabel(f'{y} ({unit})' if unit else y)
    ax.set_title(title, pad=14, fontsize=14)
    ax.spines[['top', 'right']].set_visible(False)
    if kind != 'heatmap':
        ax.grid(axis='y', alpha=.18)
    stream = io.StringIO()
    fig.savefig(stream, format='svg', metadata={'Date': None, 'Creator': 'DataAgent named chart tool'})
    svg = stream.getvalue()
    svg = svg[svg.index('<svg'):]
    svg = re.sub(r'<metadata>.*?</metadata>', '', svg, flags=re.DOTALL)
    svg = re.sub(r'<!--.*?-->', '', svg, flags=re.DOTALL)
    return {'kind': kind, 'title': title, 'source': source, 'x': x, 'y': y, 'unit': unit, 'mimeType': 'image/svg+xml', 'svg': svg, 'data': data, 'caption': caption}

def run(payload):
    args = payload['input']
    name = payload['name']
    if name == 'profile':
        tables = {}
        for table, rows in payload['records'].items():
            df = pd.DataFrame(rows)
            tables[table] = {'rows': len(rows), 'fields': [{'name': c, 'type': 'number' if pd.api.types.is_numeric_dtype(df[c]) else 'dimension', 'missing': int(df[c].isna().sum()), 'distinct': int(df[c].nunique())} for c in df.columns]}
        return {'tables': tables, 'privacy': '仅已注册字段的结构及聚合统计，不含原始标识或值样本'}
    if name == 'clean':
        operations = args.get('operations', ['trim_strings', 'normalize_newlines'])
        changed = 0
        rows = 0
        for table in payload['records'].values():
            rows += len(table)
            for row in table:
                for key, old in row.items():
                    if not isinstance(old, str):
                        continue
                    value = old
                    if 'normalize_newlines' in operations:
                        value = value.replace('\r\n', '\n').replace('\r', '\n')
                    if 'trim_strings' in operations:
                        value = value.strip()
                    if value != old:
                        changed += 1
                    row[key] = value
        return {'operations': operations, 'changedCells': changed, 'rowsBefore': rows, 'rowsAfter': rows, 'mode': 'non_destructive_preview', 'requiresConfirmation': False, 'summary': '标准化预览；不删行、不填补、不覆盖原始数据。'}
    if name == 'chart':
        return chart(payload, args)
    table, df = frame(payload, args.get('table'))
    if name == 'describe':
        return {'table': table, **describe(selected_numeric(df, args.get('columns')))}
    if name == 'group':
        by, metrics = args['by'], args['metrics']
        if any(c not in df for c in by + [m['column'] for m in metrics]):
            raise ValueError('请求的分组或数值字段不存在')
        groups = df.groupby(by, dropna=False, sort=True)
        if groups.ngroups > 100:
            raise ValueError('分组基数超过 100，拒绝输出过细明细')
        aggregation = {m['column'] + '_' + m['op']: (m['column'], m['op']) for m in metrics}
        result = groups.agg(**aggregation).reset_index()
        # pandas sum(null) is zero by default; restore unknown sums.
        for m in metrics:
            if m['op'] == 'sum':
                result[m['column'] + '_sum'] = groups[m['column']].sum(min_count=1).to_numpy()
        return {'table': table, 'data': json.loads(result.head(args.get('limit', 100)).to_json(orient='records')), 'totalGroups': int(groups.ngroups), 'truncated': len(result) > args.get('limit', 100)}
    if name == 'statistics':
        from scipy import stats
        values = selected_numeric(df, args['columns'])
        method = args['method']
        if method == 'describe':
            return {'table': table, 'method': method, **describe(values)}
        if method == 'ttest':
            a, b = [values[c].dropna() for c in values]
            if min(len(a), len(b)) < 2:
                raise ValueError('Welch 双样本检验每组至少需要 2 个有效值')
            result = stats.ttest_ind(a, b, equal_var=False)
            n = [len(a), len(b)]
        else:
            values = values.dropna()
            if len(values) < 3 or any(values[c].nunique() < 2 for c in values):
                raise ValueError('相关分析至少需要 3 对非恒定有效数值')
            result = (stats.pearsonr if method == 'pearson' else stats.spearmanr)(values.iloc[:, 0], values.iloc[:, 1])
            n = len(values)
        return {'table': table, 'method': method, 'n': n, 'statistic': finite(result.statistic), 'pValue': finite(result.pvalue), 'note': '仅提供观察性统计；独立性及分布假设需要业务核验，不能据此推断因果。'}
    raise ValueError('不允许的分析工具')

try:
    payload = json.loads(sys.stdin.buffer.read(24 * 1024**2 + 1).decode('utf-8'))
    result = run(payload)
    output = json.dumps({'ok': True, 'result': result}, ensure_ascii=False, allow_nan=False)
    if len(output.encode('utf-8')) > 2 * 1024**2:
        raise ValueError('分析工具输出超过 2MB 上限')
    sys.stdout.buffer.write(output.encode('utf-8'))
except ImportError:
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': 'Python 工具依赖缺失，请安装 server/tools/requirements.txt'}, ensure_ascii=False).encode('utf-8'))
except (ValueError, KeyError, TypeError) as error:
    # Known validation messages contain field names only, never raw rows or traceback.
    sys.stdout.buffer.write(json.dumps({'ok': False, 'error': str(error)[:250]}, ensure_ascii=False).encode('utf-8'))
