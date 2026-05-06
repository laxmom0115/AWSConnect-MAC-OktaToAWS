# AWSConnect-MAC-OktaToAWS

Okta → AWS → Amazon Connect user provisioning infrastructure for CMS MAC environments.

Pilot MAC: **noridian** | Region: **us-east-1** | Okta org: **cms.okta.com**

See [`Amazon-Connect-Okta-Provisioning-Blueprint.md`](./Amazon-Connect-Okta-Provisioning-Blueprint.md) for the full architecture and design decisions.

---

## Architecture overview

```
Okta Event Hook
    │  POST /okta/connect-provision
    ▼
API Gateway
    │
    ▼
connect-webhook-receiver (Lambda)
  • Validates shared secret
  • Parses Okta group membership event
  • Enqueues ProvisioningTask to SQS
  • Returns HTTP 200 immediately (< 1 s)
    │
    ▼
connect-provisioning-queue (SQS)
  • Visibility timeout: 35 s
  • DLQ: connect-provisioning-dlq (3 retries, 14-day retention)
    │
    ▼
connect-provisioner-worker (Lambda, SQS consumer)
  • Fetches Okta user profile (Okta API)
  • Loads MAC config (SSM)
  • Creates / updates / disables user (Amazon Connect API)
  • Writes provisioning state (DynamoDB)
```

The two-Lambda design ensures the webhook receiver always responds to Okta within its ~3-second timeout window, while the worker handles the longer AWS API calls with full SQS retry semantics.

---

## Repository structure

```
.
├── bin/
│   └── app.ts                                  # CDK entry point
├── lib/
│   └── connect-provisioning-stack.ts           # CDK stack definition
├── lambda/
│   ├── connect-provisioner/
│   │   ├── index.ts                            # Webhook receiver Lambda (TypeScript)
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── connect-provisioner-worker/
│       ├── index.ts                            # SQS worker Lambda (TypeScript)
│       ├── package.json
│       └── tsconfig.json
├── cdk.json
├── package.json
├── tsconfig.json
└── Amazon-Connect-Okta-Provisioning-Blueprint.md
```

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 18.x |
| npm | 8.x |
| AWS CDK CLI | 2.x |
| AWS CLI | 2.x |

Install CDK CLI globally if you don't have it:

```bash
npm install -g aws-cdk
```

---

## Getting started

### 1 – Install dependencies

```bash
# CDK + infrastructure packages
npm install

# Webhook receiver Lambda packages
cd lambda/connect-provisioner && npm install && cd ../..

# Worker Lambda packages
cd lambda/connect-provisioner-worker && npm install && cd ../..
```

### 2 – Bootstrap CDK (first-time only per AWS account/region)

```bash
# Replace 123456789012 with your AWS account ID
cdk bootstrap aws://123456789012/us-east-1
```

### 3 – Synthesize (preview the CloudFormation template)

```bash
cdk synth
```

### 4 – Deploy

```bash
cdk deploy
```

The deployment takes ~2 minutes. On completion, CDK prints the key stack outputs:

```
Outputs:
ConnectProvisioningStack.ApiEndpoint             = https://<id>.execute-api.us-east-1.amazonaws.com/prod/okta/connect-provision
ConnectProvisioningStack.StateTableName          = connect-provisioning-state
ConnectProvisioningStack.OktaTokenSecretArn      = arn:aws:secretsmanager:us-east-1:...:secret:okta/api-token-...
ConnectProvisioningStack.ProvisioningQueueUrl    = https://sqs.us-east-1.amazonaws.com/<account>/connect-provisioning-queue
ConnectProvisioningStack.ProvisioningDlqUrl      = https://sqs.us-east-1.amazonaws.com/<account>/connect-provisioning-dlq
```

Copy the `ApiEndpoint` URL — you will need it when configuring the Okta Event Hook.

---

## Post-deployment configuration

### 5 – Store the real Okta API token in Secrets Manager

The CDK stack creates a **stub** secret. Replace the placeholder value with the real Okta API token:

```bash
# Replace <secret-arn> with the value from the stack output OktaTokenSecretArn
aws secretsmanager put-secret-value \
  --secret-id okta/api-token \
  --secret-string '{"token":"YOUR_REAL_OKTA_API_TOKEN"}'
```

> **Never** commit a real Okta API token to source control.

### 6 – Update the noridian SSM config with real Connect IDs

The CDK stack creates `/connect/macs/noridian` with placeholder IDs. Replace them with real values gathered from your Amazon Connect console:

```bash
aws ssm put-parameter \
  --name /connect/macs/noridian \
  --type String \
  --overwrite \
  --value '{
    "mac": "noridian",
    "instanceId": "<REAL_CONNECT_INSTANCE_ID>",
    "usernameSource": "email",
    "routingProfileIdBaseline": "<REAL_ROUTING_PROFILE_ID>",
    "securityProfiles": {
      "agent": "<REAL_AGENT_SECURITY_PROFILE_ID>",
      "supervisor": "<REAL_SUPERVISOR_SECURITY_PROFILE_ID>",
      "admin": "<REAL_ADMIN_SECURITY_PROFILE_ID>"
    },
    "hierarchyGroupId": "<OPTIONAL_HIERARCHY_GROUP_ID_OR_EMPTY_STRING>"
  }'
```

