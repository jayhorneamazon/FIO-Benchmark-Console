/**
 * FIO Job Configuration form component.
 * Supports guided mode (form-based) and advanced mode (raw job file editor).
 */

import React, { useState, useEffect } from 'react';
import { FioJobConfig, FioRwPattern, FioIoEngine, buildJobFile, FioGlobalConfig } from '@shared/types/fio-config';
import { WORKLOAD_PRESETS, WorkloadPreset } from '@shared/types/presets';
import { NfsMountConfig } from '@shared/types/nfs-config';

interface Props {
  jobs: FioJobConfig[];
  globalConfig: FioGlobalConfig;
  nfsConfig: NfsMountConfig;
  onJobsChange: (jobs: FioJobConfig[]) => void;
  onGlobalChange: (config: FioGlobalConfig) => void;
  onPresetApplied?: (preset: WorkloadPreset) => void;
}

const RW_PATTERNS: { value: FioRwPattern; label: string; group: string }[] = [
  { value: 'read', label: 'Sequential Read', group: 'Sequential' },
  { value: 'write', label: 'Sequential Write', group: 'Sequential' },
  { value: 'rw', label: 'Sequential Mixed R/W', group: 'Sequential' },
  { value: 'randread', label: 'Random Read', group: 'Random' },
  { value: 'randwrite', label: 'Random Write', group: 'Random' },
  { value: 'randrw', label: 'Random Mixed R/W', group: 'Random' },
];

const IO_ENGINES: { value: FioIoEngine; label: string }[] = [
  { value: 'libaio', label: 'libaio — Linux native async (recommended)' },
  { value: 'io_uring', label: 'io_uring — Modern Linux async' },
  { value: 'psync', label: 'psync — POSIX synchronous' },
  { value: 'mmap', label: 'mmap — Memory-mapped' },
  { value: 'posixaio', label: 'posixaio — POSIX async' },
];

const BLOCK_SIZES = ['512', '1k', '2k', '4k', '8k', '16k', '32k', '64k', '128k', '256k', '512k', '1m'];

