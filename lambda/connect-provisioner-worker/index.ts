import { SQSEvent, SQSBatchResponse } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import {
  ConnectClient,
  CreateUserCommand,
  UpdateUserSecurityProfilesCommand,
  UpdateUserRoutingProfileCommand,
  UpdateUserHierarchyCommand,
  ListUsersCommand,
} from '@aws-sdk/client-connect';

// ── AWS SDK clients (singleton) ──────────────────────────────────────────────
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});
const connectClient = new ConnectClient({});

// ── Environment variables ─────────────────────────────────────────────────────
const OKTA_BASE_URL = process.env.OKTA_BASE_URL ?? 'https://cms.okta.com';
const SSM_CONFIG_PREFIX = process.env.SSM_CONFIG_PREFIX ?? '/connect/macs/';
const STATE_TABLE_NAME = process.env.STATE_TABLE_NAME ?? 'connect-provisioning-state';
const OKTA_API_TOKEN_SECRET_ARN = process.env.OKTA_API_TOKEN_SECRET_ARN ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────
/** Message schema written to SQS by the receiver Lambda and consumed here. */
interface ProvisioningTask {
  action: 'ADDED' | 'REMOVED' | 'UNKNOWN';
  oktaUserId: string;
  groupName: string;
  mac: string;
  role: 'agent' | 'supervisor' | 'admin';
  receivedAt: string;
}

interface MacConfig {
  mac: string;
  instanceId: string;
  usernameSource: 'email' | 'euaId';
  routingProfileIdBaseline: string;
  securityProfiles: {
    agent: string;
    supervisor: string;
    admin: string;
  };
  hierarchyGroupId?: string;
}

interface OktaUserProfile {
  email: string;
  firstName: string;
  lastName: string;
  euaId?: string;
}

interface OktaGroup {
  profile: { name: string };
}

// ── SSM helper ────────────────────────────────────────────────────────────────
async function loadMacConfig(mac: string): Promise<MacConfig> {
  const paramName = `${SSM_CONFIG_PREFIX}${mac}`;
  const response = await ssmClient.send(
    new GetParameterCommand({ Name: paramName, WithDecryption: true }),
  );
  if (!response.Parameter?.Value) {
    throw new Error(`SSM parameter ${paramName} is empty or missing`);
  }
  return JSON.parse(response.Parameter.Value) as MacConfig;
}

// ── Secrets Manager helper ────────────────────────────────────────────────────
async function getOktaToken(): Promise<string> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: OKTA_API_TOKEN_SECRET_ARN }),
  );
  const raw = response.SecretString;
  if (!raw) throw new Error('Okta API token secret is empty');
  const parsed = JSON.parse(raw) as { token?: string };
  if (!parsed.token) throw new Error('Okta API token secret missing "token" key');
  return parsed.token;
}

// ── Okta API helpers ──────────────────────────────────────────────────────────
async function fetchOktaUser(oktaUserId: string, token: string): Promise<OktaUserProfile> {
  const url = `${OKTA_BASE_URL}/api/v1/users/${encodeURIComponent(oktaUserId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Okta API GET /users/${oktaUserId} returned ${res.status}`);
  }
  const body = await res.json() as { profile: OktaUserProfile };
  return body.profile;
}

