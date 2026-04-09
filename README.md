# FIO Benchmark Console
# TLDR: npx cdk deploy -c env=dev -c vpcId=<your-vpc>
A serverless web application for running distributed [FIO](https://fio.readthedocs.io/) benchmarks across AWS Auto Scaling Groups with NFS-aware mount configuration, real-time monitoring, and historical result comparison.

## Architecture

- **Frontend**: React SPA on S3 + CloudFront with Cognito authentication
- **API**: API Gateway HTTP API + Lambda with JWT authorization
- **Orchestration**: Step Functions for run lifecycle (scale up, poll, aggregate, scale down)
- **Storage**: DynamoDB (run metadata, node status), S3 (raw FIO json+ results)
- **Compute**: EC2 Auto Scaling Group (worker nodes, starts at 0, scaled per-run)
- **Analytics**: DynamoDB queries with trend charts and custom query builder

## Features

- NFS mount configuration with version-aware validation (warns about NFSv4.x overhead for small random I/O)
- Workload presets that pair FIO configs with recommended NFS mount options
- Guided 4-step wizard: NFS Mount, Workload, Infrastructure, Review & Launch
- Real-time node status with EC2 instance state enrichment
- Latency CDF charts, IOPS/bandwidth comparison, per-node distribution
- Historical analytics dashboard with trend charts and custom query builder
- Re-run button to duplicate previous benchmarks with identical settings
- Straggler node detection with 5-minute grace period
- Clean teardown via `cdk destroy`

## Prerequisites

- AWS CLI configured with credentials
- Node.js 20+
- An existing VPC with private subnets (NAT gateway required for worker internet access)
- An NFS server accessible from the VPC (e.g., FSx for ONTAP, EFS, or self-managed)

## Deployment

```bash
# 1. Install dependencies
cd infrastructure && npm install
cd ../backend && npm install
cd ../frontend && npm install
cd ..

# 2. Bootstrap CDK (first time per account/region)
cd infrastructure
npx cdk bootstrap

# 3. Deploy the stack (provide your VPC ID)
npx cdk deploy -c env=dev -c vpcId=vpc-XXXXXXXXX

# 4. Note the stack outputs:
#    - FrontendUrl, ApiUrl, UserPoolId, UserPoolClientId, CognitoDomain
#    - WorkerSecurityGroupId (add to your NFS server's inbound rules on port 2049)

# 5. Update Cognito callback URLs with the CloudFront domain
aws cognito-idp update-user-pool-client \
  --user-pool-id <UserPoolId> \
  --client-id <UserPoolClientId> \
  --supported-identity-providers COGNITO \
  --callback-urls "https://<CloudFront domain>/auth/callback" "http://localhost:5173/auth/callback" \
  --logout-urls "https://<CloudFront domain>/" "http://localhost:5173/" \
  --allowed-o-auth-flows code \
  --allowed-o-auth-scopes openid email profile \
  --allowed-o-auth-flows-user-pool-client \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
  --access-token-validity 1 --id-token-validity 1 --refresh-token-validity 30 \
  --token-validity-units "AccessToken=hours,IdToken=hours,RefreshToken=days" \
  --prevent-user-existence-errors ENABLED

# 6. Create your first user
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username user@example.com \
  --user-attributes Name=email,Value=user@example.com \
  --temporary-password 'TempPass123!'

# 7. Build and deploy the frontend
cd ../frontend
cat > .env.local << EOF
VITE_USER_POOL_ID=<UserPoolId>
VITE_CLIENT_ID=<UserPoolClientId>
VITE_COGNITO_DOMAIN=<CognitoDomain>
EOF
npm run build
aws s3 sync dist/ s3://<FrontendBucket>/ --delete
aws cloudfront create-invalidation --distribution-id <DistributionId> --paths "/*"

# 8. Add WorkerSecurityGroupId to your NFS server's inbound rules
#    Required ports: TCP 2049 (NFS), TCP/UDP 111 (rpcbind), TCP 635 (mountd for NFSv3)
```

## Teardown

```bash
cd infrastructure
npx cdk destroy -c env=dev -c vpcId=vpc-XXXXXXXXX --force
```

All resources use `removalPolicy: DESTROY` - the destroy command cleanly removes everything including S3 bucket contents and DynamoDB data.

## Project Structure

```
infrastructure/       CDK stack definition
  bin/app.ts          CDK app entry point
  lib/fio-bench-stack.ts  All AWS resources
backend/              Lambda functions
  api/handler.ts      API router
  api/runs.ts         Run CRUD + EC2 enrichment
  api/analytics.ts    Analytics queries
  orchestration/      Step Functions Lambdas
  ingestion/          Result aggregation
frontend/             React SPA
  src/pages/          Route pages (Dashboard, NewRun, RunDetail, Compare, Analytics)
  src/components/     Reusable components (NFS/FIO/Infra configurators, charts, auth)
  src/lib/            API client, auth module
shared/               Shared TypeScript types
  types/              Domain models (NFS config, FIO config, benchmark run)
  validation/         NFS + workload compatibility validator
worker/               EC2 worker bootstrap script
```

## VPC Requirements

The stack deploys worker EC2 instances into private subnets with NAT gateway access. The VPC must have:

- Private subnets with a route to a NAT gateway (for S3, SSM, and package downloads)
- DNS resolution enabled (the stack prepends the Amazon DNS resolver to handle custom DHCP option sets)

If your VPC uses a custom DHCP option set with internal DNS servers (common with Active Directory), the worker userdata automatically prepends the Amazon-provided DNS resolver (`169.254.169.253`) to ensure public hostname resolution.

## NFS Server Configuration

After deployment, add the `WorkerSecurityGroupId` (from stack outputs) to your NFS server's security group inbound rules:

| Port | Protocol | Purpose |
|------|----------|---------|
| 2049 | TCP | NFS |
| 111 | TCP/UDP | rpcbind (NFSv3 mount discovery) |
| 635 | TCP | mountd (FSx ONTAP NFSv3) |

For FSx for ONTAP, also verify the export policy allows access from the worker subnet CIDRs.

## Local Development

```bash
cd frontend
cp .env.example .env.local  # fill in CDK stack outputs
npm run dev                  # starts on http://localhost:5173
```

The Vite dev server proxies `/api` requests to the deployed API Gateway endpoint.
