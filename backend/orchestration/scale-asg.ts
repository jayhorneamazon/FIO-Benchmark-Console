/**
 * Lambda: Scale the worker ASG up or down.
 * On scale-up, always terminates existing instances first to ensure
 * fresh nodes that will pick up the current run's SSM parameters.
 */

import {
  AutoScalingClient,
  UpdateAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  EC2Client,
  CreateLaunchTemplateVersionCommand,
  ModifyLaunchTemplateCommand,
} from '@aws-sdk/client-ec2';

const asc = new AutoScalingClient({});
const ec2 = new EC2Client({});

const ASG_NAME = process.env.ASG_NAME!;
const LAUNCH_TEMPLATE_ID = process.env.LAUNCH_TEMPLATE_ID!;

interface ScaleUpEvent {
  action: 'scale-up';
  config: {
    nodeCount: number;
    instanceType: string;
    useSpot: boolean;
  };
}

interface ScaleDownEvent {
  action: 'scale-down';
}

type Event = ScaleUpEvent | ScaleDownEvent;

async function waitForZeroInstances(maxWaitMs = 120000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const desc = await asc.send(new DescribeAutoScalingGroupsCommand({
      AutoScalingGroupNames: [ASG_NAME],
    }));
    const instances = desc.AutoScalingGroups?.[0]?.Instances || [];
    if (instances.length === 0) return;
    await new Promise(r => setTimeout(r, 5000));
  }
  // Don't fail — proceed anyway, new instances will still launch with fresh userdata
}

export async function handler(event: Event): Promise<{ success: boolean; detail?: string }> {
  if (event.action === 'scale-down') {
    await asc.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: ASG_NAME,
      DesiredCapacity: 0,
      MinSize: 0,
    }));
    return { success: true, detail: 'ASG scaled to 0' };
  }

  const { nodeCount: desiredCapacity, instanceType, useSpot } = event.config;

  // Step 1: Scale to 0 first to terminate any stale instances from previous runs.
  // This ensures all new instances boot fresh and read the current SSM parameters.
  const desc = await asc.send(new DescribeAutoScalingGroupsCommand({
    AutoScalingGroupNames: [ASG_NAME],
  }));
  const currentInstances = desc.AutoScalingGroups?.[0]?.Instances?.length || 0;

  if (currentInstances > 0) {
    await asc.send(new UpdateAutoScalingGroupCommand({
      AutoScalingGroupName: ASG_NAME,
      DesiredCapacity: 0,
      MinSize: 0,
    }));
    await waitForZeroInstances();
  }

  // Step 2: Create a new launch template version with the requested instance type
  const ltVersion = await ec2.send(new CreateLaunchTemplateVersionCommand({
    LaunchTemplateId: LAUNCH_TEMPLATE_ID,
    SourceVersion: '$Latest',
    LaunchTemplateData: {
      InstanceType: instanceType,
      ...(useSpot
        ? {
            InstanceMarketOptions: {
              MarketType: 'spot',
              SpotOptions: {
                SpotInstanceType: 'one-time',
                InstanceInterruptionBehavior: 'terminate',
              },
            },
          }
        : {}),
    },
  }));

  await ec2.send(new ModifyLaunchTemplateCommand({
    LaunchTemplateId: LAUNCH_TEMPLATE_ID,
    DefaultVersion: String(ltVersion.LaunchTemplateVersion?.VersionNumber),
  }));

  // Step 3: Scale up with fresh instances
  await asc.send(new UpdateAutoScalingGroupCommand({
    AutoScalingGroupName: ASG_NAME,
    DesiredCapacity: desiredCapacity,
    MinSize: 0,
    MaxSize: Math.max(200, desiredCapacity),
  }));

  return {
    success: true,
    detail: `Terminated ${currentInstances} stale instances, scaling to ${desiredCapacity} x ${instanceType}${useSpot ? ' (spot)' : ''}`,
  };
}