async function listOktaUserGroups(oktaUserId: string, token: string): Promise<OktaGroup[]> {
  const url = `${OKTA_BASE_URL}/api/v1/users/${encodeURIComponent(oktaUserId)}/groups`;
  const res = await fetch(url, {
    headers: { Authorization: `SSWS ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Okta API GET /users/${oktaUserId}/groups returned ${res.status}`);
  }
  return res.json() as Promise<OktaGroup[]>;
}

// ── Security profile stacking ─────────────────────────────────────────────────
function stackProfiles(
  profiles: MacConfig['securityProfiles'],
  role: 'agent' | 'supervisor' | 'admin',
): string[] {
  switch (role) {
    case 'admin':
      return [profiles.admin, profiles.supervisor, profiles.agent];
    case 'supervisor':
      return [profiles.supervisor, profiles.agent];
    case 'agent':
    default:
      return [profiles.agent];
  }
}

// ── DynamoDB helpers ──────────────────────────────────────────────────────────
async function getState(pk: string) {
  const result = await dynamoClient.send(
    new GetCommand({ TableName: STATE_TABLE_NAME, Key: { pk } }),
  );
  return result.Item;
}

async function updateState(
  pk: string,
  attrs: Record<string, unknown>,
): Promise<void> {
  // Build a safe UpdateExpression from the provided attributes.
  // Using UpdateCommand rather than PutCommand prevents concurrent writes from
  // overwriting attributes set by other in-flight messages for the same user.
  const keys = Object.keys(attrs);
  const updateParts = keys.map((k) => `#${k} = :${k}`);
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  for (const k of keys) {
    expressionAttributeNames[`#${k}`] = k;
    expressionAttributeValues[`:${k}`] = attrs[k];
  }

  await dynamoClient.send(
    new UpdateCommand({
      TableName: STATE_TABLE_NAME,
      Key: { pk },
      UpdateExpression: `SET ${updateParts.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    }),
  );
}

// ── Amazon Connect helpers ────────────────────────────────────────────────────
async function findConnectUserByUsername(
  instanceId: string,
  connectUsername: string,
): Promise<string | undefined> {
  // ListUsers is paginated; scan until we find the user or exhaust all pages
  let nextToken: string | undefined;
  do {
    const res = await connectClient.send(
      new ListUsersCommand({ InstanceId: instanceId, NextToken: nextToken }),
    );
    const match = res.UserSummaryList?.find((u) => u.Username === connectUsername);
    if (match?.Id) return match.Id;
    nextToken = res.NextToken;
  } while (nextToken);
  return undefined;
}

async function createConnectUser(
  instanceId: string,
  connectUsername: string,
  profile: OktaUserProfile,
  config: MacConfig,
  role: 'agent' | 'supervisor' | 'admin',
): Promise<string> {
  const res = await connectClient.send(
    new CreateUserCommand({
      InstanceId: instanceId,
      Username: connectUsername,
      IdentityInfo: {
        FirstName: profile.firstName,
        LastName: profile.lastName,
        Email: profile.email,
      },
      PhoneConfig: {
        // SOFT_PHONE is the standard for Agent Workspace users
        PhoneType: 'SOFT_PHONE',
      },
      SecurityProfileIds: stackProfiles(config.securityProfiles, role),
      RoutingProfileId: config.routingProfileIdBaseline,
      ...(config.hierarchyGroupId ? { HierarchyGroupId: config.hierarchyGroupId } : {}),
    }),
  );
  if (!res.UserId) throw new Error(`CreateUser did not return a UserId for ${connectUsername}`);
  return res.UserId;
}

async function updateConnectUserProfiles(
  instanceId: string,
  connectUserId: string,
  config: MacConfig,
  role: 'agent' | 'supervisor' | 'admin',
): Promise<void> {
  await connectClient.send(
    new UpdateUserSecurityProfilesCommand({
      InstanceId: instanceId,
      UserId: connectUserId,
      SecurityProfileIds: stackProfiles(config.securityProfiles, role),
    }),
  );
  await connectClient.send(
    new UpdateUserRoutingProfileCommand({
      InstanceId: instanceId,
      UserId: connectUserId,
      RoutingProfileId: config.routingProfileIdBaseline,
    }),
  );
  if (config.hierarchyGroupId) {
    await connectClient.send(
      new UpdateUserHierarchyCommand({
        InstanceId: instanceId,
        UserId: connectUserId,
        HierarchyGroupId: config.hierarchyGroupId,
      }),
    );
  }
}

// ── Core provisioning logic ───────────────────────────────────────────────────
async function processTask(task: ProvisioningTask): Promise<void> {
  const { action, oktaUserId, mac, role } = task;

  console.log('[connect-provisioner-worker] Processing task', { action, oktaUserId, mac, role });

  // 1. Load MAC config from SSM
  const config = await loadMacConfig(mac);

  // 2. Fetch authoritative user profile from Okta API
  const token = await getOktaToken();
  const oktaProfile = await fetchOktaUser(oktaUserId, token);

  // 3. Determine Connect username based on per-MAC usernameSource config
  const connectUsername =
    config.usernameSource === 'euaId' && oktaProfile.euaId
      ? oktaProfile.euaId
      : oktaProfile.email;

  const pk = `${mac}#${connectUsername}`;

  if (action === 'ADDED') {
    // 4a. Check DynamoDB for existing state — prefer cached connectUserId to avoid ListUsers scan
    const existingState = await getState(pk);
    let connectUserId = existingState?.connectUserId as string | undefined;

    if (!connectUserId) {
      // 4b. Fall back to a Connect ListUsers scan for idempotency on retries
      connectUserId = await findConnectUserByUsername(config.instanceId, connectUsername);
    }

    if (!connectUserId) {
      // 4c. User does not exist — create
      connectUserId = await createConnectUser(
        config.instanceId,
        connectUsername,
        oktaProfile,
        config,
        role,
      );
      console.log('[connect-provisioner-worker] Created Connect user', { connectUserId, connectUsername, mac });
    } else {
      // 4d. User exists — update security profiles + routing profile
      await updateConnectUserProfiles(config.instanceId, connectUserId, config, role);
      console.log('[connect-provisioner-worker] Updated Connect user profiles', { connectUserId, mac, role });
    }

    await updateState(pk, {
      oktaUserId,
      mac,
      connectUsername,
      connectInstanceId: config.instanceId,
      connectUserId,
      currentRole: role,
      status: 'PROVISIONED',
      updatedAt: new Date().toISOString(),
    });

  } else if (action === 'REMOVED') {
    // 5. Removal guard — skip disable if user is still in any connect_{mac}_* group
    //    (prevents disabling during role transitions, e.g. agent → supervisor)
    const groups = await listOktaUserGroups(oktaUserId, token);
    const connectGroupPattern = new RegExp(`^connect_${mac}_(agent|supervisor|admin)$`);
    const stillHasAccess = groups.some((g) => connectGroupPattern.test(g.profile.name));

    if (stillHasAccess) {
      console.log('[connect-provisioner-worker] User still in a connect group — skipping disable', { oktaUserId, mac });
      return;
    }

    // User is no longer in any connect group for this MAC — disable
    const existingState = await getState(pk);
    const connectUserId = existingState?.connectUserId as string | undefined;

    if (connectUserId) {
      // Disable by removing all security profiles (Connect has no explicit "disable" API on users)
      await connectClient.send(
        new UpdateUserSecurityProfilesCommand({
          InstanceId: config.instanceId,
          UserId: connectUserId,
          SecurityProfileIds: [],
        }),
      );
      console.log('[connect-provisioner-worker] Disabled Connect user', { connectUserId, mac });
    } else {
      console.log('[connect-provisioner-worker] Connect user not found in state — nothing to disable', { mac, oktaUserId });
    }

    await updateState(pk, {
      oktaUserId,
      mac,
      connectUsername,
      connectInstanceId: config.instanceId,
      connectUserId: connectUserId ?? null,
      currentRole: role,
      status: 'DISABLED',
      updatedAt: new Date().toISOString(),
    });

  } else {
    console.log('[connect-provisioner-worker] Unknown action — skipping', { action, mac, oktaUserId });
  }
}

// ── SQS handler ───────────────────────────────────────────────────────────────
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const task = JSON.parse(record.body) as ProvisioningTask;
      await processTask(task);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[connect-provisioner-worker] Failed to process record', {
        messageId: record.messageId,
        error: message,
      });
      // Report partial failure so SQS retries only this message, not the whole batch
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
