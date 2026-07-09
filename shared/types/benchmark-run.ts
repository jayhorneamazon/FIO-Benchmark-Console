/**
 * Benchmark run types — the core domain model for a complete test execution.
 */

import { NfsMountConfig } from './nfs-config';
import { FioJobConfig, FioGlobalConfig } from './fio-config';

export type RunStatus =
  | 'pending'      // Created, not yet launched
  | 'scaling'      // ASG scaling up
  | 'mounting'     // Workers mounting NFS
  | 'running'      // FIO executing
  | 'collecting'   // Gathering results from workers
  | 'aggregating'  // Merging results across nodes
  | 'completed'    // Done successfully
  | 'failed'       // Error occurred
  | 'cancelled';   // User cancelled

export interface InfraConfig {
  /** EC2 instance type for worker nodes */
  instanceType: string;

  /** Number of worker nodes (ASG desired capacity) */
  nodeCount: number;

  /** AWS region */
  region: string;

  /** Subnet IDs for worker placement */
  subnetIds: string[];

  /** Security group IDs */
  securityGroupIds: string[];

  /** Use spot instances for cost savings */
  useSpot: boolean;

  /** Placement group for network-sensitive tests */
  placementGroup?: string;

  /** AMI ID (if not using default) */
  amiId?: string;
}

export interface BenchmarkRunConfig {
  /** NFS mount configuration */
  nfs: NfsMountConfig;

  /** FIO global settings */
  fioGlobal: FioGlobalConfig;

  /** FIO job definitions (one or more) */
  fioJobs: FioJobConfig[];

  /** Infrastructure settings */
  infra: InfraConfig;
}

export interface NodeStatus {
  nodeId: string;
  instanceId: string;
  privateIp: string;
  status: 'pending' | 'mounting' | 'running' | 'completed' | 'failed';
  startedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  error?: string;
  /** EC2 instance state: pending, running, shutting-down, terminated, stopping, stopped */
  ec2State?: string;
  /** EC2 status checks: initializing, ok, or detailed status */
  ec2StatusCheck?: string;
  /** EC2 instance launch time */
  launchTime?: string;
}

export interface AggregatedMetrics {
  /** Total IOPS across all nodes (sum) */
  totalIops: number;

  /** Total bandwidth in KiB/s across all nodes (sum) */
  totalBwKib: number;

  /** Merged latency percentiles in microseconds */
  latencyPercentiles: {
    p50: number;
    p90: number;
    p95: number;
    p99: number;
    p999: number;
  };

  /** Merged latency histogram bins: { latencyNs: count } */
  latencyHistogram: Record<string, number>;

  /** Per-node IOPS for distribution analysis */
  perNodeIops: number[];

  /** Per-node bandwidth for distribution analysis */
  perNodeBwKib: number[];
}

export interface BenchmarkRun {
  /** Unique run identifier */
  runId: string;

  /** User-defined name for this run */
  name: string;

  /** Optional description */
  description?: string;

  /** User-defined tags for filtering and comparison */
  tags: string[];

  /** Current status */
  status: RunStatus;

  /** Full configuration used for this run */
  config: BenchmarkRunConfig;

  /** Generated .fio job file content */
  jobFileContent: string;

  /** Generated mount command (primary, for backwards compatibility) */
  mountCommand: string;

  /** All mount commands (primary + additional exports). Present when mountMode is 'multi-export'. */
  mountCommands?: string[];

  /** Per-node status tracking */
  nodes: NodeStatus[];

  /** Aggregated results (populated after completion) */
  results?: AggregatedMetrics;

  /** S3 prefix where raw results are stored */
  resultsS3Prefix: string;

  /** Timestamps */
  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  /** Error message if failed */
  error?: string;

  /** Estimated cost in USD */
  estimatedCost?: number;

  /** User who initiated the run */
  createdBy: string;
}
