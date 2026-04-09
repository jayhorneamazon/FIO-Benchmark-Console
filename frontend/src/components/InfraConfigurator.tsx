/**
 * Infrastructure configuration component.
 * Controls ASG sizing, instance type, and placement.
 */

import React from 'react';
import { InfraConfig } from '@shared/types/benchmark-run';

interface Props {
  config: InfraConfig;
  onChange: (config: InfraConfig) => void;
}

const INSTANCE_PRESETS = [
  { type: 'c5.xlarge', label: 'c5.xlarge — 4 vCPU, 8 GiB, up to 4.75 Gbps network', costPerHr: 0.17 },
  { type: 'c5.2xlarge', label: 'c5.2xlarge — 8 vCPU, 16 GiB, up to 10 Gbps', costPerHr: 0.34 },
  { type: 'c5n.2xlarge', label: 'c5n.2xlarge — 8 vCPU, 21 GiB, up to 25 Gbps network', costPerHr: 0.432 },
  { type: 'c5n.9xlarge', label: 'c5n.9xlarge — 36 vCPU, 96 GiB, 50 Gbps network', costPerHr: 1.944 },
  { type: 'm5.xlarge', label: 'm5.xlarge — 4 vCPU, 16 GiB, up to 10 Gbps', costPerHr: 0.192 },
  { type: 'm5.4xlarge', label: 'm5.4xlarge — 16 vCPU, 64 GiB, up to 10 Gbps', costPerHr: 0.768 },
  { type: 'r5.2xlarge', label: 'r5.2xlarge — 8 vCPU, 64 GiB, up to 10 Gbps', costPerHr: 0.504 },
];

const NODE_PRESETS = [
  { count: 1, label: '1 node (single client test)' },
  { count: 5, label: '5 nodes (small scale)' },
  { count: 10, label: '10 nodes' },
  { count: 25, label: '25 nodes (medium scale)' },
  { count: 50, label: '50 nodes' },
  { count: 100, label: '100 nodes (large scale)' },
];

export const InfraConfigurator: React.FC<Props> = ({ config, onChange }) => {
  const update = (partial: Partial<InfraConfig>) => {
    onChange({ ...config, ...partial });
  };

  const selectedInstance = INSTANCE_PRESETS.find(i => i.type === config.instanceType);
  const estimatedHourlyCost = (selectedInstance?.costPerHr || 0) * config.nodeCount;
  const spotDiscount = config.useSpot ? 0.3 : 1.0; // Rough estimate: spot is ~70% cheaper

  return (
    <div className="infra-config">
      <h3>Infrastructure Configuration</h3>

      <fieldset>
        <legend>Worker Nodes</legend>

        <label>
          Instance Type
          <select
            value={config.instanceType}
            onChange={e => update({ instanceType: e.target.value })}
          >
            {INSTANCE_PRESETS.map(i => (
              <option key={i.type} value={i.type}>{i.label}</option>
            ))}
          </select>
        </label>

        <label>
          Node Count: {config.nodeCount}
          <input
            type="range"
            min={1}
            max={200}
            value={config.nodeCount}
            onChange={e => update({ nodeCount: parseInt(e.target.value, 10) })}
          />
          <div className="preset-buttons">
            {NODE_PRESETS.map(p => (
              <button
                key={p.count}
                className={config.nodeCount === p.count ? 'active' : ''}
                onClick={() => update({ nodeCount: p.count })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </label>

        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={config.useSpot}
            onChange={e => update({ useSpot: e.target.checked })}
          />
          Use Spot Instances (up to 70% cost savings, may be interrupted)
        </label>
      </fieldset>

      {/* Cost Estimate */}
      <fieldset>
        <legend>Estimated Cost</legend>
        <div className="cost-estimate" role="status">
          <dl>
            <dt>Hourly cost ({config.useSpot ? 'spot estimate' : 'on-demand'})</dt>
            <dd>${(estimatedHourlyCost * spotDiscount).toFixed(2)}/hr</dd>
            <dt>5-minute run estimate</dt>
            <dd>${((estimatedHourlyCost * spotDiscount) / 12).toFixed(2)}</dd>
            <dt>1-hour run estimate</dt>
            <dd>${(estimatedHourlyCost * spotDiscount).toFixed(2)}</dd>
          </dl>
          <p className="help-text">
            Estimates are approximate. Actual costs depend on spot pricing, data transfer, and S3 storage.
          </p>
        </div>
      </fieldset>

      {/* Network Placement */}
      <fieldset>
        <legend>Network & Placement</legend>
        <label>
          Region
          <select
            value={config.region}
            onChange={e => update({ region: e.target.value })}
          >
            <option value="us-east-1">US East (N. Virginia)</option>
            <option value="us-west-2">US West (Oregon)</option>
            <option value="eu-west-1">EU (Ireland)</option>
            <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
          </select>
        </label>

        <label>
          Placement Group (optional)
          <input
            type="text"
            value={config.placementGroup || ''}
            onChange={e => update({ placementGroup: e.target.value || undefined })}
            placeholder="Leave empty for no placement group"
          />
          <span className="help-text">
            Use a cluster placement group for lowest-latency network between nodes.
            Required for accurate network-sensitive benchmarks.
          </span>
        </label>
      </fieldset>
    </div>
  );
};
