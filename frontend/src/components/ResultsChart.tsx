/**
 * Results visualization using Recharts.
 * Renders latency CDF, IOPS/BW bars, and per-node distribution.
 */

import React, { useMemo } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { AggregatedMetrics } from '@shared/types/benchmark-run';

interface SingleRunProps { mode: 'single'; metrics: AggregatedMetrics; runName: string; }
interface CompareRunProps { mode: 'compare'; runs: Array<{ name: string; metrics: AggregatedMetrics }>; }
type Props = SingleRunProps | CompareRunProps;

const COLORS = ['#4f8ff7', '#3fb950', '#d29922', '#e5534b', '#a371f7', '#58a6ff', '#f778ba', '#79c0ff'];

function histogramToCdf(histogram: Record<string, number> | undefined): Array<{ latencyUs: number; percentile: number }> {
  if (!histogram) return [];
  const bins = Object.entries(histogram)
    .map(([ns, count]) => ({ latencyUs: parseInt(ns, 10) / 1000, count }))
    .sort((a, b) => a.latencyUs - b.latencyUs);
  const total = bins.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) return [];
  const points: Array<{ latencyUs: number; percentile: number }> = [];
  let cumulative = 0;
  for (const bin of bins) {
    cumulative += bin.count;
    points.push({ latencyUs: bin.latencyUs, percentile: (cumulative / total) * 100 });
  }
  return points;
}

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

