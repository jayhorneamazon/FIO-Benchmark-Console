/**
 * Analytics API handlers.
 * Queries completed runs from DynamoDB and computes aggregate/trend data.
 * For deep histogram analysis, fetches from S3.
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { BenchmarkRun } from '../../shared/types/benchmark-run';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const TABLE_NAME = process.env.TABLE_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * GET /analytics/summary
 * Returns aggregate stats across all completed runs for the dashboard overview cards.
 */
export async function getSummary(): Promise<APIGatewayProxyResultV2> {
  const runs = await getCompletedRuns();

  if (runs.length === 0) {
    return json(200, { totalRuns: 0, summary: null });
  }

  const withResults = runs.filter(r => r.results);

  const iopsValues = withResults.map(r => r.results!.totalIops);
  const bwValues = withResults.map(r => r.results!.totalBwKib);
  const p99Values = withResults.map(r => r.results!.latencyPercentiles.p99);

  return json(200, {
    totalRuns: runs.length,
    completedRuns: withResults.length,
    dateRange: {
      earliest: runs[runs.length - 1]?.createdAt,
      latest: runs[0]?.createdAt,
    },
    summary: {
      iops: { min: Math.min(...iopsValues), max: Math.max(...iopsValues), avg: avg(iopsValues) },
      bwKib: { min: Math.min(...bwValues), max: Math.max(...bwValues), avg: avg(bwValues) },
      p99Us: { min: Math.min(...p99Values), max: Math.max(...p99Values), avg: avg(p99Values) },
    },
    // Breakdown by workload type
    byWorkload: groupBy(withResults, r => r.config.fioJobs[0]?.rw || 'unknown', summarizeGroup),
    // Breakdown by NFS version
    byNfsVersion: groupBy(withResults, r => r.config.nfs.nfsVersion, summarizeGroup),
    // Breakdown by block size
    byBlockSize: groupBy(withResults, r => r.config.fioJobs[0]?.bs || 'unknown', summarizeGroup),
  });
}

/**
 * GET /analytics/trends?metric=iops|bw|p99&groupBy=nfsVersion|blockSize|workload&days=30
 * Returns time-series data for trend charts.
 */
export async function getTrends(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters || {};
  const metric = params.metric || 'iops';
  const group = params.groupBy || 'none';
  const days = parseInt(params.days || '90', 10);

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const runs = await getCompletedRuns(cutoff);
  const withResults = runs.filter(r => r.results);

  if (withResults.length === 0) {
    return json(200, { series: [] });
  }

  const extractMetric = (r: BenchmarkRun): number => {
    switch (metric) {
      case 'bw': return r.results!.totalBwKib;
      case 'p50': return r.results!.latencyPercentiles.p50;
      case 'p90': return r.results!.latencyPercentiles.p90;
      case 'p95': return r.results!.latencyPercentiles.p95;
      case 'p99': return r.results!.latencyPercentiles.p99;
      case 'p999': return r.results!.latencyPercentiles.p999;
      case 'iops':
      default: return r.results!.totalIops;
    }
  };

  const extractGroup = (r: BenchmarkRun): string => {
    switch (group) {
      case 'nfsVersion': return `v${r.config.nfs.nfsVersion}`;
      case 'blockSize': return r.config.fioJobs[0]?.bs || 'unknown';
      case 'workload': return r.config.fioJobs[0]?.rw || 'unknown';
      case 'instanceType': return r.config.infra.instanceType;
      case 'nodeCount': return `${r.config.infra.nodeCount} nodes`;
      default: return 'all';
    }
  };

  // Build series grouped by the selected dimension
  const grouped = new Map<string, Array<{ timestamp: string; value: number; runId: string; name: string }>>();

  for (const run of withResults) {
    const key = extractGroup(run);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push({
      timestamp: run.completedAt || run.createdAt,
      value: extractMetric(run),
      runId: run.runId,
      name: run.name,
    });
  }

  const series = Array.from(grouped.entries()).map(([name, points]) => ({
    name,
    points: points.sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  }));

  return json(200, { metric, groupBy: group, days, series });
}

/**
 * GET /analytics/histogram?runId=xxx
 * Fetches the full latency histogram from S3 for a specific run.
 * This is too large for DynamoDB so we stored it separately.
 */
export async function getHistogram(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const runId = event.queryStringParameters?.runId;
  if (!runId) return json(400, { error: 'runId is required' });

  // Look up the run to get the S3 prefix
  const runResult = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND SK = :sk',
    ExpressionAttributeValues: { ':pk': `RUN#${runId}`, ':sk': 'META' },
    ProjectionExpression: 'resultsS3Prefix',
  }));

  const run = runResult.Items?.[0];
  if (!run?.resultsS3Prefix) return json(404, { error: 'Run not found or no results' });

  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: RESULTS_BUCKET,
      Key: `${run.resultsS3Prefix}/aggregated.json`,
    }));
    const body = await obj.Body!.transformToString();
    const data = JSON.parse(body);
    return json(200, { runId, histogram: data.latencyHistogram || {} });
  } catch {
    return json(404, { error: 'Aggregated results not found in S3' });
  }
}

/**
 * POST /analytics/custom
 * Executes a custom analytics query against completed runs.
 * Supports filtering by tags, date range, config parameters, and selecting metrics.
 */
