/**
 * NFS mount configuration types.
 *
 * Mount options directly affect benchmark results. For example:
 * - NFSv3 has lower metadata overhead than v4.x, better for small random I/O (HPC workloads)
 * - NFSv4.2 adds server-side copy and sparse file support but increases per-op metadata cost
 * - rsize/wsize control network payload sizes and must align with workload block sizes
 * - 'noac' disables attribute caching for coherence at the cost of performance
 * - 'nconnect' enables multiple TCP connections for higher aggregate throughput
 */

export type NfsVersion = '3' | '4' | '4.0' | '4.1' | '4.2';

export type NfsTransport = 'tcp' | 'tcp6' | 'udp' | 'udp6' | 'rdma' | 'rdma6';

export type NfsMountHardness = 'hard' | 'soft' | 'softerr';

export type NfsSecurityFlavor = 'sys' | 'krb5' | 'krb5i' | 'krb5p' | 'none';

/**
 * Mount mode controls how FIO jobs are distributed across NFS exports.
 * - 'single': All jobs target one export (default, backwards-compatible)
 * - 'multi-export': Jobs are spread across multiple exports from the same server.
 *   Useful for testing whether parallelizing across exports improves throughput.
 */
export type NfsMountMode = 'single' | 'multi-export';

/**
 * An additional NFS export path to mount alongside the primary export.
 * Inherits all mount options from the parent NfsMountConfig.
 */
export interface NfsAdditionalExport {
  /** Export path on the server (e.g., /export/vol2) */
  exportPath: string;

  /** Local mount point. Auto-generated if not specified. */
  mountPoint?: string;
}

export interface NfsMountConfig {
  /** NFS server hostname or IP */
  server: string;

  /** Exported path on the server (primary export) */
  exportPath: string;

  /** Local mount point on worker nodes (primary mount) */
  mountPoint: string;

  /**
   * Mount mode: single export or multiple exports.
   * When 'multi-export', FIO jobs are distributed across all exports.
   * Default: 'single'
   */
  mountMode?: NfsMountMode;

  /**
   * Additional exports from the same server for multi-export testing.
   * Only used when mountMode is 'multi-export'.
   */
  additionalExports?: NfsAdditionalExport[];

  /** NFS protocol version */
  nfsVersion: NfsVersion;

  /** Transport protocol. TCP is default and recommended. UDP only for v3. */
  transport?: NfsTransport;

  /** Max bytes per READ request (1024-1048576). Align with FIO rsize for best results. */
  rsize?: number;

  /** Max bytes per WRITE request (1024-1048576). Align with FIO wsize for best results. */
  wsize?: number;

  /** hard/soft/softerr mount behavior on timeout */
  mountHardness?: NfsMountHardness;

  /** Timeout in deciseconds (tenths of a second) before retransmit */
  timeo?: number;

  /** Number of retransmissions before further recovery */
  retrans?: number;

  /** Enable attribute caching (default true). Set false (noac) for coherence testing. */
  attributeCaching?: boolean;

  /** Min seconds to cache regular file attributes (default 3) */
  acregmin?: number;

  /** Max seconds to cache regular file attributes (default 60) */
  acregmax?: number;

  /** Min seconds to cache directory attributes (default 30) */
  acdirmin?: number;

  /** Max seconds to cache directory attributes (default 60) */
  acdirmax?: number;

  /** Number of TCP connections to server (1-16). Useful for multi-NIC setups. */
  nconnect?: number;

  /** Security flavor */
  sec?: NfsSecurityFlavor;

  /** Use close-to-open cache coherence (default true) */
  cto?: boolean;

  /** Use NLM locking (v3 only). Disable for benchmarks that don't need locks. */
  lock?: boolean;

  /** Use READDIRPLUS for directory reads (v3/v4) */
  rdirplus?: boolean;

  /** Additional raw mount options string for anything not covered above */
  extraOptions?: string;
}

/**
 * Generates the mount command string from config.
 * Example output: mount -t nfs -o nfsvers=3,tcp,rsize=1048576,wsize=1048576,hard,nolock server:/export /mnt/benchmark
 */
