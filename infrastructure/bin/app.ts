#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FioBenchStack } from '../lib/fio-bench-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') || 'dev';

// Pin the deployment region to us-west-2 where the stack and its VPC live.
// This intentionally takes precedence over the ambient CLI/CDK default region
// (which is often us-east-1) so synth/deploy is deterministic. Override only
// via explicit context: `-c region=<region>`.
const region = app.node.tryGetContext('region') || 'us-west-2';

// us-west-2 has no default VPC, so the stack must target the existing VPC that
// the deployed resources live in. Overridable via `-c vpcId=<id>`.
const vpcId = app.node.tryGetContext('vpcId') || 'vpc-0105c4f537ec812f6';

new FioBenchStack(app, `FioBench-${envName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region,
  },
  vpcId,
  tags: {
    Project: 'fio-bench-console',
    Environment: envName,
    ManagedBy: 'cdk',
  },
  description: `FIO Benchmark Console (${envName}) - distributed NFS I/O benchmarking platform`,
});