export async function customQuery(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body || '{}') as CustomQueryRequest;

  let runs = await getCompletedRuns(body.dateRange?.from);
  runs = runs.filter(r => r.results);

  // Apply filters
  if (body.dateRange?.to) {
    runs = runs.filter(r => r.createdAt <= body.dateRange!.to!);
  }
  if (body.filters?.tags?.length) {
    runs = runs.filter(r => body.filters!.tags!.some(t => r.tags.includes(t)));
  }
  if (body.filters?.nfsVersions?.length) {
    runs = runs.filter(r => body.filters!.nfsVersions!.includes(r.config.nfs.nfsVersion));
  }
  if (body.filters?.blockSizes?.length) {
    runs = runs.filter(r => body.filters!.blockSizes!.includes(r.config.fioJobs[0]?.bs));
  }
  if (body.filters?.workloads?.length) {
    runs = runs.filter(r => body.filters!.workloads!.includes(r.config.fioJobs[0]?.rw));
  }
  if (body.filters?.instanceTypes?.length) {
    runs = runs.filter(r => body.filters!.instanceTypes!.includes(r.config.infra.instanceType));
  }
  if (body.filters?.minNodes) {
    runs = runs.filter(r => r.config.infra.nodeCount >= body.filters!.minNodes!);
  }
  if (body.filters?.maxNodes) {
    runs = runs.filter(r => r.config.infra.nodeCount <= body.filters!.maxNodes!);
  }

  // Extract requested metrics
  const metrics = body.metrics || ['iops', 'bw', 'p99'];
  const xAxis = body.xAxis || 'time';

  const dataPoints = runs.map(r => {
    const point: Record<string, unknown> = {
      runId: r.runId,
      name: r.name,
      timestamp: r.completedAt || r.createdAt,
      tags: r.tags,
      nfsVersion: r.config.nfs.nfsVersion,
      blockSize: r.config.fioJobs[0]?.bs,
      workload: r.config.fioJobs[0]?.rw,
      nodeCount: r.config.infra.nodeCount,
      instanceType: r.config.infra.instanceType,
    };

    for (const m of metrics) {
      switch (m) {
        case 'iops': point.iops = r.results!.totalIops; break;
        case 'bw': point.bw = r.results!.totalBwKib; break;
        case 'p50': point.p50 = r.results!.latencyPercentiles.p50; break;
        case 'p90': point.p90 = r.results!.latencyPercentiles.p90; break;
        case 'p95': point.p95 = r.results!.latencyPercentiles.p95; break;
        case 'p99': point.p99 = r.results!.latencyPercentiles.p99; break;
        case 'p999': point.p999 = r.results!.latencyPercentiles.p999; break;
        case 'iopsPerNode': point.iopsPerNode = r.results!.totalIops / r.config.infra.nodeCount; break;
        case 'bwPerNode': point.bwPerNode = r.results!.totalBwKib / r.config.infra.nodeCount; break;
      }
    }

    // X-axis value
    switch (xAxis) {
      case 'nodeCount': point.x = r.config.infra.nodeCount; break;
      case 'blockSize': point.x = r.config.fioJobs[0]?.bs; break;
      case 'nfsVersion': point.x = r.config.nfs.nfsVersion; break;
      case 'time':
      default: point.x = r.completedAt || r.createdAt; break;
    }

    return point;
  });

  return json(200, {
    query: body,
    totalMatched: dataPoints.length,
    data: dataPoints,
  });
}

// --- Helpers ---

interface CustomQueryRequest {
  dateRange?: { from?: string; to?: string };
  filters?: {
    tags?: string[];
    nfsVersions?: string[];
    blockSizes?: string[];
    workloads?: string[];
    instanceTypes?: string[];
    minNodes?: number;
    maxNodes?: number;
  };
  metrics?: string[];
  xAxis?: 'time' | 'nodeCount' | 'blockSize' | 'nfsVersion';
}

async function getCompletedRuns(since?: string): Promise<BenchmarkRun[]> {
  const expressionValues: Record<string, string> = {
    ':pk': 'RUNS',
    ':completed': 'completed',
  };
  if (since) {
    expressionValues[':since'] = since;
  }

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: since
      ? 'GSI1PK = :pk AND GSI1SK >= :since'
      : 'GSI1PK = :pk',
    FilterExpression: '#s = :completed',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: expressionValues,
    ScanIndexForward: false,
  }));

  return (result.Items || []) as BenchmarkRun[];
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function summarizeGroup(runs: BenchmarkRun[]): {
  count: number;
  avgIops: number;
  avgBwKib: number;
  avgP99Us: number;
} {
  return {
    count: runs.length,
    avgIops: avg(runs.map(r => r.results!.totalIops)),
    avgBwKib: avg(runs.map(r => r.results!.totalBwKib)),
    avgP99Us: avg(runs.map(r => r.results!.latencyPercentiles.p99)),
  };
}

function groupBy<T, R>(
  items: T[],
  keyFn: (item: T) => string,
  reduceFn: (group: T[]) => R
): Record<string, R> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const result: Record<string, R> = {};
  for (const [key, group] of groups) {
    result[key] = reduceFn(group);
  }
  return result;
}
