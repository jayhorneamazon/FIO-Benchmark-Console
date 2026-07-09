/**
 * NFS Mount Configuration form component.
 * Provides guided configuration with real-time validation warnings
 * based on the selected workload profile.
 */

import React from 'react';
import {
  NfsMountConfig, NfsMountMode, NfsAdditionalExport,
  NfsVersion, NfsTransport, NfsMountHardness, NfsSecurityFlavor,
  buildMountCommand, buildAllMountCommands,
} from '@shared/types/nfs-config';

interface Props {
  config: NfsMountConfig;
  onChange: (config: NfsMountConfig) => void;
  warnings?: Array<{ field: string; message: string; severity: string }>;
}

const NFS_VERSIONS: { value: NfsVersion; label: string; description: string }[] = [
  { value: '3', label: 'NFSv3', description: 'Lowest per-op overhead. Best for small random I/O and HPC workloads.' },
  { value: '4.0', label: 'NFSv4.0', description: 'Stateful protocol with integrated locking. Moderate metadata overhead.' },
  { value: '4.1', label: 'NFSv4.1', description: 'Adds sessions and pNFS. Good for large sequential I/O.' },
  { value: '4.2', label: 'NFSv4.2', description: 'Server-side copy, sparse files. Highest per-op metadata cost.' },
];

const TRANSPORTS: { value: NfsTransport; label: string; v3Only?: boolean }[] = [
  { value: 'tcp', label: 'TCP (recommended)' },
  { value: 'tcp6', label: 'TCP IPv6' },
  { value: 'udp', label: 'UDP (v3 only, not recommended)', v3Only: true },
  { value: 'rdma', label: 'RDMA' },
];

const RSIZE_OPTIONS = [
  { value: 65536, label: '64 KB — Small random I/O' },
  { value: 131072, label: '128 KB' },
  { value: 262144, label: '256 KB — Mixed workloads' },
  { value: 524288, label: '512 KB' },
  { value: 1048576, label: '1 MB — Large sequential I/O (max)' },
];

