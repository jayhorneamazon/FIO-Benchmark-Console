/**
 * Lambda handlers for benchmark run CRUD operations.
 */

import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { EC2Client, DescribeInstancesCommand, DescribeInstanceStatusCommand } from '@aws-sdk/client-ec2';
import { randomUUID } from 'crypto';
import { BenchmarkRun, BenchmarkRunConfig, RunStatus } from '../../shared/types/benchmark-run';
import { buildJobFile } from '../../shared/types/fio-config';
import { buildMountCommand } from '../../shared/types/nfs-config';
import { validateNfsWorkloadMatch } from '../../shared/validation/nfs-workload-validator';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const sfn = new SFNClient({});
const ec2 = new EC2Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Extract authenticated user info from the JWT authorizer context */
function getCallerIdentity(event: APIGatewayProxyEventV2): { sub: string; email: string } {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  return {
    sub: (claims?.sub as string) || 'unknown',
    email: (claims?.email as string) || 'unknown',
  };
}

/** POST /runs — Create and launch a benchmark run */
export async function createRun(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = JSON.parse(event.body || '{}');
  const { name, description, tags, config } = body as {
    name: string;
    description?: string;
    tags?: string[];
    config: BenchmarkRunConfig;
  };

  if (!name || !config) {
    return json(400, { error: 'name and config are required' });
  }

  // Validate NFS + workload compatibility
  const warnings = validateNfsWorkloadMatch(config.nfs, config.fioJobs);
  const errors = warnings.filter(w => w.severity === 'error');
  if (errors.length > 0) {
    return json(400, {
      error: 'Configuration has validation errors',
      validationErrors: errors,
      validationWarnings: warnings.filter(w => w.severity !== 'error'),
    });
  }

  // Generate job file and mount command
  const jobFileContent = buildJobFile(config.fioGlobal, config.fioJobs);
  const mountCommand = buildMountCommand(config.nfs);

  const runId = randomUUID();
  const now = new Date().toISOString();
  const resultsS3Prefix = `results/${now.slice(0, 4)}/${now.slice(5, 7)}/${runId}`;

  const run: BenchmarkRun = {
    runId,
    name,
    description,
    tags: tags || [],
    status: 'pending',
    config,
    jobFileContent,
    mountCommand,
    nodes: [],
    resultsS3Prefix,
    createdAt: now,
    createdBy: getCallerIdentity(event).email,
  };

  // Store run metadata
  await ddb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `RUN#${runId}`,
      SK: 'META',
      GSI1PK: 'RUNS',
      GSI1SK: now,
      ...run,
    },
  }));

  // Upload job file to S3 for workers to pull
  await s3.send(new PutObjectCommand({
    Bucket: RESULTS_BUCKET,
    Key: `${resultsS3Prefix}/job.fio`,
    Body: jobFileContent,
    ContentType: 'text/plain',
  }));

  // Start the orchestration state machine
  await sfn.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `run-${runId}`,
    input: JSON.stringify({ runId, config, resultsS3Prefix, mountCommand }),
  }));

  return json(201, {
    run,
    validationWarnings: warnings.filter(w => w.severity !== 'error'),
  });
}

/** GET /runs — List runs with optional filters */
export async function listRuns(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const params = event.queryStringParameters || {};
  const limit = parseInt(params.limit || '50', 10);

  // Query all runs, sorted by creation time (descending)
  const result = await ddb.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: { ':pk': 'RUNS' },
    ScanIndexForward: false,
    Limit: limit,
  }));

  return json(200, { runs: result.Items || [] });
}

