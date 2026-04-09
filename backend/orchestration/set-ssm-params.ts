/**
 * Lambda: Write run-specific parameters to SSM Parameter Store.
 * Worker nodes read these on boot to know what to mount and where to upload.
 */

import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

const PARAM_PREFIX = process.env.SSM_PARAM_PREFIX || '/fio-bench';
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const TABLE_NAME = process.env.TABLE_NAME!;

interface Event {
  runId: string;
  resultsS3Prefix: string;
  mountCommand: string;
}

export async function handler(event: Event): Promise<{ success: boolean }> {
  const params: Record<string, string> = {
    [`${PARAM_PREFIX}/current-run-id`]: event.runId,
    [`${PARAM_PREFIX}/results-bucket`]: RESULTS_BUCKET,
    [`${PARAM_PREFIX}/results-prefix`]: event.resultsS3Prefix,
    [`${PARAM_PREFIX}/mount-command`]: event.mountCommand,
    [`${PARAM_PREFIX}/status-table`]: TABLE_NAME,
  };

  await Promise.all(
    Object.entries(params).map(([name, value]) =>
      ssm.send(new PutParameterCommand({
        Name: name,
        Value: value,
        Type: 'String',
        Overwrite: true,
      }))
    )
  );

  return { success: true };
}
