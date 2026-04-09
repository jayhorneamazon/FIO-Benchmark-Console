import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { BenchmarkRun, RunStatus } from '@shared/types/benchmark-run';

const STATUS_LABELS: Record<RunStatus, { label: string; className: string }> = {
  pending: { label: 'Pending', className: 'status-pending' },
  scaling: { label: 'Scaling', className: 'status-active' },
  mounting: { label: 'Mounting', className: 'status-active' },
  running: { label: 'Running', className: 'status-active' },
  collecting: { label: 'Collecting', className: 'status-active' },
  aggregating: { label: 'Aggregating', className: 'status-active' },
  completed: { label: 'Completed', className: 'status-completed' },
  failed: { label: 'Failed', className: 'status-failed' },
  cancelled: { label: 'Cancelled', className: 'status-cancelled' },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatBw(kib: number): string {
  if (kib < 1024) return `${kib.toFixed(0)} KiB/s`;
  if (kib < 1048576) return `${(kib / 1024).toFixed(1)} MiB/s`;
  return `${(kib / 1048576).toFixed(2)} GiB/s`;
}

export const DashboardPage: React.FC = () => {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  useEffect(() => {
    api.listRuns(100)
      .then(res => setRuns(res.runs))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const compareSelected = () => {
    if (selectedIds.size >= 2) {
      navigate(`/compare?ids=${Array.from(selectedIds).join(',')}`);
    }
  };

  if (loading) return <div className="page-loading">Loading runs...</div>;
  if (error) return <div className="page-error">Error: {error}</div>;

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <h2>Benchmark Runs</h2>
        <div className="page-actions">
          {selectedIds.size >= 2 && (
            <button onClick={compareSelected} className="btn btn-secondary">
              Compare ({selectedIds.size})
            </button>
          )}
          <Link to="/new" className="btn btn-primary">New Run</Link>
        </div>
      </div>

      {runs.length === 0 ? (
        <div className="empty-state">
          <p>No benchmark runs yet.</p>
          <Link to="/new" className="btn btn-primary">Create your first run</Link>
        </div>
      ) : (
        <table className="runs-table">
          <thead>
            <tr>
              <th className="col-select" aria-label="Select for comparison"></th>
              <th>Name</th>
              <th>Status</th>
              <th>Nodes</th>
              <th>Workload</th>
              <th>NFS Version</th>
              <th>IOPS</th>
              <th>Bandwidth</th>
              <th>Created</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody>
            {runs.map(run => {
              const status = STATUS_LABELS[run.status] || { label: run.status, className: '' };
              const job = run.config.fioJobs[0];
              return (
                <tr key={run.runId}>
                  <td className="col-select">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(run.runId)}
                      onChange={() => toggleSelect(run.runId)}
                      aria-label={`Select ${run.name} for comparison`}
                    />
                  </td>
                  <td>
                    <Link to={`/runs/${run.runId}`} className="run-name-link">
                      {run.name}
                    </Link>
                  </td>
                  <td><span className={`status-badge ${status.className}`}>{status.label}</span></td>
                  <td>{run.config.infra.nodeCount}</td>
                  <td>{job ? `${job.rw} ${job.bs}` : '—'}</td>
                  <td>v{run.config.nfs.nfsVersion}</td>
                  <td>{run.results ? run.results.totalIops.toLocaleString() : '—'}</td>
                  <td>{run.results ? formatBw(run.results.totalBwKib) : '—'}</td>
                  <td>{formatDate(run.createdAt)}</td>
                  <td>
                    {run.tags.map(t => (
                      <span key={t} className="tag">{t}</span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
};