To find the IDs in the AWS console:
- **Instance ID**: Amazon Connect → Instances → click instance → copy ID from the URL or *Overview* tab.
- **Routing/Security profile IDs**: Amazon Connect → Routing profiles / Security profiles → select the profile → the ARN contains the ID.

### 7 – (Optional) Set a shared secret for the Okta Event Hook

Set `OKTA_SHARED_SECRET` as a Lambda environment variable so the handler validates `X-Okta-Secret` header:

```bash
aws lambda update-function-configuration \
  --function-name connect-webhook-receiver \
  --environment "Variables={
    OKTA_SHARED_SECRET=<YOUR_SHARED_SECRET>,
    OKTA_BASE_URL=https://cms.okta.com,
    PROVISIONING_QUEUE_URL=<QUEUE_URL_FROM_STACK_OUTPUT>
  }"
```

Alternatively, add the secret value to the CDK stack before deploying and re-deploy.

---

## Testing the endpoint

### Quick smoke test (no auth)

```bash
# Leave OKTA_SHARED_SECRET unset during initial testing
curl -s -X POST \
  https://<your-api-id>.execute-api.us-east-1.amazonaws.com/prod/okta/connect-provision \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "events": [{
        "eventType": "group.user_membership.add",
        "target": [
          {"type": "User", "id": "00u1test000USER", "displayName": "Test User", "alternateId": "test@example.com"},
          {"type": "UserGroup", "id": "00g1test000GROUP", "displayName": "connect_noridian_agent"}
        ]
      }]
    }
  }'
```

Expected response:

```json
{
  "action": "ADDED",
  "oktaUserId": "00u1test000USER",
  "groupName": "connect_noridian_agent",
  "mac": "noridian",
  "role": "agent",
  "message": "Event accepted"
}
```

The receiver enqueues the task to SQS and returns immediately. The worker Lambda processes the task asynchronously — check CloudWatch logs for `connect-provisioner-worker` to see the Connect API calls.

### Test with shared secret header

```bash
curl -s -X POST \
  https://<your-api-id>.execute-api.us-east-1.amazonaws.com/prod/okta/connect-provision \
  -H "Content-Type: application/json" \
  -H "X-Okta-Secret: <YOUR_SHARED_SECRET>" \
  -d '{ ... }'
```

### Test REMOVED event

```bash
curl -s -X POST \
  https://<your-api-id>.execute-api.us-east-1.amazonaws.com/prod/okta/connect-provision \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "events": [{
        "eventType": "group.user_membership.remove",
        "target": [
          {"type": "User", "id": "00u1test000USER", "displayName": "Test User", "alternateId": "test@example.com"},
          {"type": "UserGroup", "id": "00g1test000GROUP", "displayName": "connect_noridian_agent"}
        ]
      }]
    }
  }'
```

---

## Configuring the Okta Event Hook

1. In Okta admin: **Workflow → Event Hooks → Create Event Hook**
2. Enter the `ApiEndpoint` URL from the CDK output.
3. Subscribe to events:
   - `group.user_membership.add`
   - `group.user_membership.remove`
4. Add a custom header: `X-Okta-Secret: <YOUR_SHARED_SECRET>` (if using shared secret validation).
5. Verify/activate the hook — Okta will send a verification request; the Lambda returns 200 by default.

---

## Deploying to additional MACs

1. Add a new SSM parameter `/connect/macs/<macname>` following the same JSON structure.
2. Create three Okta groups: `connect_<macname>_agent`, `connect_<macname>_supervisor`, `connect_<macname>_admin`.
3. The existing Lambda will automatically load the new config once the SSM parameter exists.
4. No CDK or Lambda code changes are needed.

---

## Monitoring failed provisioning tasks

If the worker Lambda fails to process a task after 3 attempts, SQS moves it to the dead-letter queue (`connect-provisioning-dlq`).

Inspect failed messages:

```bash
# Replace <dlq-url> with the ProvisioningDlqUrl stack output
aws sqs receive-message \
  --queue-url <dlq-url> \
  --max-number-of-messages 10 \
  --attribute-names All
```

To replay a failed message after fixing the underlying issue:

```bash
# 1. Receive the message (capture ReceiptHandle)
MSG=$(aws sqs receive-message --queue-url <dlq-url> --max-number-of-messages 1)

# 2. Re-send to the main queue
aws sqs send-message \
  --queue-url <main-queue-url> \
  --message-body "$(echo $MSG | jq -r '.Messages[0].Body')" \
  --message-group-id "$(echo $MSG | jq -r '.Messages[0].Body | fromjson | .mac')"

# 3. Delete from DLQ
aws sqs delete-message \
  --queue-url <dlq-url> \
  --receipt-handle "$(echo $MSG | jq -r '.Messages[0].ReceiptHandle')"
```

---

## Destroy / teardown

```bash
cdk destroy
```

> **Note:** The DynamoDB table has `RemovalPolicy.RETAIN` — it will NOT be deleted when you run `cdk destroy`. Delete it manually if you want to fully clean up.

---

## Development

```bash
# Type-check CDK stack
npx tsc --noEmit

# Type-check webhook receiver Lambda
cd lambda/connect-provisioner && npx tsc --noEmit && cd ../..

# Type-check worker Lambda
cd lambda/connect-provisioner-worker && npx tsc --noEmit && cd ../..

# Synthesize CDK template
cdk synth
```
