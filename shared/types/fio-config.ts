/**
 * FIO job configuration types.
 * Maps the most impactful FIO parameters to a structured interface.
 */

export type FioRwPattern =
  | 'read' | 'write' | 'randread' | 'randwrite'
  | 'rw' | 'randrw' | 'trim' | 'randtrim' | 'trimwrite';

export type FioIoEngine =
  | 'psync' | 'libaio' | 'io_uring' | 'mmap'
  | 'sync' | 'pvsync' | 'pvsync2' | 'posixaio';

export type FioVerifyMethod =
  | 'md5' | 'crc32c' | 'crc32' | 'crc16' | 'crc64'
  | 'xxhash' | 'sha256' | 'sha512' | 'sha1' | 'pattern' | 'none';

export interface FioJobConfig {
  /** Job name identifier */
  name: string;

  /** I/O pattern */
  rw: FioRwPattern;

  /** Block size (e.g., '4k', '64k', '1m') */
  bs: string;

  /** I/O engine */
  ioengine: FioIoEngine;

  /** Queue depth per file */
  iodepth: number;

  /** Use direct (non-buffered) I/O. Recommended for benchmarking. */
  direct: boolean;

  /** Total file size per job (e.g., '1g', '10g') */
  size: string;

  /** Number of clones of this job (threads/processes) */
  numjobs: number;

  /** Runtime in seconds. Used with time_based. */
  runtime?: number;

  /** If true, loop the workload for the full runtime duration */
  timeBased?: boolean;

  /** Read percentage for mixed workloads (rw/randrw). Default 50. */
  rwmixread?: number;

  /** Number of files per job */
  nrfiles?: number;

  /** Individual file size (overrides size / nrfiles calculation) */
  filesize?: string;

  /** Target directory for test files */
  directory?: string;

  /** Percentage of I/O that is random (0-100). Default 100 for rand* patterns. */
  percentageRandom?: number;

  /** Verification method. Use for data integrity testing. */
  verify?: FioVerifyMethod;

  /** Group reporting across numjobs clones */
  groupReporting?: boolean;

  /** Rate cap in bytes/sec (e.g., '100m') */
  rate?: string;

  /** IOPS cap */
  rateIops?: number;

  /** Block size range for variable-size I/O (e.g., '4k-1m') */
  bsrange?: string;

  /** Weighted block size split (e.g., '4k/50:64k/30:1m/20') */
  bssplit?: string;

  /** Fallocate mode for file preallocation */
  fallocate?: 'none' | 'native' | 'posix' | 'keep' | 'truncate';

  /** Additional raw FIO parameters as key-value pairs */
  extraParams?: Record<string, string>;
}

export interface FioGlobalConfig {
  /** Output format */
  outputFormat: 'json+' | 'json' | 'normal' | 'terse';

  /** Status interval in seconds for progress reporting */
  statusInterval?: number;

  /** Write bandwidth log */
  writeBwLog?: string;

  /** Write latency log */
  writeLatLog?: string;

  /** Write IOPS log */
  writeIopsLog?: string;

  /** Log averaging window in milliseconds */
  logAvgMsec?: number;
}

/**
 * Generates a .fio job file string from config.
 */
