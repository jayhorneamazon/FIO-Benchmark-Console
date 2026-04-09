/**
 * Workload presets that pair FIO configs with recommended NFS mount options.
 *
 * The key insight: NFS mount options must match the workload profile.
 * Using NFSv4.2 for small random I/O adds unnecessary metadata overhead
 * per operation. Conversely, large sequential workloads benefit from
 * v4.2's server-side copy and larger default rsize/wsize negotiation.
 */

import { NfsMountConfig, NfsVersion } from './nfs-config';
import { FioJobConfig } from './fio-config';

export interface WorkloadPreset {
  id: string;
  name: string;
  description: string;
  category: 'hpc' | 'throughput' | 'mixed' | 'integrity' | 'custom';

  /** Recommended NFS mount option overrides for this workload */
  nfsRecommendations: Partial<NfsMountConfig>;

  /** FIO job configuration */
  fioJob: Omit<FioJobConfig, 'name' | 'directory'>;

  /** Explanation of why these NFS options are recommended */
  nfsRationale: string;

  /** Warnings about NFS version mismatches */
  versionWarnings: Record<NfsVersion, string | null>;
}

/**
 * Built-in workload presets.
 */
export const WORKLOAD_PRESETS: WorkloadPreset[] = [
  {
    id: 'hpc-small-random',
    name: 'HPC Small Random I/O',
    description: 'Small block random read/write typical of HPC metadata-heavy workloads',
    category: 'hpc',
    nfsRecommendations: {
      nfsVersion: '3',
      transport: 'tcp',
      rsize: 65536,
      wsize: 65536,
      attributeCaching: true,
      acregmin: 0,
      acregmax: 0,
      lock: false,
      cto: false,
    },
    fioJob: {
      rw: 'randrw',
      bs: '4k',
      ioengine: 'libaio',
      iodepth: 32,
      direct: true,
      size: '1g',
      numjobs: 8,
      runtime: 300,
      timeBased: true,
      rwmixread: 70,
      groupReporting: true,
    },
    nfsRationale:
      'NFSv3 is recommended for small random I/O because each NFS operation ' +
      'in v4.x carries additional compound operation overhead and session ' +
      'management metadata. For 4K random I/O, this per-op overhead is a ' +
      'significant fraction of the total operation cost. nolock removes NLM ' +
      'sideband protocol overhead. nocto avoids unnecessary GETATTR calls on open. ' +
      'Small rsize/wsize (64K) avoids wasting network bandwidth on partially-filled frames.',
    versionWarnings: {
      '3': null,
      '4': 'NFSv4.0 adds ~20% metadata overhead per operation vs v3 for small I/O patterns.',
      '4.0': 'NFSv4.0 adds ~20% metadata overhead per operation vs v3 for small I/O patterns.',
      '4.1': 'NFSv4.1 session overhead further increases per-op cost for small random I/O.',
      '4.2': 'NFSv4.2 has the highest per-op metadata cost. Not recommended for small random I/O workloads.',
    },
  },
  {
    id: 'large-sequential-write',
    name: 'Large Sequential Write',
    description: 'High-throughput sequential writes with large block sizes',
    category: 'throughput',
    nfsRecommendations: {
      nfsVersion: '4.1',
      transport: 'tcp',
      rsize: 1048576,
      wsize: 1048576,
      nconnect: 4,
      attributeCaching: true,
      lock: false,
    },
    fioJob: {
      rw: 'write',
      bs: '1m',
      ioengine: 'libaio',
      iodepth: 16,
      direct: true,
      size: '10g',
      numjobs: 4,
      runtime: 300,
      timeBased: true,
      groupReporting: true,
      fallocate: 'none',
    },
    nfsRationale:
      'Large sequential writes benefit from maximum rsize/wsize (1MB) to fill ' +
      'network frames efficiently. nconnect=4 spreads load across multiple TCP ' +
      'connections, important when a single TCP stream cannot saturate the link. ' +
      'NFSv4.1 sessions reduce the overhead of compound operations for large I/O ' +
      'and support pNFS for parallel data access. The per-op metadata cost is ' +
      'amortized over the large block size.',
    versionWarnings: {
      '3': 'NFSv3 works but lacks session trunking. Consider nconnect for throughput.',
      '4': null,
      '4.0': null,
      '4.1': null,
      '4.2': null,
    },
  },
  {
    id: 'large-sequential-read',
    name: 'Large Sequential Read',
    description: 'High-throughput sequential reads for data pipeline workloads',
    category: 'throughput',
    nfsRecommendations: {
      nfsVersion: '4.1',
      transport: 'tcp',
      rsize: 1048576,
      wsize: 1048576,
      nconnect: 4,
      rdirplus: true,
      lock: false,
    },
    fioJob: {
      rw: 'read',
      bs: '1m',
      ioengine: 'libaio',
      iodepth: 16,
      direct: true,
      size: '10g',
      numjobs: 4,
      runtime: 300,
      timeBased: true,
      groupReporting: true,
    },
    nfsRationale:
      'Sequential reads with large blocks maximize throughput. Max rsize ensures ' +
      'each READ request carries a full 1MB payload. nconnect parallelizes across ' +
      'TCP connections. rdirplus prefetches directory attributes for workloads that ' +
      'scan directories before reading files.',
    versionWarnings: {
      '3': null,
      '4': null,
      '4.0': null,
      '4.1': null,
      '4.2': null,
    },
  },
  {
    id: 'mixed-workload',
    name: 'Mixed Application Workload',
    description: 'Simulates typical application I/O with mixed sizes and patterns',
    category: 'mixed',
    nfsRecommendations: {
      nfsVersion: '4.0',
      transport: 'tcp',
      rsize: 262144,
      wsize: 262144,
      nconnect: 2,
      attributeCaching: true,
      acregmin: 3,
      acregmax: 30,
    },
    fioJob: {
      rw: 'randrw',
      bs: '4k',
      ioengine: 'libaio',
      iodepth: 16,
      direct: true,
      size: '4g',
      numjobs: 4,
      runtime: 300,
      timeBased: true,
      rwmixread: 60,
      bssplit: '4k/40:64k/35:256k/15:1m/10',
      groupReporting: true,
    },
    nfsRationale:
      'Mixed workloads need a balanced NFS configuration. NFSv4.0 provides a ' +
      'reasonable tradeoff between metadata efficiency and features. Moderate ' +
      'rsize/wsize (256K) handles both small and large I/O without waste. ' +
      'Reduced acregmax (30s) balances cache freshness with performance.',
    versionWarnings: {
      '3': null,
      '4': null,
      '4.0': null,
      '4.1': null,
      '4.2': null,
    },
  },
  {
    id: 'data-integrity',
    name: 'Data Integrity Verification',
    description: 'Write-then-verify workload for testing data correctness over NFS',
    category: 'integrity',
    nfsRecommendations: {
      nfsVersion: '3',
      transport: 'tcp',
      rsize: 1048576,
      wsize: 1048576,
      mountHardness: 'hard',
      attributeCaching: false,
      lock: false,
    },
    fioJob: {
      rw: 'randwrite',
      bs: '64k',
      ioengine: 'libaio',
      iodepth: 8,
      direct: true,
      size: '2g',
      numjobs: 4,
      runtime: 600,
      timeBased: true,
      verify: 'crc32c',
      groupReporting: true,
    },
    nfsRationale:
      'Data integrity testing requires hard mounts to prevent silent failures. ' +
      'noac ensures every read goes to the server for fresh data, critical for ' +
      'verify passes. NFSv3 avoids v4 delegation which could mask stale cache reads. ' +
      'nolock prevents NLM interference with the verify pattern.',
    versionWarnings: {
      '3': null,
      '4': 'NFSv4 delegations may cache data locally, potentially masking server-side corruption.',
      '4.0': 'NFSv4 delegations may cache data locally, potentially masking server-side corruption.',
      '4.1': 'NFSv4.1 delegations may cache data locally, potentially masking server-side corruption.',
      '4.2': 'NFSv4.2 delegations may cache data locally, potentially masking server-side corruption.',
    },
  },
];
