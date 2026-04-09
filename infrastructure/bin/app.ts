#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { FioBenchStack } from '../lib/fio-bench-stack';

const app = new cdk.App();

const envName = app.node.tryGetContext('env') || 'dev';
const vpcId = app.node.tryGetContext('vpcId');

new FioBenchStack(app, `FioBench-${envName}`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  vpcId,
  tags: {
    Project: 'fio-bench-console',
    Environment: envName,
    ManagedBy: 'cdk',
  },
  description: `FIO Benchmark Console (${envName}) - distributed NFS I/O benchmarking platform`,
});
