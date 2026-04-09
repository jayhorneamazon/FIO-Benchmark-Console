import React, { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { api } from '../lib/api';
import { BenchmarkRun } from '@shared/types/benchmark-run';
import { ResultsChart } from '../components/ResultsChart';

export const ComparePage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ids = (searchParams.get('ids') || '').split(',').filter(Boolean);

  useEffect(() => {
    if (ids.length < 2) {
      setLoading(false);
      return;
    }
    api.compareRuns(ids)
      .then(res => setRuns(res.runs))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [searchParams.get('ids')]);

  if (loading) return <div className="page-loading">Loading comparison data...</div>;
  if (error) return <div className="page-error">Error: {error}</div>;

  if (ids.length < 2) {
    return (
      <div className="compare-page">
        <h2>Compare Runs</h2>
        <div className="empty-state">
          <p>Select 2 or more runs from the <Link to="/">dashboard</Link> to compare.</p>
        </div>
      </div>
    );
  }

  const completedRuns = runs.filter(r => r.status === 'completed' && r.results);

  if (completedRuns.length < 2) {
    return (
      <div className="compare-page">
        <h2>Compare Runs</h2>
        <div className="empty-state">
          <p>At least 2 completed runs with results are needed for comparison.</p>
          <p>{runs.length - completedRuns.length} of {runs.length} selected runs are not yet completed.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="compare-page">
      <div className="page-header">
        <Link to="/" className="back-link">← Dashboard</Link>
        <h2>Comparing {completedRuns.length} Runs</h2>
      </div>

      {/* Config diff */}
      <section className="config-diff">
        <h3>Configuration Differences</h3>
        <table className="diff-table">
          <thead>
            <tr>
              <th>Parameter</th>
              {completedRuns.map(r => <th key={r.runId}>{r.name}</th>)}
            </tr>
          </thead>
          <tbody>
            <DiffRow label="NFS Version" runs={completedRuns} extract={r => `v${r.config.nfs.nfsVersion}`} />
            <DiffRow label="rsize" runs={completedRuns} extract={r => String(r.config.nfs.rsize || 'default')} />
            <DiffRow label="wsize" runs={completedRuns} extract={r => String(r.config.nfs.wsize || 'default')} />
            <DiffRow label="nconnect" runs={completedRuns} extract={r => String(r.config.nfs.nconnect || 1)} />
            <DiffRow label="I/O Pattern" runs={completedRuns} extract={r => r.config.fioJobs[0]?.rw || '—'} />
            <DiffRow label="Block Size" runs={completedRuns} extract={r => r.config.fioJobs[0]?.bs || '—'} />
            <DiffRow label="I/O Depth" runs={completedRuns} extract={r => String(r.config.fioJobs[0]?.iodepth || '—')} />
            <DiffRow label="Num Jobs" runs={completedRuns} extract={r => String(r.config.fioJobs[0]?.numjobs || '—')} />
            <DiffRow label="Node Count" runs={completedRuns} extract={r => String(r.config.infra.nodeCount)} />
            <DiffRow label="Instance Type" runs={completedRuns} extract={r => r.config.infra.instanceType} />
          </tbody>
        </table>
      </section>

      {/* Results comparison */}
      <section className="results-section">
        <h3>Performance Comparison</h3>
        <ResultsChart
          mode="compare"
          runs={completedRuns.map(r => ({
            name: r.name,
            metrics: r.results!,
          }))}
        />
      </section>
    </div>
  );
};

/** Highlights cells that differ across runs */
const DiffRow: React.FC<{
  label: string;
  runs: BenchmarkRun[];
  extract: (r: BenchmarkRun) => string;
}> = ({ label, runs, extract }) => {
  const values = runs.map(extract);
  const allSame = values.every(v => v === values[0]);

  return (
    <tr className={allSame ? '' : 'diff-highlight'}>
      <td>{label}</td>
      {values.map((v, i) => (
        <td key={runs[i].runId} className={allSame ? '' : 'diff-cell'}>{v}</td>
      ))}
    </tr>
  );
};
