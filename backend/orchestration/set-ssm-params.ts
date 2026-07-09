/**
 * Lambda: Write run-specific parameters to SSM Parameter Store.
 * Worker nodes read these on boot to know what to mount and where to upload.
 */

import { SSMClient, PutParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({});

const PARAM_PREFIX = process.env.SSM_PARAM_PREFIX || '/fio-bench';
const RESULTS_BUCKET = process.env.RESULTS_BUCKET!;
const TABLE_NAME = process.env.TABLE_NAME!;

interface Event {
  runId: string;
  resultsS3Prefix: string;
  mountCommand: string;
  mountCommands?: string[];
}

export async function handler(event: Event): Promise<{ success: boolean }> {
  const params: Record<string, string> = {
    [`${PARAM_PREFIX}/current-run-id`]: event.runId,
    [`${PARAM_PREFIX}/results-bucket`]: RESULTS_BUCKET,
    [`${PARAM_PREFIX}/results-prefix`]: event.resultsS3Prefix,
    [`${PARAM_PREFIX}/mount-command`]: event.mountCommand,
    [`${PARAM_PREFIX}/status-table`]: TABLE_NAME,
  };

  // Store or clear the mount-commands parameter based on mode.
  // For multi-export: store the JSON array of all mount commands.
  // For single-export: delete the parameter to prevent stale state from
  // causing subsequent single-export runs to enter multi-export mode.
  if (event.mountCommands && event.mountCommands.length > 1) {
    params[`${PARAM_PREFIX}/mount-commands`] = JSON.stringify(event.mountCommands);
  } else {
    // Delete the multi-export parameter if it exists (ignore if not found)
    try {
      await ssm.send(new DeleteParameterCommand({
        Name: `${PARAM_PREFIX}/mount-commands`,
      }));
    } catch (err: unknown) {
      // ParameterNotFound is expected when no previous multi-export run occurred
      if (!(err instanceof Error && err.name === 'ParameterNotFound')) {
        throw err;
      }
    }
  }

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