export const ResultsChart: React.FC<Props> = (props) => {
  const runsData = useMemo(() => {
    if (props.mode === 'single') return [{ name: props.runName, metrics: props.metrics }];
    return props.runs;
  }, [props]);

  // Build merged CDF data for overlay chart: each row has latencyUs + one column per series
  const cdfChartData = useMemo(() => {
    const allSeries = runsData.map(r => ({
      name: r.name,
      points: histogramToCdf(r.metrics.latencyHistogram),
    }));
    // Merge all latency values into a single sorted set, then interpolate each series
    const allLatencies = new Set<number>();
    for (const s of allSeries) for (const p of s.points) allLatencies.add(p.latencyUs);
    const sorted = Array.from(allLatencies).sort((a, b) => a - b);
    // Downsample if too many points
    const step = Math.max(1, Math.floor(sorted.length / 500));
    const sampled = sorted.filter((_, i) => i % step === 0 || i === sorted.length - 1);

    return sampled.map(lat => {
      const row: Record<string, number> = { latencyUs: lat };
      for (const s of allSeries) {
        // Find the closest point <= this latency
        let pct = 0;
        for (const p of s.points) {
          if (p.latencyUs <= lat) pct = p.percentile;
          else break;
        }
        row[s.name] = pct;
      }
      return row;
    });
  }, [runsData]);

  const seriesNames = runsData.map(r => r.name);

  // Bar chart data for IOPS/BW comparison
  const barData = runsData.map(r => ({
    name: r.name,
    iops: r.metrics.totalIops,
    bwMib: Math.round(r.metrics.totalBwKib / 1024),
    p99: r.metrics.latencyPercentiles.p99,
  }));

  return (
    <div className="results-charts">
      {/* Summary cards */}
      <div className="summary-grid">
        {runsData.map(r => (
          <div key={r.name} className="summary-card">
            <h4>{r.name}</h4>
            <dl>
              <dt>Total IOPS</dt><dd>{r.metrics.totalIops.toLocaleString()}</dd>
              <dt>Bandwidth</dt><dd>{formatBw(r.metrics.totalBwKib)}</dd>
              <dt>p50</dt><dd>{formatLatency(r.metrics.latencyPercentiles.p50)}</dd>
              <dt>p99</dt><dd>{formatLatency(r.metrics.latencyPercentiles.p99)}</dd>
              <dt>p99.9</dt><dd>{formatLatency(r.metrics.latencyPercentiles.p999)}</dd>
            </dl>
          </div>
        ))}
      </div>

      {/* Latency CDF */}
      {cdfChartData.length > 0 && (
        <div className="chart-container">
          <h4>Latency CDF (Cumulative Distribution)</h4>
          <ResponsiveContainer width="100%" height={400}>
            <LineChart data={cdfChartData} margin={{ top: 5, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
              <XAxis
                dataKey="latencyUs"
                scale="log"
                domain={['auto', 'auto']}
                type="number"
                tickFormatter={v => formatLatency(v)}
                stroke="#8b90a0"
                fontSize={11}
                label={{ value: 'Latency', position: 'insideBottom', offset: -10, fill: '#8b90a0' }}
              />
              <YAxis
                domain={[0, 100]}
                stroke="#8b90a0"
                fontSize={11}
                label={{ value: 'Percentile', angle: -90, position: 'insideLeft', fill: '#8b90a0' }}
              />
              <Tooltip
                contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }}
                labelFormatter={v => `Latency: ${formatLatency(v as number)}`}
                formatter={(v: number, name: string) => [`${v.toFixed(2)}%`, name]}
              />
              <Legend />
              <ReferenceLine y={50} stroke="#3fb950" strokeDasharray="3 3" label={{ value: 'p50', fill: '#3fb950', fontSize: 10 }} />
              <ReferenceLine y={99} stroke="#d29922" strokeDasharray="3 3" label={{ value: 'p99', fill: '#d29922', fontSize: 10 }} />
              <ReferenceLine y={99.9} stroke="#e5534b" strokeDasharray="3 3" label={{ value: 'p99.9', fill: '#e5534b', fontSize: 10 }} />
              {seriesNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={COLORS[i % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* IOPS + BW bar chart (comparison mode) */}
      {runsData.length > 1 && (
        <div className="chart-container">
          <h4>IOPS Comparison</h4>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={barData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
              <XAxis dataKey="name" stroke="#8b90a0" fontSize={11} />
              <YAxis stroke="#8b90a0" fontSize={11} />
              <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }} />
              <Bar dataKey="iops" fill="#4f8ff7" name="Total IOPS" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Per-node distribution (single run) */}
      {runsData.length === 1 && runsData[0].metrics.perNodeIops.length > 1 && (
        <div className="chart-container">
          <h4>Per-Node IOPS Distribution</h4>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart
              data={runsData[0].metrics.perNodeIops.map((iops, i) => ({ node: `N${i + 1}`, iops }))}
              margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#2d3348" />
              <XAxis dataKey="node" stroke="#8b90a0" fontSize={10} />
              <YAxis stroke="#8b90a0" fontSize={11} />
              <Tooltip contentStyle={{ background: '#1a1d27', border: '1px solid #2d3348', borderRadius: 6 }} />
              <Bar dataKey="iops" fill="#4f8ff7" name="IOPS" />
              <ReferenceLine
                y={avg(runsData[0].metrics.perNodeIops)}
                stroke="#3fb950"
                strokeDasharray="3 3"
                label={{ value: 'avg', fill: '#3fb950', fontSize: 10 }}
              />
            </BarChart>
          </ResponsiveContainer>
          <p className="help-text">
            Even distribution indicates no single-node bottleneck. Skew may indicate network or NFS server hotspots.
          </p>
        </div>
      )}

      {/* Comparison table */}
      {runsData.length > 1 && (
        <div className="comparison-table">
          <h4>Side-by-Side Comparison</h4>
          <table>
            <thead>
              <tr>
                <th>Metric</th>
                {runsData.map(r => <th key={r.name}>{r.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {[
                { label: 'Total IOPS', fn: (r: typeof runsData[0]) => r.metrics.totalIops.toLocaleString() },
                { label: 'Bandwidth', fn: (r: typeof runsData[0]) => formatBw(r.metrics.totalBwKib) },
                { label: 'p50 Latency', fn: (r: typeof runsData[0]) => formatLatency(r.metrics.latencyPercentiles.p50) },
                { label: 'p90 Latency', fn: (r: typeof runsData[0]) => formatLatency(r.metrics.latencyPercentiles.p90) },
                { label: 'p95 Latency', fn: (r: typeof runsData[0]) => formatLatency(r.metrics.latencyPercentiles.p95) },
                { label: 'p99 Latency', fn: (r: typeof runsData[0]) => formatLatency(r.metrics.latencyPercentiles.p99) },
                { label: 'p99.9 Latency', fn: (r: typeof runsData[0]) => formatLatency(r.metrics.latencyPercentiles.p999) },
              ].map(row => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  {runsData.map(r => <td key={r.name}>{row.fn(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
