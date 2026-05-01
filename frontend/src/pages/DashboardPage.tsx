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
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();

  const fetchRuns = () => {
    api.listRuns(100)
      .then(res => setRuns(res.runs))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchRuns(); }, []);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === runs.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(runs.map(r => r.runId)));
    }
  };

  const compareSelected = () => {
    if (selectedIds.size >= 2) {
      navigate(`/compare?ids=${Array.from(selectedIds).join(',')}`);
    }
  };

  const deleteSelected = async () => {
    const count = selectedIds.size;
    const activeRuns = runs.filter(r => selectedIds.has(r.runId) && ['pending', 'scaling', 'running'].includes(r.status));

    let message = `Delete ${count} run${count > 1 ? 's' : ''}?`;
    if (activeRuns.length > 0) {
      message += ` (${activeRuns.length} still active - they will be removed from the database but worker nodes may still be running)`;
    }
    message += ' This cannot be undone.';

    if (!confirm(message)) return;

    setDeleting(true);
    setError(null);
    try {
      const result = await api.deleteRuns(Array.from(selectedIds));
      const failed = result.results.filter(r => !r.success);
      if (failed.length > 0) {
        setError(`Failed to delete ${failed.length} run(s): ${failed.map(f => f.error).join(', ')}`);
      }
      setSelectedIds(new Set());
      fetchRuns();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <div className="page-loading">Loading runs...</div>;
  if (error) return <div className="page-error">Error: {error}</div>;

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <h2>Benchmark Runs</h2>
        <div className="page-actions">
          {selectedIds.size > 0 && (
            <button
              onClick={deleteSelected}
              className="btn btn-danger"
              disabled={deleting}
            >
              {deleting ? 'Deleting...' : `Delete (${selectedIds.size})`}
            </button>
          )}
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
              <th className="col-select">
                <input
                  type="checkbox"
                  checked={selectedIds.size === runs.length && runs.length > 0}
                  onChange={toggleSelectAll}
                  aria-label="Select all runs"
                />
              </th>
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
                <tr key={run.runId} className={selectedIds.has(run.runId) ? 'row-selected' : ''}>
                  <td className="col-select">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(run.runId)}
                      onChange={() => toggleSelect(run.runId)}
                      aria-label={`Select ${run.name}`}
                    />
                  </td>
                  <td>
                    <Link to={`/runs/${run.runId}`} className="run-name-link">
                      {run.name}
                    </Link>
                  </td>
                  <td><span className={`status-badge ${status.className}`}>{status.label}</span></td>
                  <td>{run.config.infra.nodeCount}</td>
                  <td>{job ? `${job.rw} ${job.bs}` : '\u2014'}</td>
                  <td>v{run.config.nfs.nfsVersion}</td>
                  <td>{run.results ? run.results.totalIops.toLocaleString() : '\u2014'}</td>
                  <td>{run.results ? formatBw(run.results.totalBwKib) : '\u2014'}</td>
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
