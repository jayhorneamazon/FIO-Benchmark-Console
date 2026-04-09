/**
 * Lambda that aggregates FIO json+ results from all worker nodes.
 * Triggered after all nodes report completion.
 *
 * Key insight: latency percentiles cannot be averaged across nodes.
 * We must merge the raw histogram bins and recompute percentiles
 * from the combined distribution.
 */

import { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { AggregatedMetrics } from '../../shared/types/benchmark-run';

const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;

interface FioJsonPlusResult {
  jobs: FioJobResult[];
}

interface FioJobResult {
  jobname: string;
  read: FioDirectionResult;
  write: FioDirectionResult;
}

interface FioDirectionResult {
  iops: number;
  bw: number; // KiB/s
  clat_ns: {
    mean: number;
    percentile: Record<string, number>;
    bins: Record<string, number>;
  };
  lat_ns: {
    mean: number;
  };
}

export interface AggregateEvent {
  runId: string;
  resultsS3Prefix: string;
}

export async function handler(event: AggregateEvent): Promise<AggregatedMetrics> {
  const { runId, resultsS3Prefix } = event;

  // List all node result files
  const listResult = await s3.send(new ListObjectsV2Command({
    Bucket: RESULTS_BUCKET,
    Prefix: `${resultsS3Prefix}/`,
    Delimiter: '/',
  }));

  const resultKeys = (listResult.Contents || [])
    .map(obj => obj.Key!)
    .filter(key => key.endsWith('.json') && !key.endsWith('aggregated.json'));

  if (resultKeys.length === 0) {
    throw new Error(`No result files found at ${resultsS3Prefix}/`);
  }

  // Fetch and parse all results
  // FIO with --status-interval writes multiple JSON documents to the output file.
  // Each status interval produces a complete JSON object, and the final result is the last one.
  // We need to extract and parse only the last JSON object from each file.
  const nodeResults: FioJsonPlusResult[] = [];
  for (const key of resultKeys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: key }));
    const body = await obj.Body!.transformToString();
    const parsed = parseLastJsonObject(body);
    if (parsed) {
      nodeResults.push(parsed);
    }
  }

  // Aggregate across all nodes
  const mergedHistogram: Record<string, number> = {};
  const perNodeIops: number[] = [];
  const perNodeBwKib: number[] = [];
  let totalIops = 0;
  let totalBwKib = 0;

  for (const result of nodeResults) {
    for (const job of result.jobs) {
      // Sum read + write for each node
      const nodeIops = (job.read?.iops || 0) + (job.write?.iops || 0);
      const nodeBw = (job.read?.bw || 0) + (job.write?.bw || 0);

      totalIops += nodeIops;
      totalBwKib += nodeBw;
      perNodeIops.push(nodeIops);
      perNodeBwKib.push(nodeBw);

      // Merge histogram bins from both directions
      for (const direction of [job.read, job.write]) {
        if (!direction?.clat_ns?.bins) continue;
        for (const [bucket, count] of Object.entries(direction.clat_ns.bins)) {
          mergedHistogram[bucket] = (mergedHistogram[bucket] || 0) + (count as number);
        }
      }
    }
  }

  // Compute percentiles from merged histogram
  const percentiles = computePercentilesFromHistogram(mergedHistogram, [50, 90, 95, 99, 99.9]);

  const metrics: AggregatedMetrics = {
    totalIops,
    totalBwKib,
    latencyPercentiles: {
      p50: percentiles[50] || 0,
      p90: percentiles[90] || 0,
      p95: percentiles[95] || 0,
      p99: percentiles[99] || 0,
      p999: percentiles[99.9] || 0,
    },
    latencyHistogram: mergedHistogram,
    perNodeIops,
    perNodeBwKib,
  };

  // Store aggregated results in S3
  await s3.send(new PutObjectCommand({
    Bucket: RESULTS_BUCKET,
    Key: `${resultsS3Prefix}/aggregated.json`,
    Body: JSON.stringify(metrics, null, 2),
    ContentType: 'application/json',
  }));

  // Update DynamoDB with aggregated metrics (without the full histogram for size)
  // Strip the full histogram before writing to DynamoDB (too large, kept in S3)
  const { latencyHistogram: _, ...summaryMetrics } = metrics;

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: 'META' },
    UpdateExpression: 'SET results = :r, #status = :s, completedAt = :t',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':r': summaryMetrics,
      ':s': 'completed',
      ':t': new Date().toISOString(),
    },
  }));

  return metrics;
}

/**
 * Parse the last complete JSON object from a string that may contain
 * multiple concatenated JSON documents (produced by FIO --status-interval).
 * Works by finding the last top-level '{' and parsing from there.
 */
function parseLastJsonObject(text: string): FioJsonPlusResult | null {
  // Try parsing the whole thing first (no status-interval case)
  try {
    return JSON.parse(text);
  } catch {
    // Multiple JSON objects — find the last one
  }

  // Find the last occurrence of a top-level opening brace by searching backwards
  let depth = 0;
  let lastStart = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '}') depth++;
    if (text[i] === '{') {
      depth--;
      if (depth === 0) {
        lastStart = i;
        break;
      }
    }
  }

  if (lastStart === -1) return null;

  try {
    return JSON.parse(text.substring(lastStart));
  } catch {
    return null;
  }
}

/**
 * Compute percentiles from a histogram of { latencyNs: count } bins.
 * Bins are sorted by latency, then we walk through the CDF to find
 * each requested percentile.
 */
function computePercentilesFromHistogram(
  histogram: Record<string, number>,
  targets: number[]
): Record<number, number> {
  const sortedBins = Object.entries(histogram)
    .map(([latency, count]) => ({ latency: parseInt(latency, 10), count: count as number }))
    .sort((a, b) => a.latency - b.latency);

  const totalCount = sortedBins.reduce((sum, bin) => sum + bin.count, 0);
  if (totalCount === 0) return {};

  const result: Record<number, number> = {};
  const sortedTargets = [...targets].sort((a, b) => a - b);
  let targetIdx = 0;
  let cumulative = 0;

  for (const bin of sortedBins) {
    cumulative += bin.count;
    const percentile = (cumulative / totalCount) * 100;

    while (targetIdx < sortedTargets.length && percentile >= sortedTargets[targetIdx]) {
      // Convert from nanoseconds to microseconds for readability
      result[sortedTargets[targetIdx]] = Math.round(bin.latency / 1000);
      targetIdx++;
    }

    if (targetIdx >= sortedTargets.length) break;
  }

  return result;
}
