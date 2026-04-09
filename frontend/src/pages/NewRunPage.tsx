import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { NfsMountConfigurator } from '../components/NfsMountConfigurator';
import { FioJobConfigurator } from '../components/FioJobConfigurator';
import { InfraConfigurator } from '../components/InfraConfigurator';
import { NfsMountConfig } from '@shared/types/nfs-config';
import { FioJobConfig, FioGlobalConfig } from '@shared/types/fio-config';
import { InfraConfig, BenchmarkRunConfig } from '@shared/types/benchmark-run';
import { WorkloadPreset } from '@shared/types/presets';
import { validateNfsWorkloadMatch, ValidationResult } from '@shared/validation/nfs-workload-validator';
import { api, ApiError } from '../lib/api';

type Step = 'nfs' | 'workload' | 'infra' | 'review';
const STEPS: { key: Step; label: string }[] = [
  { key: 'nfs', label: 'NFS Mount' },
  { key: 'workload', label: 'Workload' },
  { key: 'infra', label: 'Infrastructure' },
  { key: 'review', label: 'Review & Launch' },
];

const DEFAULT_NFS: NfsMountConfig = {
  server: '',
  exportPath: '/export/benchmark',
  mountPoint: '/mnt/benchmark',
  nfsVersion: '3',
  transport: 'tcp',
  rsize: 1048576,
  wsize: 1048576,
  mountHardness: 'hard',
  attributeCaching: true,
  lock: false,
};

const DEFAULT_JOB: FioJobConfig = {
  name: 'benchmark',
  rw: 'randread',
  bs: '4k',
  ioengine: 'libaio',
  iodepth: 32,
  direct: true,
  size: '1g',
  numjobs: 4,
  runtime: 300,
  timeBased: true,
  groupReporting: true,
};

const DEFAULT_GLOBAL: FioGlobalConfig = {
  outputFormat: 'json+',
  statusInterval: 5,
  writeBwLog: 'benchmark',
  writeLatLog: 'benchmark',
  writeIopsLog: 'benchmark',
  logAvgMsec: 1000,
};

const DEFAULT_INFRA: InfraConfig = {
  instanceType: 'c5.xlarge',
  nodeCount: 5,
  region: 'us-east-1',
  subnetIds: [],
  securityGroupIds: [],
  useSpot: true,
};

