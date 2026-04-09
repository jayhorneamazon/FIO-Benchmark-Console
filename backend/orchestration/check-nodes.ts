/**
 * Lambda: Check the status of all worker nodes for a given run.
 *
 * Handles two stuck-node scenarios:
 * 1. Nodes that never reported to DynamoDB at all (bootstrap crashed early)
 * 2. Nodes that reported "running" but never moved to "completed"/"failed"
 *
 * In both cases, if other nodes have completed and the grace period has
 * elapsed, we proceed with the results we have.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = process.env.TABLE_NAME!;

// Minutes to wait after the first node completes before giving up on stragglers
const STRAGGLER_GRACE_MINUTES = 5;

interface Event {
  runId: string;
  expectedCount: number;
}

interface Result {
  allCompleted: boolean;
  anyFailed: boolean;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  totalReported: number;
}

export async function handler(event: Event): Promise<Result> {
  const { runId, expectedCount } = event;

  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `RUN#${runId}`,
      ':prefix': 'NODE#',
    },
  }));

  const nodes = result.Items || [];
  const completedCount = nodes.filter(n => n.status === 'completed').length;
  const failedCount = nodes.filter(n => n.status === 'failed').length;
  const runningCount = nodes.filter(n => n.status === 'running' || n.status === 'mounting').length;
  const totalReported = nodes.length;

  // Update run status to "running" once any node is actively running
  if (runningCount > 0 || completedCount > 0) {
    await ddb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${runId}`, SK: 'META' },
      UpdateExpression: 'SET #s = :running',
      ConditionExpression: '#s = :scaling',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':running': 'running', ':scaling': 'scaling' },
    })).catch(() => {});
  }

  // Happy path: all nodes completed
  if (completedCount >= expectedCount) {
    return { allCompleted: true, anyFailed: false, completedCount, failedCount, runningCount, totalReported };
  }

  // All reported nodes are in a terminal state and all expected nodes reported
  const allReportedTerminal = (completedCount + failedCount) === totalReported;
  if (allReportedTerminal && totalReported >= expectedCount) {
    // All nodes finished but some failed
    return { allCompleted: false, anyFailed: failedCount > 0, completedCount, failedCount, runningCount, totalReported };
  }

  // Some nodes are still running or haven't reported — check for stragglers
  // If at least one node completed, start the grace timer from the earliest completion
  if (completedCount > 0) {
    const completionTimes = nodes
      .filter(n => n.status === 'completed' && n.updatedAt)
      .map(n => new Date(n.updatedAt as string).getTime());

    if (completionTimes.length > 0) {
      const earliestCompletion = Math.min(...completionTimes);
      const minutesSinceFirst = (Date.now() - earliestCompletion) / 60000;

      if (minutesSinceFirst >= STRAGGLER_GRACE_MINUTES) {
        // Grace period expired — mark straggler nodes as failed, then proceed
        const stragglers = nodes.filter(n => n.status !== 'completed' && n.status !== 'failed');
        for (const node of stragglers) {
          await ddb.send(new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { PK: `RUN#${runId}`, SK: node.SK as string },
            UpdateExpression: 'SET #s = :s, #e = :e, updatedAt = :t',
            ExpressionAttributeNames: { '#s': 'status', '#e': 'error' },
            ExpressionAttributeValues: {
              ':s': 'failed',
              ':e': `Node timed out — stuck at "${node.status}" while ${completedCount} other nodes completed`,
              ':t': new Date().toISOString(),
            },
          })).catch(() => {});
        }

        return { allCompleted: true, anyFailed: false, completedCount, failedCount, runningCount, totalReported };
      }
    }
  }

  // Still waiting
  return { allCompleted: false, anyFailed: false, completedCount, failedCount, runningCount, totalReported };
}
