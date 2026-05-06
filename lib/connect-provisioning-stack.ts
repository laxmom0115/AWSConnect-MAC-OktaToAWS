import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';

export class ConnectProvisioningStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── DynamoDB state table ──────────────────────────────────────────────────
    const stateTable = new dynamodb.Table(this, 'ConnectProvisioningState', {
      tableName: 'connect-provisioning-state',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      // Streams enable future audit/notification Lambda triggered on every state change
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // GSI on oktaUserId — enables reverse lookup (find all Connect users for a given Okta user)
    stateTable.addGlobalSecondaryIndex({
      indexName: 'oktaUserId-index',
      partitionKey: { name: 'oktaUserId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── Secrets Manager: Okta API token stub ─────────────────────────────────
    const oktaTokenSecret = new secretsmanager.Secret(this, 'OktaApiTokenSecret', {
      secretName: 'okta/api-token',
      description: 'Okta API token used by the connect-provisioner Lambda (cms.okta.com)',
      // Do NOT set secretStringValue here — populate via CLI after deployment
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ note: 'Replace with real Okta API token' }),
        generateStringKey: 'placeholder',
      },
    });

    // ── SSM Parameter Store: noridian MAC config stub ─────────────────────────
    const noridianConfig = {
      mac: 'noridian',
      instanceId: '<NORIDIAN_CONNECT_INSTANCE_ID>',
      usernameSource: 'email',
      routingProfileIdBaseline: '<NORIDIAN_ROUTING_PROFILE_ID>',
      securityProfiles: {
        agent: '<NORIDIAN_SECURITY_PROFILE_ID_AGENT>',
        supervisor: '<NORIDIAN_SECURITY_PROFILE_ID_SUPERVISOR>',
        admin: '<NORIDIAN_SECURITY_PROFILE_ID_ADMIN>',
      },
      hierarchyGroupId: '<OPTIONAL_HIERARCHY_GROUP_ID>',
    };

    new ssm.StringParameter(this, 'NoridianMacConfig', {
      parameterName: '/connect/macs/noridian',
      description: 'Amazon Connect provisioning config for noridian MAC (pilot)',
      stringValue: JSON.stringify(noridianConfig),
      tier: ssm.ParameterTier.STANDARD,
    });

    // ── SQS Dead-letter queue ─────────────────────────────────────────────────
    const provisioningDlq = new sqs.Queue(this, 'ConnectProvisioningDlq', {
      queueName: 'connect-provisioning-dlq',
      // Retain messages for 14 days so operators can inspect and replay failures
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SQS main provisioning queue ───────────────────────────────────────────
    const provisioningQueue = new sqs.Queue(this, 'ConnectProvisioningQueue', {
      queueName: 'connect-provisioning-queue',
      // Visibility timeout must exceed the worker Lambda timeout (30 s) with margin
      visibilityTimeout: cdk.Duration.seconds(35),
      retentionPeriod: cdk.Duration.days(4),
      deadLetterQueue: { queue: provisioningDlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Webhook receiver Lambda ───────────────────────────────────────────────
    // Responsibilities: validate shared secret, parse Okta payload, enqueue task.
    // Must return HTTP 200 to Okta within ~3 seconds — no Connect/SSM/DDB calls here.
    const receiver = new lambda.Function(this, 'ConnectWebhookReceiver', {
      functionName: 'connect-webhook-receiver',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/connect-provisioner'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm ci --omit=dev',
              'npx tsc --outDir /asset-output --rootDir . --module commonjs --target ES2020 --esModuleInterop true --skipLibCheck true',
              'cp -r node_modules /asset-output/',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        PROVISIONING_QUEUE_URL: provisioningQueue.queueUrl,
        // Empty by default; set a real value post-deployment via the AWS console or
        // `aws lambda update-function-configuration` to enable shared-secret validation.
        // See README.md section 7 for instructions.
        OKTA_SHARED_SECRET: '',
      },
      description: 'Receives Okta Event Hook webhooks, validates the request, and enqueues a provisioning task',
    });

    // Receiver only needs to send messages — least-privilege
    provisioningQueue.grantSendMessages(receiver);

    // ── Provisioner worker Lambda ─────────────────────────────────────────────
    // Responsibilities: load MAC config, fetch Okta user profile, call Amazon Connect,
    // update DynamoDB state.  Retries are handled by SQS + DLQ.
    const worker = new lambda.Function(this, 'ConnectProvisionerWorker', {
      functionName: 'connect-provisioner-worker',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/connect-provisioner-worker'), {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          command: [
            'bash', '-c',
            [
              'npm ci --omit=dev',
              'npx tsc --outDir /asset-output --rootDir . --module commonjs --target ES2020 --esModuleInterop true --skipLibCheck true',
              'cp -r node_modules /asset-output/',
            ].join(' && '),
          ],
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        OKTA_BASE_URL: 'https://cms.okta.com',
        SSM_CONFIG_PREFIX: '/connect/macs/',
        STATE_TABLE_NAME: stateTable.tableName,
        OKTA_API_TOKEN_SECRET_ARN: oktaTokenSecret.secretArn,
      },
      description: 'SQS consumer: fetches Okta user profile, provisions/deprovisions Amazon Connect users, updates DynamoDB state',
    });

    // Trigger worker from SQS — batchSize 1 + partial batch failure reporting so only
    // failed individual messages are retried (not the whole batch)
    worker.addEventSource(new lambdaEventSources.SqsEventSource(provisioningQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // Grant worker access to DynamoDB
    stateTable.grantReadWriteData(worker);

    // Grant worker access to read the Okta token secret
    oktaTokenSecret.grantRead(worker);

    // Grant worker access to SSM parameters under /connect/macs/*
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/connect/macs/*`,
      ],
    }));

    // Grant worker Amazon Connect user management permissions
    worker.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'connect:CreateUser',
        'connect:UpdateUserIdentityInfo',
        'connect:UpdateUserSecurityProfiles',
        'connect:UpdateUserRoutingProfile',
        'connect:UpdateUserHierarchy',
        'connect:DescribeUser',
        'connect:ListUsers',
        'connect:DeleteUser',
      ],
      resources: ['*'],
      // TODO: restrict to specific Connect instance ARNs once instance IDs are known
    }));

    // ── API Gateway ───────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'OktaConnectApi', {
      restApiName: 'okta-connect-provisioning-api',
      description: 'API Gateway for Okta Event Hook → Amazon Connect provisioning',
      deployOptions: {
        stageName: 'prod',
        throttlingBurstLimit: 50,
        throttlingRateLimit: 25,
      },
      defaultCorsPreflightOptions: undefined,
    });

    const oktaResource = api.root.addResource('okta');
    const provisionResource = oktaResource.addResource('connect-provision');

    provisionResource.addMethod(
      'POST',
      new apigateway.LambdaIntegration(receiver, {
        proxy: true,
      }),
    );

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: `${api.url}okta/connect-provision`,
      description: 'POST endpoint for Okta Event Hook webhook',
      exportName: 'OktaConnectProvisionEndpoint',
    });

    new cdk.CfnOutput(this, 'StateTableName', {
      value: stateTable.tableName,
      description: 'DynamoDB table storing provisioning state',
    });

    new cdk.CfnOutput(this, 'OktaTokenSecretArn', {
      value: oktaTokenSecret.secretArn,
      description: 'Secrets Manager ARN for Okta API token',
    });

    new cdk.CfnOutput(this, 'ProvisioningQueueUrl', {
      value: provisioningQueue.queueUrl,
      description: 'SQS queue URL for provisioning tasks',
    });

    new cdk.CfnOutput(this, 'ProvisioningDlqUrl', {
      value: provisioningDlq.queueUrl,
      description: 'SQS dead-letter queue URL — inspect here for permanently failed provisioning tasks',
    });
  }
}