export function buildJobFile(global: FioGlobalConfig, jobs: FioJobConfig[]): string {
  const lines: string[] = [];

  // Global section — only include options that are valid in job files.
  // output-format and status-interval are CLI-only flags passed via the fio command line.
  lines.push('[global]');
  if (global.writeBwLog) lines.push(`write_bw_log=${global.writeBwLog}`);
  if (global.writeLatLog) lines.push(`write_lat_log=${global.writeLatLog}`);
  if (global.writeIopsLog) lines.push(`write_iops_log=${global.writeIopsLog}`);
  if (global.logAvgMsec) lines.push(`log_avg_msec=${global.logAvgMsec}`);
  lines.push('');

  // Job sections
  for (const job of jobs) {
    lines.push(`[${job.name}]`);
    lines.push(`rw=${job.rw}`);
    lines.push(`bs=${job.bs}`);
    lines.push(`ioengine=${job.ioengine}`);
    lines.push(`iodepth=${job.iodepth}`);
    lines.push(`direct=${job.direct ? 1 : 0}`);
    lines.push(`size=${job.size}`);
    lines.push(`numjobs=${job.numjobs}`);

    if (job.runtime) {
      lines.push(`runtime=${job.runtime}`);
      if (job.timeBased !== false) lines.push('time_based');
    }

    if (job.rwmixread !== undefined) lines.push(`rwmixread=${job.rwmixread}`);
    if (job.nrfiles) lines.push(`nrfiles=${job.nrfiles}`);
    if (job.filesize) lines.push(`filesize=${job.filesize}`);
    if (job.directory) lines.push(`directory=${job.directory}`);
    if (job.percentageRandom !== undefined) lines.push(`percentage_random=${job.percentageRandom}`);
    if (job.verify && job.verify !== 'none') lines.push(`verify=${job.verify}`);
    if (job.groupReporting !== false) lines.push('group_reporting');
    if (job.rate) lines.push(`rate=${job.rate}`);
    if (job.rateIops) lines.push(`rate_iops=${job.rateIops}`);
    if (job.bsrange) lines.push(`bsrange=${job.bsrange}`);
    if (job.bssplit) lines.push(`bssplit=${job.bssplit}`);
    if (job.fallocate) lines.push(`fallocate=${job.fallocate}`);

    if (job.extraParams) {
      for (const [key, value] of Object.entries(job.extraParams)) {
        lines.push(`${key}=${value}`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates CLI arguments for options that cannot appear in job files.
 * These are passed directly to the fio command line.
 */
export function buildCliArgs(global: FioGlobalConfig): string {
  const args: string[] = [];
  args.push(`--output-format=${global.outputFormat}`);
  if (global.statusInterval) args.push(`--status-interval=${global.statusInterval}`);
  return args.join(' ');
}

/**
 * Generates a multi-export job file by splitting jobs across mount points.
 *
 * For multi-export comparison testing: takes the configured jobs and distributes
 * them across the given mount points. Each job's numjobs is divided evenly across
 * exports, with any remainder going to the first exports.
 *
 * Example: 1 job with numjobs=8 across 4 exports → 4 job sections, each with numjobs=2
 *
 * The directory for each split job is set to `<mountPoint>/fio-bench` as a placeholder.
 * The actual per-run/per-node path is overridden by the bootstrap script at runtime.
 *
 * @param global - FIO global config
 * @param jobs - Original job definitions
 * @param mountPoints - Array of mount point paths (one per export)
 * @returns Generated .fio job file content with per-export job sections
 */
export function buildMultiExportJobFile(
  global: FioGlobalConfig,
  jobs: FioJobConfig[],
  mountPoints: string[],
): string {
  if (mountPoints.length <= 1) {
    return buildJobFile(global, jobs);
  }

  const lines: string[] = [];

  // Global section
  lines.push('[global]');
  if (global.writeBwLog) lines.push(`write_bw_log=${global.writeBwLog}`);
  if (global.writeLatLog) lines.push(`write_lat_log=${global.writeLatLog}`);
  if (global.writeIopsLog) lines.push(`write_iops_log=${global.writeIopsLog}`);
  if (global.logAvgMsec) lines.push(`log_avg_msec=${global.logAvgMsec}`);
  lines.push('');

  // Split each job across exports
  for (const job of jobs) {
    const totalJobs = job.numjobs;
    const basePerExport = Math.floor(totalJobs / mountPoints.length);
    const remainder = totalJobs % mountPoints.length;

    for (let i = 0; i < mountPoints.length; i++) {
      const jobsForThisExport = basePerExport + (i < remainder ? 1 : 0);
      if (jobsForThisExport === 0) continue;

      const exportName = `${job.name}-export${i}`;
      const directory = `${mountPoints[i]}/fio-bench`;

      lines.push(`[${exportName}]`);
      lines.push(`rw=${job.rw}`);
      lines.push(`bs=${job.bs}`);
      lines.push(`ioengine=${job.ioengine}`);
      lines.push(`iodepth=${job.iodepth}`);
      lines.push(`direct=${job.direct ? 1 : 0}`);
      lines.push(`size=${job.size}`);
      lines.push(`numjobs=${jobsForThisExport}`);
      lines.push(`directory=${directory}`);

      if (job.runtime) {
        lines.push(`runtime=${job.runtime}`);
        if (job.timeBased !== false) lines.push('time_based');
      }

      if (job.rwmixread !== undefined) lines.push(`rwmixread=${job.rwmixread}`);
      if (job.nrfiles) lines.push(`nrfiles=${job.nrfiles}`);
      if (job.filesize) lines.push(`filesize=${job.filesize}`);
      if (job.percentageRandom !== undefined) lines.push(`percentage_random=${job.percentageRandom}`);
      if (job.verify && job.verify !== 'none') lines.push(`verify=${job.verify}`);
      if (job.groupReporting !== false) lines.push('group_reporting');
      if (job.rate) lines.push(`rate=${job.rate}`);
      if (job.rateIops) lines.push(`rate_iops=${job.rateIops}`);
      if (job.bsrange) lines.push(`bsrange=${job.bsrange}`);
      if (job.bssplit) lines.push(`bssplit=${job.bssplit}`);
      if (job.fallocate) lines.push(`fallocate=${job.fallocate}`);

      if (job.extraParams) {
        for (const [key, value] of Object.entries(job.extraParams)) {
          lines.push(`${key}=${value}`);
        }
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}