export const NfsMountConfigurator: React.FC<Props> = ({ config, onChange, warnings = [] }) => {
  const update = (partial: Partial<NfsMountConfig>) => {
    onChange({ ...config, ...partial });
  };

  const warningsForField = (field: string) =>
    warnings.filter(w => w.field === field);

  return (
    <div className="nfs-config">
      <h3>NFS Mount Configuration</h3>

      {/* Server & Export */}
      <fieldset>
        <legend>NFS Target</legend>
        <label>
          Server hostname / IP
          <input
            type="text"
            value={config.server}
            onChange={e => update({ server: e.target.value })}
            placeholder="nfs-server.example.com or 10.0.1.50"
          />
        </label>
        <label>
          Export path
          <input
            type="text"
            value={config.exportPath}
            onChange={e => update({ exportPath: e.target.value })}
            placeholder="/export/benchmark"
          />
        </label>
        <label>
          Local mount point
          <input
            type="text"
            value={config.mountPoint}
            onChange={e => update({ mountPoint: e.target.value })}
            placeholder="/mnt/benchmark"
          />
        </label>
      </fieldset>

      {/* Protocol Version */}
      <fieldset>
        <legend>Protocol Version</legend>
        {NFS_VERSIONS.map(v => (
          <label key={v.value} className="radio-option">
            <input
              type="radio"
              name="nfsVersion"
              value={v.value}
              checked={config.nfsVersion === v.value}
              onChange={() => update({ nfsVersion: v.value })}
            />
            <span className="radio-label">
              <strong>{v.label}</strong>
              <span className="radio-description">{v.description}</span>
            </span>
          </label>
        ))}
        {warningsForField('nfsVersion').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}
      </fieldset>

      {/* Transport */}
      <fieldset>
        <legend>Transport</legend>
        <select
          value={config.transport || 'tcp'}
          onChange={e => update({ transport: e.target.value as NfsTransport })}
        >
          {TRANSPORTS
            .filter(t => !t.v3Only || config.nfsVersion === '3')
            .map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
        </select>
        {warningsForField('transport').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}
      </fieldset>

      {/* I/O Sizes */}
      <fieldset>
        <legend>Read/Write Sizes</legend>
        <label>
          rsize (max bytes per READ)
          <select
            value={config.rsize || 1048576}
            onChange={e => update({ rsize: parseInt(e.target.value, 10) })}
          >
            {RSIZE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {warningsForField('rsize').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}
        <label>
          wsize (max bytes per WRITE)
          <select
            value={config.wsize || 1048576}
            onChange={e => update({ wsize: parseInt(e.target.value, 10) })}
          >
            {RSIZE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        {warningsForField('wsize').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}
      </fieldset>

      {/* Performance Tuning */}
      <fieldset>
        <legend>Performance Tuning</legend>
        <label>
          nconnect (TCP connections, 1-16)
          <input
            type="number"
            min={1}
            max={16}
            value={config.nconnect || 1}
            onChange={e => update({ nconnect: parseInt(e.target.value, 10) })}
          />
        </label>
        {warningsForField('nconnect').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}

        <label>
          Mount behavior on timeout
          <select
            value={config.mountHardness || 'hard'}
            onChange={e => update({ mountHardness: e.target.value as NfsMountHardness })}
          >
            <option value="hard">hard — Retry indefinitely (recommended for benchmarks)</option>
            <option value="soft">soft — Fail after retrans attempts (returns EIO)</option>
            <option value="softerr">softerr — Fail after retrans (returns ETIMEDOUT)</option>
          </select>
        </label>
        {warningsForField('mountHardness').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}
      </fieldset>

      {/* Caching */}
      <fieldset>
        <legend>Attribute Caching</legend>
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={config.attributeCaching !== false}
            onChange={e => update({ attributeCaching: e.target.checked })}
          />
          Enable attribute caching (ac)
          <span className="help-text">
            Disabling (noac) forces synchronous writes and per-op attribute checks.
            Use only for coherence or integrity testing.
          </span>
        </label>
        {warningsForField('attributeCaching').map((w, i) => (
          <div key={i} className={`validation-${w.severity}`} role="alert">
            {w.message}
          </div>
        ))}

        {config.attributeCaching !== false && (
          <>
            <label>
              acregmin (seconds)
              <input type="number" min={0} value={config.acregmin ?? 3}
                onChange={e => update({ acregmin: parseInt(e.target.value, 10) })} />
            </label>
            <label>
              acregmax (seconds)
              <input type="number" min={0} value={config.acregmax ?? 60}
                onChange={e => update({ acregmax: parseInt(e.target.value, 10) })} />
            </label>
          </>
        )}
      </fieldset>

      {/* V3-specific options */}
      {config.nfsVersion === '3' && (
        <fieldset>
          <legend>NFSv3 Options</legend>
          <label className="checkbox-option">
            <input
              type="checkbox"
              checked={config.lock !== false}
              onChange={e => update({ lock: e.target.checked })}
            />
            Enable NLM locking
            <span className="help-text">
              Disable for benchmarks that don't need file locks. Removes NLM sideband protocol overhead.
            </span>
          </label>
        </fieldset>
      )}

      {/* Multi-Export Mode */}
      <fieldset>
        <legend>Export Distribution</legend>
        <label className="radio-option">
          <input
            type="radio"
            name="mountMode"
            value="single"
            checked={config.mountMode !== 'multi-export'}
            onChange={() => update({ mountMode: 'single', additionalExports: undefined })}
          />
          <span className="radio-label">
            <strong>Single Export</strong>
            <span className="radio-description">
              All FIO jobs target one NFS export. Standard benchmark mode.
            </span>
          </span>
        </label>
        <label className="radio-option">
          <input
            type="radio"
            name="mountMode"
            value="multi-export"
            checked={config.mountMode === 'multi-export'}
            onChange={() => update({
              mountMode: 'multi-export',
              additionalExports: config.additionalExports?.length
                ? config.additionalExports
                : [{ exportPath: '' }],
            })}
          />
          <span className="radio-label">
            <strong>Multi-Export</strong>
            <span className="radio-description">
              Spread FIO jobs across multiple exports from the same server.
              Compare single-export vs multi-export performance by running both modes and using the comparison page.
            </span>
          </span>
        </label>

        {config.mountMode === 'multi-export' && (
          <div className="multi-export-config">
            <p className="help-text">
              Add additional exports from <strong>{config.server || 'the NFS server'}</strong>.
              FIO jobs will be evenly distributed across all exports (primary + additional).
            </p>

            {(config.additionalExports || []).map((exp, idx) => (
              <div key={idx} className="additional-export-row">
                <label>
                  Export path #{idx + 2}
                  <input
                    type="text"
                    value={exp.exportPath}
                    onChange={e => {
                      const updated = [...(config.additionalExports || [])];
                      updated[idx] = { ...updated[idx], exportPath: e.target.value };
                      update({ additionalExports: updated });
                    }}
                    placeholder={`/export/vol${idx + 2}`}
                  />
                </label>
                <label>
                  Mount point (optional)
                  <input
                    type="text"
                    value={exp.mountPoint || ''}
                    onChange={e => {
                      const updated = [...(config.additionalExports || [])];
                      updated[idx] = { ...updated[idx], mountPoint: e.target.value || undefined };
                      update({ additionalExports: updated });
                    }}
                    placeholder={`${config.mountPoint || '/mnt/benchmark'}-${idx + 1}`}
                  />
                </label>
                <button
                  type="button"
                  className="remove-btn"
                  onClick={() => {
                    const updated = (config.additionalExports || []).filter((_, i) => i !== idx);
                    update({ additionalExports: updated.length ? updated : [{ exportPath: '' }] });
                  }}
                  aria-label={`Remove export #${idx + 2}`}
                >
                  Remove
                </button>
              </div>
            ))}

            <button
              type="button"
              className="add-export-btn"
              onClick={() => {
                const updated = [...(config.additionalExports || []), { exportPath: '' }];
                update({ additionalExports: updated });
              }}
            >
              + Add Export
            </button>

            <div className="multi-export-summary" role="status">
              Total exports: {1 + (config.additionalExports?.length || 0)} (primary + {config.additionalExports?.length || 0} additional)
            </div>
          </div>
        )}
      </fieldset>

      {/* Generated mount command preview */}
      <fieldset>
        <legend>Generated Mount Command{config.mountMode === 'multi-export' ? 's' : ''}</legend>
        <pre className="mount-preview">
          {buildPreviewCommands(config)}
        </pre>
      </fieldset>
    </div>
  );
};

function buildPreviewCommands(config: NfsMountConfig): string {
  try {
    if (config.mountMode === 'multi-export') {
      const commands = buildAllMountCommands(config);
      return commands.map((cmd, i) => `# Export ${i + 1}\n${cmd}`).join('\n\n');
    }
    return buildMountCommand(config);
  } catch {
    return '# Configure server and export path to see mount command';
  }
}
