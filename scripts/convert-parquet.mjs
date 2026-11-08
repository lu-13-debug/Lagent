import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('用法：node scripts/convert-parquet.mjs input.parquet output.csv'); process.exit(1); }
if (!existsSync(input) || existsSync(output)) { console.error('输入文件不存在或输出文件已存在；请选择新的输出路径。'); process.exit(1); }
const probe = spawnSync('duckdb', ['--version'], { encoding: 'utf8', shell: false });
if (probe.error || probe.status !== 0) {
  console.error('未检测到 DuckDB CLI。可在已安装 pyarrow 的 Python 环境运行：');
  console.error('python -c "import sys,pyarrow.parquet as p,pyarrow.csv as c;c.write_csv(p.read_table(sys.argv[1]),sys.argv[2])" ' + JSON.stringify(path.resolve(input)) + ' ' + JSON.stringify(path.resolve(output)));
  process.exit(2);
}
const quote = value => "'" + path.resolve(value).replaceAll("'", "''") + "'";
const result = spawnSync('duckdb', ['-c', `COPY (SELECT * FROM read_parquet(${quote(input)})) TO ${quote(output)} (HEADER, DELIMITER ',');`], { stdio: 'inherit', shell: false });
process.exit(result.status ?? 1);
