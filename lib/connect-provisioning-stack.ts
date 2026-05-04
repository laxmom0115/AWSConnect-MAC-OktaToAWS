import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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

    // ── Lambda function ───────────────────────────────────────────────────────
    const provisioner = new lambda.Function(this, 'ConnectProvisioner', {
      functionName: 'connect-provisioner',
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
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        OKTA_BASE_URL: 'https://cms.okta.com',
        SSM_CONFIG_PREFIX: '/connect/macs/',
        STATE_TABLE_NAME: stateTable.tableName,
        OKTA_API_TOKEN_SECRET_ARN: oktaTokenSecret.secretArn,
        // Empty by default; set a real value post-deployment via the AWS console or
        // `aws lambda update-function-configuration` to enable shared-secret validation.
        // See README.md section 7 for instructions.
        OKTA_SHARED_SECRET: '',
      },
      description: 'Handles Okta Event Hook webhook to provision/deprovision Amazon Connect users',
    });

    // Grant Lambda access to DynamoDB
    stateTable.grantReadWriteData(provisioner);

    // Grant Lambda access to read the Okta token secret
    oktaTokenSecret.grantRead(provisioner);

    // Grant Lambda access to SSM parameters under /connect/macs/*
    provisioner.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/connect/macs/*`,
      ],
    }));

    // Grant Lambda Amazon Connect user management permissions
    provisioner.addToRolePolicy(new iam.PolicyStatement({
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
      new apigateway.LambdaIntegration(provisioner, {
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
  }
}
