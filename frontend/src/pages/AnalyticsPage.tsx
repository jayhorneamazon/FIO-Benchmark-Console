/**
 * Analytics dashboard with pre-built charts and a custom query builder.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { api, AnalyticsSummary, TrendData, CustomQueryRequest, CustomQueryResponse } from '../lib/api';

const COLORS = ['#4f8ff7', '#3fb950', '#d29922', '#e5534b', '#a371f7', '#58a6ff', '#f778ba', '#79c0ff'];

const METRIC_OPTIONS = [
  { value: 'iops', label: 'Total IOPS' },
  { value: 'bw', label: 'Bandwidth (KiB/s)' },
  { value: 'p50', label: 'p50 Latency (µs)' },
  { value: 'p90', label: 'p90 Latency (µs)' },
  { value: 'p95', label: 'p95 Latency (µs)' },
  { value: 'p99', label: 'p99 Latency (µs)' },
  { value: 'p999', label: 'p99.9 Latency (µs)' },
  { value: 'iopsPerNode', label: 'IOPS per Node' },
  { value: 'bwPerNode', label: 'BW per Node (KiB/s)' },
];

const GROUP_OPTIONS = [
  { value: 'none', label: 'No grouping' },
  { value: 'nfsVersion', label: 'NFS Version' },
  { value: 'blockSize', label: 'Block Size' },
  { value: 'workload', label: 'Workload Pattern' },
  { value: 'instanceType', label: 'Instance Type' },
  { value: 'nodeCount', label: 'Node Count' },
];

const XAXIS_OPTIONS = [
  { value: 'time', label: 'Time' },
  { value: 'nodeCount', label: 'Node Count' },
  { value: 'blockSize', label: 'Block Size' },
  { value: 'nfsVersion', label: 'NFS Version' },
];

function formatLatency(us: number): string {
  if (us < 1000) return `${us.toFixed(0)} µs`;
  if (us < 1000000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1000000).toFixed(2)} s`;
}

function formatBw(kib: number): string {
  if (kib < 1024) return `${kib.toFixed(0)} KiB/s`;
  if (kib < 1048576) return `${(kib / 1024).toFixed(1)} MiB/s`;
  return `${(kib / 1048576).toFixed(2)} GiB/s`;
}

export const AnalyticsPage: React.FC = () => {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [trendData, setTrendData] = useState<TrendData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pre-built chart controls
  const [trendMetric, setTrendMetric] = useState('iops');
  const [trendGroup, setTrendGroup] = useState('nfsVersion');
  const [trendDays, setTrendDays] = useState(90);

  // Custom query state
  const [customResult, setCustomResult] = useState<CustomQueryResponse | null>(null);
  const [customLoading, setCustomLoading] = useState(false);
  const [customMetrics, setCustomMetrics] = useState<string[]>(['iops', 'p99']);
  const [customXAxis, setCustomXAxis] = useState<CustomQueryRequest['xAxis']>('time');
  const [customNfsVersions, setCustomNfsVersions] = useState<string[]>([]);
  const [customWorkloads, setCustomWorkloads] = useState<string[]>([]);
  const [customBlockSizes, setCustomBlockSizes] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState('');

  // Load summary on mount
  useEffect(() => {
    api.getAnalyticsSummary()
      .then(setSummary)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // Load trend data when controls change
  const loadTrends = useCallback(() => {
    api.getAnalyticsTrends({ metric: trendMetric, groupBy: trendGroup, days: trendDays })
      .then(setTrendData)
      .catch(err => setError(err.message));
  }, [trendMetric, trendGroup, trendDays]);

  useEffect(() => { loadTrends(); }, [loadTrends]);

  const runCustomQuery = async () => {
    setCustomLoading(true);
    try {
      const query: CustomQueryRequest = {
        metrics: customMetrics,
        xAxis: customXAxis,
        filters: {
          nfsVersions: customNfsVersions.length ? customNfsVersions : undefined,
          workloads: customWorkloads.length ? customWorkloads : undefined,
          blockSizes: customBlockSizes.length ? customBlockSizes : undefined,
          tags: customTags ? customTags.split(',').map(t => t.trim()).filter(Boolean) : undefined,
        },
      };
      const result = await api.customQuery(query);
      setCustomResult(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Query failed');
    } finally {
      setCustomLoading(false);
    }
  };

  if (loading) return <div className="page-loading">Loading analytics...</div>;
  if (error && !summary) return <div className="page-error">Error: {error}</div>;

  return (
    <div className="analytics-page">
      <h2>Analytics Dashboard</h2>

      {/* Overview cards */}
      {summary?.summary && (
        <div className="summary-grid">
          <div className="summary-card">
            <h4>Total Runs</h4>
            <dl>
              <dt>Completed</dt><dd>{summary.completedRuns}</dd>
              <dt>Date Range</dt>
              <dd>{summary.dateRange.earliest?.slice(0, 10)} — {summary.dateRange.latest?.slice(0, 10)}</dd>
            </dl>
          </div>
          <div className="summary-card">
            <h4>IOPS Range</h4>
            <dl>
              <dt>Min</dt><dd>{summary.summary.iops.min.toLocaleString()}</dd>
              <dt>Max</dt><dd>{summary.summary.iops.max.toLocaleString()}</dd>
              <dt>Avg</dt><dd>{summary.summary.iops.avg.toLocaleString()}</dd>
            </dl>
          </div>
          <div className="summary-card">
            <h4>Bandwidth Range</h4>
            <dl>
              <dt>Min</dt><dd>{formatBw(summary.summary.bwKib.min)}</dd>
              <dt>Max</dt><dd>{formatBw(summary.summary.bwKib.max)}</dd>
              <dt>Avg</dt><dd>{formatBw(summary.summary.bwKib.avg)}</dd>
            </dl>
          </div>
          <div className="summary-card">
            <h4>p99 Latency Range</h4>
            <dl>
              <dt>Min</dt><dd>{formatLatency(summary.summary.p99Us.min)}</dd>
              <dt>Max</dt><dd>{formatLatency(summary.summary.p99Us.max)}</dd>
              <dt>Avg</dt><dd>{formatLatency(summary.summary.p99Us.avg)}</dd>
            </dl>
          </div>
        </div>
      )}

      {/* Breakdown bar charts */}
      {summary && (
        <div className="analytics-breakdowns">
          <BreakdownChart title="By NFS Version" data={summary.byNfsVersion} />
          <BreakdownChart title="By Workload" data={summary.byWorkload} />
          <BreakdownChart title="By Block Size" data={summary.byBlockSize} />
        </div>
      )}

      {/* Trend chart with controls */}
      <section className="analytics-section">
        <h3>Performance Trends</h3>
        <div className="trend-controls">
          <label>
            Metric
            <select value={trendMetric} onChange={e => setTrendMetric(e.target.value)}>
              {METRIC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>
            Group By
            <select value={trendGroup} onChange={e => setTrendGroup(e.target.value)}>
              {GROUP_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label>
            Time Range
            <select value={trendDays} onChange={e => setTrendDays(parseInt(e.target.value, 10))}>
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
              <option value={365}>Last year</option>
            </select>
          </label>
        </div>

        {trendData && trendData.series.length > 0 ? (
          <ResponsiveContainer width="100%" height={400}>
            <LineChart margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
              <XAxis
                dataKey="timestamp"
                type="category"
                stroke="#8b90a0"
                fontSize={11}
                tickFormatter={v => new Date(v).toLocaleDateString()}
                allowDuplicatedCategory={false}
              />
              <YAxis stroke="#8b90a0" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }}
                labelFormatter={v => new Date(v as string).toLocaleString()}
                formatter={(v: number) => [v.toLocaleString(), trendMetric]}
              />
              <Legend />
              {trendData.series.map((s, i) => (
                <Line
                  key={s.name}
                  data={s.points}
                  dataKey="value"
                  name={s.name}
                  type="monotone"
                  stroke={COLORS[i % COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-placeholder">No trend data available for the selected filters.</div>
        )}
      </section>

      {/* Custom query builder */}
      <section className="analytics-section">
        <h3>Custom Chart Builder</h3>
        <div className="custom-query-form">
          <div className="query-row">
            <label>
              Y-Axis Metrics
              <select
                multiple
                value={customMetrics}
                onChange={e => setCustomMetrics(Array.from(e.target.selectedOptions, o => o.value))}
                size={4}
              >
                {METRIC_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label>
              X-Axis
              <select value={customXAxis} onChange={e => setCustomXAxis(e.target.value as CustomQueryRequest['xAxis'])}>
                {XAXIS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
          </div>

          <div className="query-row">
            <label>
              Filter: NFS Versions
              <select
                multiple
                value={customNfsVersions}
                onChange={e => setCustomNfsVersions(Array.from(e.target.selectedOptions, o => o.value))}
                size={3}
              >
                <option value="3">v3</option>
                <option value="4.0">v4.0</option>
                <option value="4.1">v4.1</option>
                <option value="4.2">v4.2</option>
              </select>
            </label>
            <label>
              Filter: Workloads
              <select
                multiple
                value={customWorkloads}
                onChange={e => setCustomWorkloads(Array.from(e.target.selectedOptions, o => o.value))}
                size={3}
              >
                {['read', 'write', 'randread', 'randwrite', 'rw', 'randrw'].map(w => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            </label>
            <label>
              Filter: Block Sizes
              <select
                multiple
                value={customBlockSizes}
                onChange={e => setCustomBlockSizes(Array.from(e.target.selectedOptions, o => o.value))}
                size={3}
              >
                {['4k', '8k', '16k', '32k', '64k', '128k', '256k', '512k', '1m'].map(bs => (
                  <option key={bs} value={bs}>{bs}</option>
                ))}
              </select>
            </label>
            <label>
              Filter: Tags (comma-separated)
              <input
                type="text"
                value={customTags}
                onChange={e => setCustomTags(e.target.value)}
                placeholder="e.g., baseline, production"
              />
            </label>
          </div>

          <button onClick={runCustomQuery} className="btn btn-primary" disabled={customLoading}>
            {customLoading ? 'Querying...' : 'Run Query'}
          </button>
        </div>

        {customResult && customResult.data.length > 0 && (
          <div className="custom-results">
            <p className="help-text">{customResult.totalMatched} runs matched</p>

            {customXAxis === 'time' ? (
              /* Time-series line chart */
              <ResponsiveContainer width="100%" height={400}>
                <LineChart
                  data={customResult.data.sort((a, b) =>
                    (a.x as string).localeCompare(b.x as string)
                  )}
                  margin={{ top: 5, right: 30, left: 20, bottom: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
                  <XAxis
                    dataKey="x"
                    stroke="#8b90a0"
                    fontSize={11}
                    tickFormatter={v => new Date(v).toLocaleDateString()}
                  />
                  <YAxis stroke="#8b90a0" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }}
                    labelFormatter={v => {
                      const point = customResult.data.find(d => d.x === v);
                      return point ? `${point.name} (${new Date(v as string).toLocaleDateString()})` : '';
                    }}
                  />
                  <Legend />
                  {customMetrics.map((m, i) => (
                    <Line
                      key={m}
                      dataKey={m}
                      name={METRIC_OPTIONS.find(o => o.value === m)?.label || m}
                      type="monotone"
                      stroke={COLORS[i % COLORS.length]}
                      strokeWidth={2}
                      dot={{ r: 3 }}
                      yAxisId={i === 0 ? 'left' : 'right'}
                    />
                  ))}
                  {customMetrics.length > 1 && (
                    <YAxis yAxisId="right" orientation="right" stroke="#8b90a0" fontSize={11} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              /* Categorical bar chart */
              <ResponsiveContainer width="100%" height={400}>
                <BarChart
                  data={customResult.data}
                  margin={{ top: 5, right: 30, left: 20, bottom: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
                  <XAxis dataKey="x" stroke="#8b90a0" fontSize={11} />
                  <YAxis stroke="#8b90a0" fontSize={11} />
                  <Tooltip
                    contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }}
                    labelFormatter={v => {
                      const point = customResult.data.find(d => d.x === v);
                      return point?.name as string || String(v);
                    }}
                  />
                  <Legend />
                  {customMetrics.map((m, i) => (
                    <Bar
                      key={m}
                      dataKey={m}
                      name={METRIC_OPTIONS.find(o => o.value === m)?.label || m}
                      fill={COLORS[i % COLORS.length]}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}

            {/* Raw data table */}
            <details className="config-details">
              <summary>Raw Data ({customResult.data.length} rows)</summary>
              <div style={{ overflowX: 'auto' }}>
                <table className="runs-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>NFS</th>
                      <th>Workload</th>
                      <th>BS</th>
                      <th>Nodes</th>
                      {customMetrics.map(m => <th key={m}>{m}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {customResult.data.map((row, i) => (
                      <tr key={i}>
                        <td>{row.name as string}</td>
                        <td>v{row.nfsVersion as string}</td>
                        <td>{row.workload as string}</td>
                        <td>{row.blockSize as string}</td>
                        <td>{row.nodeCount as number}</td>
                        {customMetrics.map(m => (
                          <td key={m}>{(row[m] as number)?.toLocaleString() ?? '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        )}

        {customResult && customResult.data.length === 0 && (
          <div className="chart-placeholder">No runs matched the selected filters.</div>
        )}
      </section>
    </div>
  );
};

/** Small breakdown bar chart for the summary section */
const BreakdownChart: React.FC<{
  title: string;
  data: Record<string, { count: number; avgIops: number; avgBwKib: number; avgP99Us: number }>;
}> = ({ title, data }) => {
  const chartData = Object.entries(data).map(([key, val]) => ({
    name: key,
    avgIops: val.avgIops,
    avgP99: val.avgP99Us,
    count: val.count,
  }));

  if (chartData.length === 0) return null;

  return (
    <div className="breakdown-chart">
      <h4>{title}</h4>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
          <XAxis dataKey="name" stroke="#8b90a0" fontSize={11} />
          <YAxis yAxisId="left" stroke="#4f8ff7" fontSize={11} />
          <YAxis yAxisId="right" orientation="right" stroke="#d29922" fontSize={11} />
          <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }} />
          <Legend />
          <Bar yAxisId="left" dataKey="avgIops" fill="#4f8ff7" name="Avg IOPS" />
          <Bar yAxisId="right" dataKey="avgP99" fill="#d29922" name="Avg p99 (µs)" />
        </BarChart>
      </ResponsiveContainer>
      <div className="breakdown-counts">
        {chartData.map(d => (
          <span key={d.name} className="tag">{d.name}: {d.count} runs</span>
        ))}
      </div>
    </div>
  );
};
