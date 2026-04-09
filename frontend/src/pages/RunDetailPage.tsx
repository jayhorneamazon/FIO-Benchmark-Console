import React, { useEffect, useState, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { BenchmarkRun, NodeStatus } from '@shared/types/benchmark-run';
import { ResultsChart } from '../components/ResultsChart';

const ACTIVE_STATUSES = new Set(['pending', 'scaling', 'mounting', 'running', 'collecting', 'aggregating']);

const NODE_STATUS_ORDER: Record<string, number> = {
  failed: 0, running: 1, mounting: 2, pending: 3, completed: 4,
};

function formatNodeTime(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString();
}

export const RunDetailPage: React.FC = () => {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [run, setRun] = useState<BenchmarkRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);

  const fetchRun = useCallback(async () => {
    if (!runId) return;
    try {
      const res = await api.getRun(runId);
      setRun(res.run);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load run');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => { fetchRun(); }, [fetchRun]);

  // Poll while active
  useEffect(() => {
    if (!run || !ACTIVE_STATUSES.has(run.status)) return;
    const interval = setInterval(fetchRun, 5000);
    return () => clearInterval(interval);
  }, [run?.status, fetchRun]);

  const handleCancel = async () => {
    if (!runId || !confirm('Cancel this benchmark run? Workers will be terminated.')) return;
    setCancelling(true);
    try {
      await api.cancelRun(runId);
      await fetchRun();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setCancelling(false);
    }
  };

  const handleRerun = async () => {
    if (!run) return;
    setRerunning(true);
    setError(null);
    try {
      // Generate a re-run name: append "(re-run)" or increment existing counter
      const rerunMatch = run.name.match(/^(.*?)(?:\s*\(re-run(?:\s+(\d+))?\))?$/);
      const baseName = rerunMatch?.[1] || run.name;
      const prevCount = rerunMatch?.[2] ? parseInt(rerunMatch[2], 10) : (run.name.includes('(re-run') ? 1 : 0);
      const newName = prevCount === 0
        ? `${baseName} (re-run)`
        : `${baseName} (re-run ${prevCount + 1})`;

      const result = await api.createRun({
        name: newName,
        description: `Re-run of "${run.name}"${run.description ? `. ${run.description}` : ''}`,
        tags: [...run.tags, 're-run'],
        config: run.config,
      });
      navigate(`/runs/${result.run.runId}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create re-run');
    } finally {
      setRerunning(false);
    }
  };

  if (loading) return <div className="page-loading">Loading run details...</div>;
  if (error) return <div className="page-error">Error: {error}</div>;
  if (!run) return <div className="page-error">Run not found</div>;

  const isActive = ACTIVE_STATUSES.has(run.status);
  const job = run.config.fioJobs[0];
  const nodes = (run.nodes || []).sort((a, b) =>
    (NODE_STATUS_ORDER[a.status] ?? 99) - (NODE_STATUS_ORDER[b.status] ?? 99)
  );
  const completedNodes = nodes.filter(n => n.status === 'completed').length;
  const failedNodes = nodes.filter(n => n.status === 'failed').length;
  const runningNodes = nodes.filter(n => n.status === 'running').length;

  return (
    <div className="run-detail-page">
      <div className="page-header">
        <div>
          <Link to="/" className="back-link">← All Runs</Link>
          <h2>{run.name}</h2>
          {run.description && <p className="run-description">{run.description}</p>}
        </div>
        <div className="page-actions">
          {!isActive && (
            <button onClick={handleRerun} className="btn btn-primary" disabled={rerunning}>
              {rerunning ? 'Launching...' : 'Re-run'}
            </button>
          )}
          {isActive && (
            <button onClick={handleCancel} className="btn btn-danger" disabled={cancelling}>
              {cancelling ? 'Cancelling...' : 'Cancel Run'}
            </button>
          )}
        </div>
      </div>

      {/* Status + metadata */}
      <div className="run-meta-grid">
        <div className="meta-card">
          <h4>Status</h4>
          <span className={`status-badge status-${run.status}`}>{run.status}</span>
          {isActive && <span className="polling-indicator" aria-label="Auto-refreshing">●</span>}
          {run.error && <p className="error-text">{run.error}</p>}
        </div>
        <div className="meta-card">
          <h4>Configuration</h4>
          <dl>
            <dt>NFS</dt>
            <dd>{run.config.nfs.server}:{run.config.nfs.exportPath} v{run.config.nfs.nfsVersion}</dd>
            <dt>Workload</dt>
            <dd>{job?.rw} bs={job?.bs} depth={job?.iodepth}</dd>
            <dt>Nodes</dt>
            <dd>{run.config.infra.nodeCount}x {run.config.infra.instanceType}</dd>
          </dl>
        </div>
        <div className="meta-card">
          <h4>Timeline</h4>
          <dl>
            <dt>Created</dt>
            <dd>{new Date(run.createdAt).toLocaleString()}</dd>
            {run.startedAt && <><dt>Started</dt><dd>{new Date(run.startedAt).toLocaleString()}</dd></>}
            {run.completedAt && <><dt>Completed</dt><dd>{new Date(run.completedAt).toLocaleString()}</dd></>}
          </dl>
        </div>
        <div className="meta-card">
          <h4>Tags</h4>
          <div className="tag-list">
            {run.tags.length > 0
              ? run.tags.map(t => <span key={t} className="tag">{t}</span>)
              : <span className="muted">No tags</span>}
          </div>
        </div>
      </div>

      {/* Worker nodes section — always shown when nodes exist */}
      {nodes.length > 0 && (
        <section className="node-status-section">
          <h3>
            Worker Nodes
            <span className="node-summary">
              {completedNodes > 0 && <span className="node-count completed">{completedNodes} completed</span>}
              {runningNodes > 0 && <span className="node-count running">{runningNodes} running</span>}
              {failedNodes > 0 && <span className="node-count failed">{failedNodes} failed</span>}
              {nodes.length < run.config.infra.nodeCount && (
                <span className="node-count pending">
                  {run.config.infra.nodeCount - nodes.length} pending
                </span>
              )}
            </span>
          </h3>

          {/* Heatmap grid for quick visual */}
          <div className="node-grid">
            {nodes.map(node => (
              <div
                key={node.nodeId}
                className={`node-cell node-${node.status}`}
                title={`${node.nodeId}: ${node.status}${node.error ? ' — ' + node.error : ''}`}
              />
            ))}
            {/* Show empty cells for nodes that haven't reported yet */}
            {Array.from({ length: Math.max(0, run.config.infra.nodeCount - nodes.length) }).map((_, i) => (
              <div key={`pending-${i}`} className="node-cell node-pending" title="Waiting to report" />
            ))}
          </div>

          {/* Detailed node table */}
          <table className="node-table">
            <thead>
              <tr>
                <th>Instance ID</th>
                <th>Private IP</th>
                <th>FIO Status</th>
                <th>EC2 State</th>
                <th>Status Checks</th>
                <th>Last Updated</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map(node => (
                <tr key={node.nodeId} className={node.status === 'failed' ? 'row-failed' : ''}>
                  <td className="mono">{node.nodeId}</td>
                  <td className="mono">{node.privateIp || '—'}</td>
                  <td>
                    <span className={`status-badge status-${node.status}`}>{node.status}</span>
                  </td>
                  <td>
                    {node.ec2State ? (
                      <span className={`status-badge ec2-${node.ec2State}`}>{node.ec2State}</span>
                    ) : '—'}
                  </td>
                  <td>
                    {node.ec2StatusCheck ? (
                      <span className={`status-badge ec2-check-${node.ec2StatusCheck}`}>
                        {node.ec2StatusCheck}
                      </span>
                    ) : '—'}
                  </td>
                  <td>{formatNodeTime(node.updatedAt)}</td>
                  <td className="error-text">{node.error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Results (when completed) */}
      {run.status === 'completed' && run.results && (
        <section className="results-section">
          <h3>Results</h3>
          <ResultsChart
            mode="single"
            metrics={run.results}
            runName={run.name}
          />
        </section>
      )}

      {/* Mount command + job file (collapsible) */}
      <details className="config-details">
        <summary>Mount Command</summary>
        <pre className="code-block">{run.mountCommand}</pre>
      </details>
      <details className="config-details">
        <summary>FIO Job File</summary>
        <pre className="code-block">{run.jobFileContent}</pre>
      </details>
    </div>
  );
};
