#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ConnectProvisioningStack } from '../lib/connect-provisioning-stack';

const app = new cdk.App();

new ConnectProvisioningStack(app, 'ConnectProvisioningStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-east-1',
  },
  description: 'Okta → AWS → Amazon Connect user provisioning infrastructure (pilot: noridian)',
});