/** GET /runs/:id — Get run details including worker node statuses */
export async function getRun(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.id;
  if (!runId) return json(400, { error: 'Run ID required' });

  // Fetch run metadata and node records in parallel
  const [metaResult, nodesResult] = await Promise.all([
    ddb.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { PK: `RUN#${runId}`, SK: 'META' },
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `RUN#${runId}`,
        ':prefix': 'NODE#',
      },
    })),
  ]);

  if (!metaResult.Item) return json(404, { error: 'Run not found' });

  const run = metaResult.Item;
  const nodeItems = nodesResult.Items || [];

  // Build node list from DynamoDB records
  const nodes = nodeItems.map(item => ({
    nodeId: (item.SK as string).replace('NODE#', ''),
    instanceId: item.instanceId || (item.SK as string).replace('NODE#', ''),
    privateIp: item.privateIp || '',
    status: item.status || 'pending',
    updatedAt: item.updatedAt,
    error: item.error || undefined,
    ec2State: undefined as string | undefined,
    ec2StatusCheck: undefined as string | undefined,
    launchTime: undefined as string | undefined,
  }));

  // Enrich with EC2 instance state if we have instance IDs
  const instanceIds = nodes.map(n => n.instanceId).filter(id => id.startsWith('i-'));
  if (instanceIds.length > 0) {
    try {
      const ec2Result = await ec2.send(new DescribeInstancesCommand({
        InstanceIds: instanceIds,
      }));

      const ec2Map = new Map<string, { state: string; statusCheck: string; launchTime?: string }>();
      for (const reservation of ec2Result.Reservations || []) {
        for (const instance of reservation.Instances || []) {
          if (instance.InstanceId) {
            ec2Map.set(instance.InstanceId, {
              state: instance.State?.Name || 'unknown',
              statusCheck: '',
              launchTime: instance.LaunchTime?.toISOString(),
            });
          }
        }
      }

      // Get instance status checks (initializing/ok/impaired) for running instances
      const runningIds = instanceIds.filter(id => ec2Map.get(id)?.state === 'running');
      if (runningIds.length > 0) {
        try {
          const statusResult = await ec2.send(new DescribeInstanceStatusCommand({
            InstanceIds: runningIds,
          }));
          for (const s of statusResult.InstanceStatuses || []) {
            const existing = ec2Map.get(s.InstanceId!);
            if (existing) {
              const inst = s.InstanceStatus?.Status || 'unknown';
              const sys = s.SystemStatus?.Status || 'unknown';
              if (inst === 'ok' && sys === 'ok') {
                existing.statusCheck = 'ok';
              } else if (inst === 'initializing' || sys === 'initializing') {
                existing.statusCheck = 'initializing';
              } else {
                existing.statusCheck = `instance: ${inst}, system: ${sys}`;
              }
            }
          }
        } catch {
          // Can fail for recently terminated instances
        }
      }

      for (const node of nodes) {
        const info = ec2Map.get(node.instanceId);
        if (info) {
          node.ec2State = info.state;
          node.ec2StatusCheck = info.statusCheck || undefined;
          node.launchTime = info.launchTime;
        }
      }
    } catch {
      // EC2 describe can fail if instances are long gone
    }
  }

  run.nodes = nodes;
  return json(200, { run });
}

/** POST /runs/:id/cancel — Cancel a running benchmark */
export async function cancelRun(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const runId = event.pathParameters?.id;
  if (!runId) return json(400, { error: 'Run ID required' });

  await ddb.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `RUN#${runId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'cancelled' as RunStatus },
  }));

  // The Step Functions workflow checks for cancellation and handles ASG teardown

  return json(200, { message: 'Run cancellation requested', runId });
}

/** GET /runs/compare?ids=a,b,c — Get comparison data for multiple runs */
export async function compareRuns(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const ids = (event.queryStringParameters?.ids || '').split(',').filter(Boolean);
  if (ids.length < 2) return json(400, { error: 'At least 2 run IDs required' });

  const runs = await Promise.all(
    ids.map(id =>
      ddb.send(new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `RUN#${id}`, SK: 'META' },
      })).then(r => r.Item)
    )
  );

  const found = runs.filter(Boolean);
  if (found.length < 2) return json(404, { error: 'Not enough runs found' });

  return json(200, { runs: found });
}