export const NewRunPage: React.FC = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('nfs');
  const [runName, setRunName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [nfsConfig, setNfsConfig] = useState<NfsMountConfig>(DEFAULT_NFS);
  const [fioJobs, setFioJobs] = useState<FioJobConfig[]>([DEFAULT_JOB]);
  const [fioGlobal, setFioGlobal] = useState<FioGlobalConfig>(DEFAULT_GLOBAL);
  const [infraConfig, setInfraConfig] = useState<InfraConfig>(DEFAULT_INFRA);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [apiWarnings, setApiWarnings] = useState<ValidationResult[]>([]);

  // Live validation
  const validationWarnings = useMemo(
    () => validateNfsWorkloadMatch(nfsConfig, fioJobs),
    [nfsConfig, fioJobs]
  );

  const validationErrors = validationWarnings.filter(w => w.severity === 'error');
  const canProceed = validationErrors.length === 0;

  const handlePresetApplied = (preset: WorkloadPreset) => {
    // Apply the preset's NFS recommendations
    setNfsConfig(prev => ({ ...prev, ...preset.nfsRecommendations }));
  };

  const currentStepIndex = STEPS.findIndex(s => s.key === step);

  const goNext = () => {
    const next = STEPS[currentStepIndex + 1];
    if (next) setStep(next.key);
  };

  const goBack = () => {
    const prev = STEPS[currentStepIndex - 1];
    if (prev) setStep(prev.key);
  };

  const handleSubmit = async () => {
    if (!runName.trim()) {
      setSubmitError('Run name is required');
      return;
    }
    if (!nfsConfig.server.trim()) {
      setSubmitError('NFS server address is required');
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    const config: BenchmarkRunConfig = {
      nfs: nfsConfig,
      fioGlobal: fioGlobal,
      fioJobs: fioJobs,
      infra: infraConfig,
    };

    try {
      const result = await api.createRun({
        name: runName.trim(),
        description: description.trim() || undefined,
        tags: tags.split(',').map(t => t.trim()).filter(Boolean),
        config,
      });
      setApiWarnings(result.validationWarnings);
      navigate(`/runs/${result.run.runId}`);
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
        if (err.validationErrors) {
          setApiWarnings(err.validationErrors);
        }
      } else {
        setSubmitError('Failed to create run');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="new-run-page">
      <h2>New Benchmark Run</h2>

      {/* Step indicator */}
      <nav className="step-nav" aria-label="Configuration steps">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            className={`step-btn ${step === s.key ? 'active' : ''} ${i < currentStepIndex ? 'completed' : ''}`}
            onClick={() => setStep(s.key)}
          >
            <span className="step-number">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </nav>

      {/* Validation banner */}
      {validationErrors.length > 0 && (
        <div className="validation-banner error" role="alert">
          {validationErrors.map((e, i) => <p key={i}>{e.message}</p>)}
        </div>
      )}
      {validationWarnings.filter(w => w.severity === 'warning').length > 0 && (
        <div className="validation-banner warning" role="status">
          {validationWarnings.filter(w => w.severity === 'warning').map((w, i) => (
            <p key={i}>{w.message}</p>
          ))}
        </div>
      )}

      {/* Step content */}
      <div className="step-content">
        {step === 'nfs' && (
          <NfsMountConfigurator
            config={nfsConfig}
            onChange={setNfsConfig}
            warnings={validationWarnings}
          />
        )}

        {step === 'workload' && (
          <FioJobConfigurator
            jobs={fioJobs}
            globalConfig={fioGlobal}
            nfsConfig={nfsConfig}
            onJobsChange={setFioJobs}
            onGlobalChange={setFioGlobal}
            onPresetApplied={handlePresetApplied}
          />
        )}

        {step === 'infra' && (
          <InfraConfigurator config={infraConfig} onChange={setInfraConfig} />
        )}

        {step === 'review' && (
          <div className="review-step">
            <fieldset>
              <legend>Run Details</legend>
              <label>
                Run Name (required)
                <input
                  type="text"
                  value={runName}
                  onChange={e => setRunName(e.target.value)}
                  placeholder="e.g., baseline-nfsv3-4k-randread"
                />
              </label>
              <label>
                Description
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={3}
                  placeholder="Optional notes about this benchmark run"
                />
              </label>
              <label>
                Tags (comma-separated)
                <input
                  type="text"
                  value={tags}
                  onChange={e => setTags(e.target.value)}
                  placeholder="e.g., baseline, nfsv3, pre-migration"
                />
              </label>
            </fieldset>

            <fieldset>
              <legend>Configuration Summary</legend>
              <dl className="config-summary">
                <dt>NFS Target</dt>
                <dd>{nfsConfig.server}:{nfsConfig.exportPath} (v{nfsConfig.nfsVersion})</dd>
                <dt>Workload</dt>
                <dd>{fioJobs[0]?.rw} bs={fioJobs[0]?.bs} iodepth={fioJobs[0]?.iodepth} x{fioJobs[0]?.numjobs} jobs</dd>
                <dt>Runtime</dt>
                <dd>{fioJobs[0]?.runtime}s</dd>
                <dt>Infrastructure</dt>
                <dd>{infraConfig.nodeCount}x {infraConfig.instanceType} {infraConfig.useSpot ? '(spot)' : '(on-demand)'}</dd>
                <dt>Mount Options</dt>
                <dd>rsize={nfsConfig.rsize}, wsize={nfsConfig.wsize}, nconnect={nfsConfig.nconnect || 1}</dd>
              </dl>
            </fieldset>

            {submitError && (
              <div className="validation-banner error" role="alert">{submitError}</div>
            )}
          </div>
        )}
      </div>

      {/* Navigation buttons */}
      <div className="step-actions">
        {currentStepIndex > 0 && (
          <button onClick={goBack} className="btn btn-secondary">Back</button>
        )}
        <div className="step-actions-right">
          {step !== 'review' ? (
            <button onClick={goNext} className="btn btn-primary" disabled={!canProceed}>
              Next
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              className="btn btn-primary"
              disabled={submitting || !canProceed || !runName.trim()}
            >
              {submitting ? 'Launching...' : 'Launch Benchmark'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
