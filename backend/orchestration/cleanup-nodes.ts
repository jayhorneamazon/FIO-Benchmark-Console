/**
 * Lambda: Clean up benchmark data files on worker nodes after results
 * have been aggregated and uploaded to S3.
 *
 * Uses SSM Run Command to delete the mount directory contents on all
 * running instances in the ASG.
 */

import { SSMClient, SendCommandCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import {
  AutoScalingClient,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';

const ssm = new SSMClient({});
const asc = new AutoScalingClient({});

const ASG_NAME = process.env.ASG_NAME!;
const MOUNT_PATH = '/mnt/benchmark';

interface Event {
  runId: string;
}

export async function handler(event: Event): Promise<{ success: boolean; detail: string }> {
  const { runId } = event;

  // Get the list of running instance IDs from the ASG
  const desc = await asc.send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [ASG_NAME],
  }));

  const instanceIds = (desc.AutoScalingGroups?.[0]?.Instances || [])
    .filter(i => i.LifecycleState === 'InService')
    .map(i => i.InstanceId!)
    .filter(Boolean);

  if (instanceIds.length === 0) {
    return { success: true, detail: 'No instances to clean up' };
  }

  // Send command to delete benchmark files on all nodes
  await ssm.send(new SendCommandCommand({
    DocumentName: 'AWS-RunShellScript',
    Targets: [{ Key: 'tag:aws:autoscaling:groupName', Values: [ASG_NAME] }],
    Parameters: {
      commands: [
        `echo "Cleaning up benchmark files for run ${runId}"`,
        `rm -rf ${MOUNT_PATH}/*`,
        `echo "Cleanup complete"`,
      ],
    },
    Comment: `Cleanup benchmark files after run ${runId}`,
    TimeoutSeconds: 120,
  }));

  return {
    success: true,
    detail: `Sent cleanup command to ${instanceIds.length} instances`,
  };
}