export function buildMountCommand(config: NfsMountConfig): string {
  const opts: string[] = [];

  opts.push(`nfsvers=${config.nfsVersion}`);

  if (config.transport) {
    // For v2/v3, proto= is used. For v4, only tcp/rdma variants are valid.
    if (config.nfsVersion === '3') {
      opts.push(`proto=${config.transport}`);
    } else {
      opts.push(config.transport);
    }
  }

  if (config.rsize) opts.push(`rsize=${config.rsize}`);
  if (config.wsize) opts.push(`wsize=${config.wsize}`);

  if (config.mountHardness) {
    opts.push(config.mountHardness);
  }

  if (config.timeo !== undefined) opts.push(`timeo=${config.timeo}`);
  if (config.retrans !== undefined) opts.push(`retrans=${config.retrans}`);

  if (config.attributeCaching === false) {
    opts.push('noac');
  } else {
    if (config.acregmin !== undefined) opts.push(`acregmin=${config.acregmin}`);
    if (config.acregmax !== undefined) opts.push(`acregmax=${config.acregmax}`);
    if (config.acdirmin !== undefined) opts.push(`acdirmin=${config.acdirmin}`);
    if (config.acdirmax !== undefined) opts.push(`acdirmax=${config.acdirmax}`);
  }

  if (config.nconnect && config.nconnect > 1) {
    opts.push(`nconnect=${config.nconnect}`);
  }

  if (config.sec) opts.push(`sec=${config.sec}`);

  if (config.cto === false) opts.push('nocto');

  if (config.lock === false) opts.push('nolock');

  if (config.rdirplus === false) opts.push('nordirplus');

  if (config.extraOptions) opts.push(config.extraOptions);

  const optString = opts.join(',');
  return `mount -t nfs -o ${optString} ${config.server}:${config.exportPath} ${config.mountPoint}`;
}

/**
 * Returns the mount options string (without server, export, or mount point).
 * Used internally for building consistent mount commands across all exports.
 */
function buildMountOptions(config: NfsMountConfig): string {
  const opts: string[] = [];

  opts.push(`nfsvers=${config.nfsVersion}`);

  if (config.transport) {
    if (config.nfsVersion === '3') {
      opts.push(`proto=${config.transport}`);
    } else {
      opts.push(config.transport);
    }
  }

  if (config.rsize) opts.push(`rsize=${config.rsize}`);
  if (config.wsize) opts.push(`wsize=${config.wsize}`);

  if (config.mountHardness) {
    opts.push(config.mountHardness);
  }

  if (config.timeo !== undefined) opts.push(`timeo=${config.timeo}`);
  if (config.retrans !== undefined) opts.push(`retrans=${config.retrans}`);

  if (config.attributeCaching === false) {
    opts.push('noac');
  } else {
    if (config.acregmin !== undefined) opts.push(`acregmin=${config.acregmin}`);
    if (config.acregmax !== undefined) opts.push(`acregmax=${config.acregmax}`);
    if (config.acdirmin !== undefined) opts.push(`acdirmin=${config.acdirmin}`);
    if (config.acdirmax !== undefined) opts.push(`acdirmax=${config.acdirmax}`);
  }

  if (config.nconnect && config.nconnect > 1) {
    opts.push(`nconnect=${config.nconnect}`);
  }

  if (config.sec) opts.push(`sec=${config.sec}`);
  if (config.cto === false) opts.push('nocto');
  if (config.lock === false) opts.push('nolock');
  if (config.rdirplus === false) opts.push('nordirplus');
  if (config.extraOptions) opts.push(config.extraOptions);

  return opts.join(',');
}

/**
 * Returns all mount commands for the configuration.
 * For 'single' mode, returns a single-element array.
 * For 'multi-export' mode, returns one command per export (primary + additional).
 */
export function buildAllMountCommands(config: NfsMountConfig): string[] {
  const optString = buildMountOptions(config);
  const commands: string[] = [];

  // Primary mount
  commands.push(`mount -t nfs -o ${optString} ${config.server}:${config.exportPath} ${config.mountPoint}`);

  // Additional exports (only in multi-export mode)
  if (config.mountMode === 'multi-export' && config.additionalExports) {
    for (let i = 0; i < config.additionalExports.length; i++) {
      const exp = config.additionalExports[i];
      const mountPoint = exp.mountPoint || `${config.mountPoint}-${i + 1}`;
      commands.push(`mount -t nfs -o ${optString} ${config.server}:${exp.exportPath} ${mountPoint}`);
    }
  }

  return commands;
}

/**
 * Returns all mount points for the configuration.
 * Useful for distributing FIO jobs across directories.
 */
export function getAllMountPoints(config: NfsMountConfig): string[] {
  const points: string[] = [config.mountPoint];

  if (config.mountMode === 'multi-export' && config.additionalExports) {
    for (let i = 0; i < config.additionalExports.length; i++) {
      const exp = config.additionalExports[i];
      points.push(exp.mountPoint || `${config.mountPoint}-${i + 1}`);
    }
  }

  return points;
}