export const FioJobConfigurator: React.FC<Props> = ({
  jobs, globalConfig, nfsConfig, onJobsChange, onGlobalChange, onPresetApplied,
}) => {
  const [mode, setMode] = useState<'guided' | 'advanced'>('guided');
  const [rawJobFile, setRawJobFile] = useState('');

  // Sync raw editor with structured config
  useEffect(() => {
    if (mode === 'guided') {
      setRawJobFile(buildJobFile(globalConfig, jobs));
    }
  }, [jobs, globalConfig, mode]);

  const updateJob = (index: number, partial: Partial<FioJobConfig>) => {
    const updated = [...jobs];
    updated[index] = { ...updated[index], ...partial };
    onJobsChange(updated);
  };

  const applyPreset = (preset: WorkloadPreset) => {
    const job: FioJobConfig = {
      ...preset.fioJob,
      name: preset.id,
      directory: nfsConfig.mountPoint + '/fio-bench',
    };
    onJobsChange([job]);
    onPresetApplied?.(preset);
  };

  return (
    <div className="fio-config">
      <div className="config-header">
        <h3>FIO Workload Configuration</h3>
        <div className="mode-toggle" role="tablist">
          <button
            role="tab"
            aria-selected={mode === 'guided'}
            onClick={() => setMode('guided')}
          >
            Guided
          </button>
          <button
            role="tab"
            aria-selected={mode === 'advanced'}
            onClick={() => setMode('advanced')}
          >
            Advanced (Raw Job File)
          </button>
        </div>
      </div>

      {/* Multi-export mode info banner */}
      {nfsConfig.mountMode === 'multi-export' && (
        <div className="multi-export-info" role="note">
          <strong>Multi-export mode active:</strong> Your {jobs[0]?.numjobs || 1} numjobs will be
          split across {1 + (nfsConfig.additionalExports?.length || 0)} NFS exports.
          Each export gets ~{Math.max(1, Math.floor((jobs[0]?.numjobs || 1) / (1 + (nfsConfig.additionalExports?.length || 0))))} job(s).
          To compare, create a second run with the same settings but &quot;Single Export&quot; mode.
        </div>
      )}

      {/* Preset selector */}
      <fieldset>
        <legend>Workload Presets</legend>
        <div className="preset-grid">
          {WORKLOAD_PRESETS.map(preset => {
            const versionWarning = preset.versionWarnings[nfsConfig.nfsVersion];
            return (
              <button
                key={preset.id}
                className="preset-card"
                onClick={() => applyPreset(preset)}
              >
                <strong>{preset.name}</strong>
                <p>{preset.description}</p>
                {versionWarning && (
                  <span className="preset-warning" role="alert">{versionWarning}</span>
                )}
              </button>
            );
          })}
        </div>
      </fieldset>

      {mode === 'guided' ? (
        <>
          {jobs.map((job, idx) => (
            <fieldset key={idx}>
              <legend>Job: {job.name}</legend>

              <label>
                Job name
                <input
                  type="text"
                  value={job.name}
                  onChange={e => updateJob(idx, { name: e.target.value })}
                />
              </label>

              {/* I/O Pattern */}
              <label>
                I/O Pattern
                <select
                  value={job.rw}
                  onChange={e => updateJob(idx, { rw: e.target.value as FioRwPattern })}
                >
                  {RW_PATTERNS.map(p => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>

              {/* R/W Mix (only for mixed patterns) */}
              {(job.rw === 'rw' || job.rw === 'randrw') && (
                <label>
                  Read percentage: {job.rwmixread ?? 50}%
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={job.rwmixread ?? 50}
                    onChange={e => updateJob(idx, { rwmixread: parseInt(e.target.value, 10) })}
                  />
                  <span className="range-labels">
                    <span>100% Write</span>
                    <span>50/50</span>
                    <span>100% Read</span>
                  </span>
                </label>
              )}

              {/* Block Size */}
              <label>
                Block Size
                <select
                  value={job.bs}
                  onChange={e => updateJob(idx, { bs: e.target.value })}
                >
                  {BLOCK_SIZES.map(bs => (
                    <option key={bs} value={bs}>{bs}</option>
                  ))}
                </select>
              </label>

              {/* I/O Engine */}
              <label>
                I/O Engine
                <select
                  value={job.ioengine}
                  onChange={e => updateJob(idx, { ioengine: e.target.value as FioIoEngine })}
                >
                  {IO_ENGINES.map(e => (
                    <option key={e.value} value={e.value}>{e.label}</option>
                  ))}
                </select>
              </label>

              {/* I/O Depth */}
              <label>
                I/O Depth (queue depth): {job.iodepth}
                <input
                  type="range"
                  min={1}
                  max={256}
                  value={job.iodepth}
                  onChange={e => updateJob(idx, { iodepth: parseInt(e.target.value, 10) })}
                />
              </label>

              {/* Concurrency */}
              <label>
                Number of jobs (threads): {job.numjobs}
                <input
                  type="range"
                  min={1}
                  max={64}
                  value={job.numjobs}
                  onChange={e => updateJob(idx, { numjobs: parseInt(e.target.value, 10) })}
                />
              </label>

              {/* File Configuration */}
              <label>
                Total file size per job
                <input
                  type="text"
                  value={job.size}
                  onChange={e => updateJob(idx, { size: e.target.value })}
                  placeholder="e.g., 1g, 10g"
                />
              </label>

              <label>
                Number of files per job
                <input
                  type="number"
                  min={1}
                  value={job.nrfiles || 1}
                  onChange={e => updateJob(idx, { nrfiles: parseInt(e.target.value, 10) })}
                />
              </label>

              {/* Runtime */}
              <label>
                Runtime (seconds)
                <input
                  type="number"
                  min={10}
                  value={job.runtime || 300}
                  onChange={e => updateJob(idx, { runtime: parseInt(e.target.value, 10) })}
                />
              </label>

              <label className="checkbox-option">
                <input
                  type="checkbox"
                  checked={job.direct}
                  onChange={e => updateJob(idx, { direct: e.target.checked })}
                />
                Direct I/O (bypass page cache — recommended for NFS benchmarks)
              </label>
            </fieldset>
          ))}
        </>
      ) : (
        /* Advanced raw editor */
        <fieldset>
          <legend>Raw FIO Job File</legend>
          <textarea
            className="job-file-editor"
            value={rawJobFile}
            onChange={e => setRawJobFile(e.target.value)}
            rows={30}
            spellCheck={false}
            aria-label="FIO job file editor"
          />
          <p className="help-text">
            Edit the job file directly. Changes here override the guided configuration.
          </p>
        </fieldset>
      )}

      {/* Generated job file preview (in guided mode) */}
      {mode === 'guided' && (
        <fieldset>
          <legend>Generated Job File</legend>
          <pre className="job-file-preview">
            {buildJobFile(globalConfig, jobs)}
          </pre>
        </fieldset>
      )}
    </div>
  );
};
