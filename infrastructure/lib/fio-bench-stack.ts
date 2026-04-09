/**
 * CDK Stack: FIO Benchmark Console
 *
 * All resources use removalPolicy DESTROY and autoDeleteObjects where applicable
 * so `cdk destroy` cleanly removes everything from test accounts.
 *
 * Architecture:
 *   CloudFront → S3 (frontend)
 *   API Gateway HTTP API → Lambda (CRUD + orchestration trigger)
 *   Step Functions → Lambda (SSM params, ASG scaling, node polling, aggregation)
 *   DynamoDB (run metadata + node status)
 *   S3 (raw FIO json+ results, worker bootstrap script)
 *   EC2 ASG (worker nodes, starts at 0, scaled per-run)
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigwv2auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as path from 'path';

export interface FioBenchStackProps extends cdk.StackProps {
  /** VPC ID to use. If omitted, uses the default VPC. */
  vpcId?: string;
  /** Maximum ASG capacity. Default 200. */
  maxWorkerNodes?: number;
}

export class FioBenchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: FioBenchStackProps) {
    super(scope, id, props);

    const maxNodes = props?.maxWorkerNodes ?? 200;
    const ssmPrefix = `/fio-bench/${id}`;

    // ================================================================
    // STORAGE
    // ================================================================

    const resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'expire-old-results',
          prefix: 'results/',
          expiration: cdk.Duration.days(90),
        },
        {
          id: 'expire-logs',
          prefix: 'results/',
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const table = new dynamodb.Table(this, 'RunsTable', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // GSI for listing runs sorted by creation time
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ================================================================
    // AUTHENTICATION (Cognito)
    // ================================================================

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `fio-bench-${id}-users`,
      selfSignUpEnabled: false, // Admin creates users - this is an internal tool
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: false,
        otp: true,
      },
      standardAttributes: {
        email: { required: true, mutable: true },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
    });

    // Cognito domain for the hosted UI (used for initial sign-in flow)
    const cognitoDomain = userPool.addDomain('CognitoDomain', {
      cognitoDomain: {
        domainPrefix: `fio-bench-${this.account.substring(0, 8)}-${id.toLowerCase()}`,
      },
    });

    // App client — SPA uses authorization code flow with PKCE (no client secret)
    const userPoolClient = userPool.addClient('WebClient', {
      userPoolClientName: 'fio-bench-web',
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        // Callback URLs are updated after CloudFront is created (see outputs).
        // For local dev, localhost:5173 is included.
        callbackUrls: ['http://localhost:5173/auth/callback', 'https://localhost/auth/callback'],
        logoutUrls: ['http://localhost:5173/', 'https://localhost/'],
      },
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      preventUserExistenceErrors: true,
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
    });

    // ================================================================
    // NETWORKING
    // ================================================================

    const vpc = props?.vpcId
      ? ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId })
      : ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const workerSg = new ec2.SecurityGroup(this, 'WorkerSG', {
      vpc,
      description: 'FIO benchmark worker nodes - allows NFS egress',
      allowAllOutbound: true,
    });
    // NFS TCP
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(2049), 'NFS TCP');
    // NFS UDP (for v3 UDP mounts)
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(2049), 'NFS UDP');
    // Portmapper / rpcbind (NFSv3 mount discovery)
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(111), 'rpcbind');
    workerSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.udp(111), 'rpcbind UDP');

    // ================================================================
    // WORKER ASG
    // ================================================================

    const workerRole = new iam.Role(this, 'WorkerRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Role for FIO benchmark worker EC2 instances',
    });

    resultsBucket.grantReadWrite(workerRole);
    table.grantReadWriteData(workerRole);

    // SSM read access for pulling run parameters
    workerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/*`,
      ],
    }));

    // SSM managed instance core for Session Manager access (debugging)
    workerRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'WorkerLT', {
      instanceType: new ec2.InstanceType('c5.xlarge'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role: workerRole,
      securityGroup: workerSg,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
      userData: ec2.UserData.custom([
        '#!/bin/bash',
        'set -euo pipefail',
        '',
        '# Fix DNS: the VPC DHCP option set uses internal AD DNS servers that may',
        '# not forward public queries. Prepend the Amazon-provided DNS resolver',
        '# so we can resolve both public hostnames and internal AD names.',
        'if ! grep -q "169.254.169.253" /etc/resolv.conf; then',
        '  echo "nameserver 169.254.169.253" | cat - /etc/resolv.conf > /tmp/resolv.conf.new',
        '  cp /tmp/resolv.conf.new /etc/resolv.conf',
        '  echo "[$(date -u)] DNS fix applied — prepended Amazon DNS resolver"',
        'fi',
        '',
        '# Pre-install fio and NFS utilities before pulling the bootstrap script.',
        '# This ensures the packages are available even if S3 access is delayed.',
        'echo "[$(date -u)] Installing fio and NFS utilities..."',
        '',
        '# Amazon Linux 2023 uses dnf',
        'if command -v dnf &>/dev/null; then',
        '  dnf install -y -q nfs-utils',
        '  # fio may not be in default AL2023 repos — install build deps and compile',
        '  if ! dnf install -y -q fio 2>/dev/null; then',
        '    dnf install -y -q gcc make libaio-devel zlib-devel',
        '    FIO_VER="3.38"',
        '    curl -sL "https://github.com/axboe/fio/archive/refs/tags/fio-${FIO_VER}.tar.gz" -o /tmp/fio.tar.gz',
        '    tar xzf /tmp/fio.tar.gz -C /tmp',
        '    cd /tmp/fio-fio-${FIO_VER} && ./configure && make -j$(nproc) && make install && cd /',
        '    rm -rf /tmp/fio.tar.gz /tmp/fio-fio-${FIO_VER}',
        '  fi',
        'elif command -v yum &>/dev/null; then',
        '  yum install -y -q nfs-utils',
        '  yum install -y -q fio 2>/dev/null || {',
        '    yum install -y -q epel-release 2>/dev/null || amazon-linux-extras install epel -y 2>/dev/null || true',
        '    yum install -y -q fio 2>/dev/null || {',
        '      yum install -y -q gcc make libaio-devel zlib-devel',
        '      FIO_VER="3.38"',
        '      curl -sL "https://github.com/axboe/fio/archive/refs/tags/fio-${FIO_VER}.tar.gz" -o /tmp/fio.tar.gz',
        '      tar xzf /tmp/fio.tar.gz -C /tmp',
        '      cd /tmp/fio-fio-${FIO_VER} && ./configure && make -j$(nproc) && make install && cd /',
        '      rm -rf /tmp/fio.tar.gz /tmp/fio-fio-${FIO_VER}',
        '    }',
        '  }',
        'elif command -v apt-get &>/dev/null; then',
        '  apt-get update -qq && apt-get install -y -qq fio nfs-common',
        'fi',
        '',
        '# Verify critical tools are available',
        'fio --version || { echo "FATAL: fio not installed"; exit 1; }',
        'command -v mount.nfs || command -v mount.nfs4 || { echo "FATAL: NFS utils not installed"; exit 1; }',
        '',
        'echo "[$(date -u)] fio $(fio --version) and NFS utilities ready"',
        '',
        '# Pull and run the benchmark bootstrap script',
        `aws s3 cp s3://${resultsBucket.bucketName}/worker/bootstrap.sh /tmp/bootstrap.sh --region ${this.region}`,
        'chmod +x /tmp/bootstrap.sh',
        `export SSM_PREFIX="${ssmPrefix}"`,
        '/tmp/bootstrap.sh 2>&1 | tee /var/log/fio-bench.log',
      ].join('\n')),
      requireImdsv2: true,
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'WorkerASG', {
      vpc,
      launchTemplate,
      minCapacity: 0,
      maxCapacity: maxNodes,
      desiredCapacity: 0,
      newInstancesProtectedFromScaleIn: false,
      defaultInstanceWarmup: cdk.Duration.seconds(0),
    });

    // Upload the bootstrap script to S3
    new s3deploy.BucketDeployment(this, 'WorkerScriptDeploy', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../worker'))],
      destinationBucket: resultsBucket,
      destinationKeyPrefix: 'worker',
    });

    // ================================================================
    // LAMBDA FUNCTIONS
    // ================================================================

    const backendDir = path.join(__dirname, '../../backend');

    // Shared Lambda props
    const commonLambdaProps: Partial<nodejs.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        format: nodejs.OutputFormat.ESM,
        mainFields: ['module', 'main'],
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
    };

    // --- Orchestration Lambdas ---

    const setSSMParamsFn = new nodejs.NodejsFunction(this, 'SetSSMParamsFn', {
      ...commonLambdaProps,
      entry: path.join(backendDir, 'orchestration/set-ssm-params.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        SSM_PARAM_PREFIX: ssmPrefix,
        RESULTS_BUCKET: resultsBucket.bucketName,
        TABLE_NAME: table.tableName,
      },
    });

    // Grant SSM write for the run parameters
    setSSMParamsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:PutParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${ssmPrefix}/*`],
    }));

    const scaleAsgFn = new nodejs.NodejsFunction(this, 'ScaleAsgFn', {
      ...commonLambdaProps,
      entry: path.join(backendDir, 'orchestration/scale-asg.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(3),
      memorySize: 128,
      environment: {
        ASG_NAME: asg.autoScalingGroupName,
        LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId!,
      },
    });

    scaleAsgFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:UpdateAutoScalingGroup',
      ],
      resources: [asg.autoScalingGroupArn],
    }));
    // DescribeAutoScalingGroups doesn't support resource-level permissions
    // DescribeAutoScalingGroups does not support resource-level permissions (AWS limitation)
    scaleAsgFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
      ],
      resources: ['*'],
    }));
    scaleAsgFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateLaunchTemplateVersion',
        'ec2:ModifyLaunchTemplate',
        'ec2:DescribeLaunchTemplateVersions',
      ],
      resources: [`arn:aws:ec2:${this.region}:${this.account}:launch-template/${launchTemplate.launchTemplateId}`],
    }));

    const checkNodesFn = new nodejs.NodejsFunction(this, 'CheckNodesFn', {
      ...commonLambdaProps,
      entry: path.join(backendDir, 'orchestration/check-nodes.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(15),
      memorySize: 128,
      environment: {
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(checkNodesFn);

    const aggregateFn = new nodejs.NodejsFunction(this, 'AggregateFn', {
      ...commonLambdaProps,
      entry: path.join(backendDir, 'ingestion/aggregate-results.ts'),
      handler: 'handler',
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      environment: {
        TABLE_NAME: table.tableName,
        RESULTS_BUCKET: resultsBucket.bucketName,
      },
    });
    table.grantReadWriteData(aggregateFn);
    resultsBucket.grantRead(aggregateFn);
    resultsBucket.grantPut(aggregateFn);

    // ================================================================
    // STEP FUNCTIONS — Run Lifecycle Orchestration
    // ================================================================

    // Step 1: Update run status to "scaling"
    const updateStatusScaling = new tasks.DynamoUpdateItem(this, 'UpdateStatusScaling', {
      table,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('RUN#{}', sfn.JsonPath.stringAt('$.runId'))
        ),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      updateExpression: 'SET #s = :s, startedAt = :t',
      expressionAttributeNames: { '#s': 'status' },
      expressionAttributeValues: {
        ':s': tasks.DynamoAttributeValue.fromString('scaling'),
        ':t': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Step 2: Write SSM parameters for workers
    const setSSMParams = new tasks.LambdaInvoke(this, 'SetSSMParams', {
      lambdaFunction: setSSMParamsFn,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        resultsS3Prefix: sfn.JsonPath.stringAt('$.resultsS3Prefix'),
        mountCommand: sfn.JsonPath.stringAt('$.mountCommand'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Step 3: Scale up ASG — pass the full infra config, Lambda extracts what it needs
    const scaleUp = new tasks.LambdaInvoke(this, 'ScaleUpASG', {
      lambdaFunction: scaleAsgFn,
      payload: sfn.TaskInput.fromObject({
        'action': 'scale-up',
        'config.$': '$.config.infra',
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Step 4: Poll for node completion
    const checkNodes = new tasks.LambdaInvoke(this, 'CheckNodes', {
      lambdaFunction: checkNodesFn,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        expectedCount: sfn.JsonPath.numberAt('$.config.infra.nodeCount'),
      }),
      resultSelector: {
        'allCompleted.$': '$.Payload.allCompleted',
        'anyFailed.$': '$.Payload.anyFailed',
        'completedCount.$': '$.Payload.completedCount',
        'failedCount.$': '$.Payload.failedCount',
      },
      resultPath: '$.nodeCheck',
    });

    // Step 5: Wait between polls
    const waitInterval = new sfn.Wait(this, 'WaitInterval', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    // Step 6: Check if user cancelled
    const checkCancellation = new tasks.DynamoGetItem(this, 'CheckCancellation', {
      table,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('RUN#{}', sfn.JsonPath.stringAt('$.runId'))
        ),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      expressionAttributeNames: { '#s': 'status' },
      projectionExpression: [new tasks.DynamoProjectionExpression().withAttribute('#s')],
      resultSelector: {
        'status.$': '$.Item.status.S',
      },
      resultPath: '$.cancelCheck',
    });

    // Step 7: Aggregate results
    const aggregateResults = new tasks.LambdaInvoke(this, 'AggregateResults', {
      lambdaFunction: aggregateFn,
      payload: sfn.TaskInput.fromObject({
        runId: sfn.JsonPath.stringAt('$.runId'),
        resultsS3Prefix: sfn.JsonPath.stringAt('$.resultsS3Prefix'),
      }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Step 8: Scale down ASG (always, even on failure)
    const scaleDown = new tasks.LambdaInvoke(this, 'ScaleDownASG', {
      lambdaFunction: scaleAsgFn,
      payload: sfn.TaskInput.fromObject({ action: 'scale-down' }),
      resultPath: sfn.JsonPath.DISCARD,
    });

    // Step 9: Mark run as failed
    const markFailed = new tasks.DynamoUpdateItem(this, 'MarkFailed', {
      table,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('RUN#{}', sfn.JsonPath.stringAt('$.runId'))
        ),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      updateExpression: 'SET #s = :s, #e = :e, completedAt = :t',
      expressionAttributeNames: { '#s': 'status', '#e': 'error' },
      expressionAttributeValues: {
        ':s': tasks.DynamoAttributeValue.fromString('failed'),
        ':e': tasks.DynamoAttributeValue.fromString('One or more worker nodes failed'),
        ':t': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$$.State.EnteredTime')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });

    const succeed = new sfn.Succeed(this, 'Done');

    // Wire the state machine graph
    const isCancelled = new sfn.Choice(this, 'IsCancelled?')
      .when(sfn.Condition.stringEquals('$.cancelCheck.status', 'cancelled'), scaleDown)
      .otherwise(checkNodes);

    const allNodesReady = new sfn.Choice(this, 'AllNodesReady?')
      .when(sfn.Condition.booleanEquals('$.nodeCheck.allCompleted', true), aggregateResults)
      .when(sfn.Condition.booleanEquals('$.nodeCheck.anyFailed', true), markFailed)
      .otherwise(waitInterval);

    // Chain: scaling → SSM → scale up → poll loop → aggregate → scale down → done
    const definition = updateStatusScaling
      .next(setSSMParams)
      .next(scaleUp)
      .next(checkNodes)
      .next(allNodesReady);

    waitInterval.next(checkCancellation).next(isCancelled);
    aggregateResults.addCatch(markFailed, { resultPath: '$.aggregationError' });
    aggregateResults.next(scaleDown);
    markFailed.next(scaleDown);
    scaleDown.next(succeed);

    // Add a global error catcher that always scales down
    const errorScaleDown = new tasks.LambdaInvoke(this, 'ErrorScaleDown', {
      lambdaFunction: scaleAsgFn,
      payload: sfn.TaskInput.fromObject({ action: 'scale-down' }),
      resultPath: sfn.JsonPath.DISCARD,
    });
    const markErrorFailed = new tasks.DynamoUpdateItem(this, 'MarkErrorFailed', {
      table,
      key: {
        PK: tasks.DynamoAttributeValue.fromString(
          sfn.JsonPath.format('RUN#{}', sfn.JsonPath.stringAt('$.runId'))
        ),
        SK: tasks.DynamoAttributeValue.fromString('META'),
      },
      updateExpression: 'SET #s = :s, #e = :e',
      expressionAttributeNames: { '#s': 'status', '#e': 'error' },
      expressionAttributeValues: {
        ':s': tasks.DynamoAttributeValue.fromString('failed'),
        ':e': tasks.DynamoAttributeValue.fromString('Orchestration error - see Step Functions execution history'),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    errorScaleDown.next(markErrorFailed).next(new sfn.Fail(this, 'OrchestrationFailed', {
      cause: 'Unhandled error in orchestration workflow',
    }));

    const stateMachineLogGroup = new logs.LogGroup(this, 'StateMachineLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateMachine = new sfn.StateMachine(this, 'RunOrchestrator', {
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.hours(6),
      tracingEnabled: true,
      logs: {
        destination: stateMachineLogGroup,
        level: sfn.LogLevel.ERROR,
      },
    });

    table.grantReadWriteData(stateMachine);

    // ================================================================
    // API LAMBDA + API GATEWAY
    // ================================================================

    const apiFn = new nodejs.NodejsFunction(this, 'ApiFn', {
      ...commonLambdaProps,
      entry: path.join(backendDir, 'api/handler.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TABLE_NAME: table.tableName,
        RESULTS_BUCKET: resultsBucket.bucketName,
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      },
    });

    table.grantReadWriteData(apiFn);
    resultsBucket.grantReadWrite(apiFn);
    stateMachine.grantStartExecution(apiFn);

    // EC2 Describe APIs do not support resource-level permissions (AWS limitation)
    apiFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ec2:DescribeInstanceStatus'],
      resources: ['*'],
    }));

    const httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `fio-bench-${id}`,
      corsPreflight: {
        // Restrict to the CloudFront domain once deployed.
        // Using '*' initially since the CloudFront domain isn't known until after first deploy.
        // After first deploy, update this to: [`https://${distribution.distributionDomainName}`]
        allowOrigins: ['*'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAge: cdk.Duration.hours(1),
      },
    });

    // JWT authorizer backed by Cognito
    const jwtAuthorizer = new apigwv2auth.HttpJwtAuthorizer('CognitoAuthorizer', 
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId],
        identitySource: ['$request.header.Authorization'],
      }
    );

    const apiIntegration = new apigwv2int.HttpLambdaIntegration('ApiIntegration', apiFn);

    httpApi.addRoutes({
      path: '/runs',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/runs/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/runs/{id}/cancel',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/runs/compare',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });

    // Analytics routes
    httpApi.addRoutes({
      path: '/analytics/summary',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/analytics/trends',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/analytics/histogram',
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });
    httpApi.addRoutes({
      path: '/analytics/custom',
      methods: [apigwv2.HttpMethod.POST],
      integration: apiIntegration,
      authorizer: jwtAuthorizer,
    });

    // ================================================================
    // CLOUDFRONT (Frontend)
    // ================================================================

    const oac = new cloudfront.S3OriginAccessControl(this, 'FrontendOAC', {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    const distribution = new cloudfront.Distribution(this, 'FrontendCDN', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket, {
          originAccessControl: oac,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(
            `${httpApi.httpApiId}.execute-api.${this.region}.amazonaws.com`
          ),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    // ================================================================
    // SSM PARAMETERS (static config for reference)
    // ================================================================

    new ssm.StringParameter(this, 'AsgNameParam', {
      parameterName: `${ssmPrefix}/asg-name`,
      stringValue: asg.autoScalingGroupName,
    });

    new ssm.StringParameter(this, 'ResultsBucketParam', {
      parameterName: `${ssmPrefix}/results-bucket`,
      stringValue: resultsBucket.bucketName,
    });

    new ssm.StringParameter(this, 'TableNameParam', {
      parameterName: `${ssmPrefix}/status-table`,
      stringValue: table.tableName,
    });

    // ================================================================
    // OUTPUTS
    // ================================================================

    new cdk.CfnOutput(this, 'FrontendUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL for the benchmark console',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: httpApi.apiEndpoint,
      description: 'HTTP API endpoint',
    });

    new cdk.CfnOutput(this, 'ResultsBucketName', {
      value: resultsBucket.bucketName,
      description: 'S3 bucket for FIO results and worker scripts',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: table.tableName,
      description: 'DynamoDB table for run metadata',
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.stateMachineArn,
      description: 'Step Functions state machine for run orchestration',
    });

    new cdk.CfnOutput(this, 'AsgName', {
      value: asg.autoScalingGroupName,
      description: 'Auto Scaling Group for worker nodes',
    });

    new cdk.CfnOutput(this, 'WorkerSecurityGroupId', {
      value: workerSg.securityGroupId,
      description: 'Security group ID for workers - add to NFS server inbound rules',
    });

    new cdk.CfnOutput(this, 'DestroyCommand', {
      value: `cd infrastructure && npx cdk destroy --force`,
      description: 'Run this to tear down all resources',
    });

    // ================================================================
    // AUTH OUTPUTS
    // ================================================================

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito App Client ID (for frontend)',
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${cognitoDomain.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain',
    });

    new cdk.CfnOutput(this, 'PostDeployNote', {
      value: [
        'After first deploy, update the Cognito app client callback URLs to include your CloudFront domain:',
        `  Callback: https://<CloudFront domain>/auth/callback`,
        `  Logout:   https://<CloudFront domain>/`,
        'Then create your first user:',
        `  aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username [email] --user-attributes Name=email,Value=[email] --temporary-password <TempPass123!>`,
      ].join('\n'),
      description: 'Post-deployment steps',
    });
  }
}
