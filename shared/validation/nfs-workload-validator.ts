/**
 * Validates NFS mount configuration against the FIO workload profile.
 * Produces warnings when the mount options are suboptimal for the workload.
 */

import { NfsMountConfig, NfsVersion } from '../types/nfs-config';
import { FioJobConfig } from '../types/fio-config';

export type Severity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  severity: Severity;
  field: string;
  message: string;
}

/** Parse a FIO size string (e.g., '4k', '1m', '64k') to bytes */
function parseSizeToBytes(size: string): number {
  const match = size.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m|g|t)?i?b?$/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'k': return num * 1024;
    case 'm': return num * 1024 * 1024;
    case 'g': return num * 1024 * 1024 * 1024;
    case 't': return num * 1024 * 1024 * 1024 * 1024;
    default: return num;
  }
}

function isSmallBlockWorkload(job: FioJobConfig): boolean {
  const bs = parseSizeToBytes(job.bs);
  return bs > 0 && bs <= 16384; // 16K or smaller
}

function isRandomWorkload(job: FioJobConfig): boolean {
  return job.rw.startsWith('rand');
}

function isWriteWorkload(job: FioJobConfig): boolean {
  return job.rw.includes('write') || job.rw === 'rw' || job.rw === 'randrw';
}

function isHighIodepth(job: FioJobConfig): boolean {
  return job.iodepth >= 16;
}

function isNfsV4Plus(version: NfsVersion): boolean {
  return version !== '3';
}

export function validateNfsWorkloadMatch(
  nfs: NfsMountConfig,
  jobs: FioJobConfig[]
): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const job of jobs) {
    const smallBlock = isSmallBlockWorkload(job);
    const random = isRandomWorkload(job);
    const writing = isWriteWorkload(job);
    const highDepth = isHighIodepth(job);

    // NFSv4.x with small random I/O — the key warning from the requirements
    if (smallBlock && random && isNfsV4Plus(nfs.nfsVersion)) {
      results.push({
        severity: 'warning',
        field: 'nfsVersion',
        message:
          `Job "${job.name}" uses small random I/O (bs=${job.bs}, rw=${job.rw}) but NFS version ` +
          `${nfs.nfsVersion} is selected. NFSv4.x compound operations add metadata overhead ` +
          `per I/O that is significant relative to small block sizes. Consider NFSv3 for ` +
          `this workload to reduce per-operation overhead.`,
      });
    }

    // NFSv4.2 specifically — highest metadata cost
    if (smallBlock && nfs.nfsVersion === '4.2') {
      results.push({
        severity: 'warning',
        field: 'nfsVersion',
        message:
          `NFSv4.2 has the highest per-operation metadata overhead of any NFS version. ` +
          `For small block I/O (bs=${job.bs}), this overhead can reduce IOPS by 15-25% ` +
          `compared to NFSv3.`,
      });
    }

    // rsize/wsize vs block size alignment
    const bsBytes = parseSizeToBytes(job.bs);
    if (nfs.rsize && bsBytes > nfs.rsize) {
      results.push({
        severity: 'warning',
        field: 'rsize',
        message:
          `Job "${job.name}" block size (${job.bs}) exceeds NFS rsize (${nfs.rsize} bytes). ` +
          `Each FIO read will require multiple NFS READ operations, increasing latency. ` +
          `Set rsize >= block size.`,
      });
    }
    if (nfs.wsize && bsBytes > nfs.wsize && writing) {
      results.push({
        severity: 'warning',
        field: 'wsize',
        message:
          `Job "${job.name}" block size (${job.bs}) exceeds NFS wsize (${nfs.wsize} bytes). ` +
          `Each FIO write will require multiple NFS WRITE operations. Set wsize >= block size.`,
      });
    }

    // UDP with large I/O — fragmentation risk
    if (nfs.transport === 'udp' && bsBytes > 8192) {
      results.push({
        severity: 'error',
        field: 'transport',
        message:
          `UDP transport with block size ${job.bs} will cause IP fragmentation, risking ` +
          `silent data corruption on high-speed links. Use TCP instead, or reduce block ` +
          `size to fit within MTU.`,
      });
    }

    // UDP with NFSv4 — not supported
    if (nfs.transport === 'udp' && isNfsV4Plus(nfs.nfsVersion)) {
      results.push({
        severity: 'error',
        field: 'transport',
        message: 'NFSv4 requires TCP transport. UDP is only supported with NFSv3.',
      });
    }

    // noac with high-throughput workloads — performance warning
    if (nfs.attributeCaching === false && !smallBlock) {
      results.push({
        severity: 'info',
        field: 'attributeCaching',
        message:
          `noac (no attribute caching) is enabled. This forces synchronous writes and ` +
          `per-operation attribute checks. For throughput-oriented workloads this can ` +
          `reduce performance by 30-50%. Only use noac for coherence or integrity testing.`,
      });
    }

    // soft mount with write workloads — data risk
    if ((nfs.mountHardness === 'soft' || nfs.mountHardness === 'softerr') && writing) {
      results.push({
        severity: 'warning',
        field: 'mountHardness',
        message:
          `Soft mounts with write workloads risk silent data loss. If a timeout occurs, ` +
          `writes may be silently dropped. Use hard mounts for write benchmarks unless ` +
          `testing timeout behavior specifically.`,
      });
    }

    // nconnect recommendation for high-throughput
    if (!nfs.nconnect || nfs.nconnect <= 1) {
      if (!smallBlock && highDepth && job.numjobs >= 4) {
        results.push({
          severity: 'info',
          field: 'nconnect',
          message:
            `Job "${job.name}" has high concurrency (numjobs=${job.numjobs}, iodepth=${job.iodepth}) ` +
            `but nconnect is not set. A single TCP connection may bottleneck throughput. ` +
            `Consider nconnect=4-8 for multi-stream workloads.`,
        });
      }
    }

    // direct=false with verify — cache coherence risk
    if (!job.direct && job.verify && job.verify !== 'none') {
      results.push({
        severity: 'warning',
        field: 'direct',
        message:
          `Job "${job.name}" uses buffered I/O with verification. NFS client caching may ` +
          `cause verify to read stale cached data instead of what's on the server. ` +
          `Use direct=1 for reliable verification over NFS.`,
      });
    }
  }

  return results;
}
