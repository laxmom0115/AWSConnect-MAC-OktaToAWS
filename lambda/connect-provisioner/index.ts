import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

// ── AWS SDK clients (singleton) ──────────────────────────────────────────────
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssmClient = new SSMClient({});
const secretsClient = new SecretsManagerClient({});

// ── Environment variables ─────────────────────────────────────────────────────
const OKTA_BASE_URL = process.env.OKTA_BASE_URL ?? 'https://cms.okta.com';
const SSM_CONFIG_PREFIX = process.env.SSM_CONFIG_PREFIX ?? '/connect/macs/';
const STATE_TABLE_NAME = process.env.STATE_TABLE_NAME ?? 'connect-provisioning-state';
const OKTA_API_TOKEN_SECRET_ARN = process.env.OKTA_API_TOKEN_SECRET_ARN ?? '';
const OKTA_SHARED_SECRET = process.env.OKTA_SHARED_SECRET ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────
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

interface ParsedGroup {
  mac: string;
  role: 'agent' | 'supervisor' | 'admin';
}

/** Okta Event Hook payload shape (simplified). */
interface OktaEventHookPayload {
  data?: {
    events?: Array<{
      eventType?: string;
      target?: Array<{
        type?: string;
        displayName?: string;
        id?: string;
        alternateId?: string;
      }>;
    }>;
  };
  /** Direct fields used in some webhook variants */
  eventType?: string;
  target?: Array<{ type?: string; displayName?: string; id?: string; alternateId?: string }>;
}

// ── Group name parsing ────────────────────────────────────────────────────────
const GROUP_PATTERN = /^connect_(?<mac>[a-z0-9]+)_(?<role>agent|supervisor|admin)$/;

function parseGroupName(groupName: string): ParsedGroup | null {
  const match = GROUP_PATTERN.exec(groupName);
  if (!match?.groups) return null;
  return {
    mac: match.groups['mac'],
    role: match.groups['role'] as 'agent' | 'supervisor' | 'admin',
  };
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

// ── DynamoDB helpers ──────────────────────────────────────────────────────────
async function getState(pk: string) {
  const result = await dynamoClient.send(
    new GetCommand({ TableName: STATE_TABLE_NAME, Key: { pk } }),
  );
  return result.Item;
}

async function putState(
  pk: string,
  attrs: Record<string, unknown>,
): Promise<void> {
  await dynamoClient.send(
    new PutCommand({
      TableName: STATE_TABLE_NAME,
      Item: { pk, updatedAt: new Date().toISOString(), ...attrs },
    }),
  );
}

// ── Shared secret validation ──────────────────────────────────────────────────
function validateSharedSecret(headers: Record<string, string | undefined>): void {
  if (!OKTA_SHARED_SECRET) return; // validation skipped when unset
  const incoming =
    headers['x-okta-secret'] ??
    headers['X-Okta-Secret'] ??
    headers['x-okta-verification-challenge'];
  if (incoming !== OKTA_SHARED_SECRET) {
    throw new Error('Shared secret validation failed');
  }
}

// ── Safe payload logger (masks sensitive fields) ──────────────────────────────
function safeLog(label: string, payload: unknown): void {
  const serialised = JSON.stringify(payload, (key, value: unknown) => {
    if (typeof key === 'string' && /token|secret|password|credential/i.test(key)) {
      return '[REDACTED]';
    }
    return value;
  });
  console.log(`[connect-provisioner] ${label}: ${serialised}`);
}

// ── Extract action + group name + user id from Okta payload ──────────────────
function parseOktaPayload(body: OktaEventHookPayload): {
  action: 'ADDED' | 'REMOVED' | 'UNKNOWN';
  oktaUserId: string | null;
  groupName: string | null;
} {
  // Support both top-level and nested event structures
  const events = body?.data?.events ?? (body?.eventType ? [body] : []);
  if (!events.length) {
    return { action: 'UNKNOWN', oktaUserId: null, groupName: null };
  }

  const event = events[0] as {
    eventType?: string;
    target?: Array<{ type?: string; displayName?: string; id?: string; alternateId?: string }>;
  };
  const eventType = event.eventType ?? '';

  let action: 'ADDED' | 'REMOVED' | 'UNKNOWN' = 'UNKNOWN';
  if (eventType.includes('group.user_membership.add')) action = 'ADDED';
  else if (eventType.includes('group.user_membership.remove')) action = 'REMOVED';

  const targets = event.target ?? [];
  const userTarget = targets.find((t) => t.type === 'User');
  const groupTarget = targets.find((t) => t.type === 'UserGroup');

  return {
    action,
    oktaUserId: userTarget?.id ?? null,
    groupName: groupTarget?.displayName ?? null,
  };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  // 1. Validate shared secret
  try {
    validateSharedSecret(event.headers as Record<string, string | undefined>);
  } catch {
    return { statusCode: 401, body: JSON.stringify({ message: 'Unauthorized' }) };
  }

  // 2. Parse body safely
  let payload: OktaEventHookPayload = {};
  try {
    if (event.body) {
      payload = JSON.parse(event.body) as OktaEventHookPayload;
    }
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Invalid JSON body' }) };
  }

  safeLog('Received payload', payload);

  // 3. Extract action, user, group
  const { action, oktaUserId, groupName } = parseOktaPayload(payload);

  safeLog('Parsed event', { action, oktaUserId, groupName });

  // 4. Parse group name to extract mac + role
  const parsed = groupName ? parseGroupName(groupName) : null;

  const responseBase = {
    action,
    oktaUserId,
    groupName,
    mac: parsed?.mac ?? null,
    role: parsed?.role ?? null,
  };

  // 5. If we cannot determine mac/role, return 200 (Okta requires 200 for delivery)
  if (!parsed || !oktaUserId) {
    safeLog('Cannot determine mac/role or user — skipping provisioning', responseBase);
    return {
      statusCode: 200,
      body: JSON.stringify({ ...responseBase, message: 'Skipped: incomplete event data' }),
    };
  }

  const { mac, role } = parsed;

  try {
    // 6. Load MAC config from SSM
    const config = await loadMacConfig(mac);

    // TODO: fetch Okta user profile from Okta API
    // const oktaUser = await fetchOktaUser(oktaUserId, await getOktaToken());
    // const email = oktaUser.profile.email;
    // const firstName = oktaUser.profile.firstName ?? '';
    // const lastName = oktaUser.profile.lastName ?? '';
    // const euaId = oktaUser.profile.euaId;
    // const connectUsername = config.usernameSource === 'euaId' ? euaId : email;

    // Placeholder until Okta API integration is complete
    const connectUsername = `PLACEHOLDER_${oktaUserId}`;

    const pk = `${mac}#${connectUsername}`;

    if (action === 'ADDED') {
      const existingState = await getState(pk);
      const connectUserId: string | undefined =
        (existingState?.connectUserId as string | undefined);

      // TODO: look up Connect user by username if connectUserId not found in state
      // const resolvedUserId = connectUserId ?? await findConnectUserByUsername(config.instanceId, connectUsername);

      if (!connectUserId) {
        // TODO: create user in Amazon Connect
        // await connect.createUser({ InstanceId: config.instanceId, Username: connectUsername, ... });
        console.log('[connect-provisioner] TODO: create Connect user', {
          instanceId: config.instanceId,
          connectUsername,
          profiles: stackProfiles(config.securityProfiles, role),
          routingProfile: config.routingProfileIdBaseline,
        });
      } else {
        // TODO: update security profiles + routing profile
        // await connect.updateUserSecurityProfiles({ InstanceId: config.instanceId, UserId: connectUserId, ... });
        console.log('[connect-provisioner] TODO: update Connect user', {
          instanceId: config.instanceId,
          connectUserId,
          profiles: stackProfiles(config.securityProfiles, role),
        });
      }

      await putState(pk, {
        mac,
        oktaUserId,
        connectUsername,
        connectInstanceId: config.instanceId,
        connectUserId: connectUserId ?? null,
        currentRole: role,
        status: 'PROVISIONED',
      });
    } else if (action === 'REMOVED') {
      // TODO: call Okta API to verify user is no longer in any connect_{mac}_* group before disabling
      // const groups = await listOktaUserGroups(oktaUserId, await getOktaToken());
      // const stillHasAccess = groups.some(g => /^connect_{mac}_(agent|supervisor|admin)$/.test(g.profile.name));
      // if (stillHasAccess) { return 200 with skip message }

      // TODO: disable user in Amazon Connect
      // await connect.updateUserIdentityInfo({ InstanceId: ..., UserId: ..., IdentityInfo: { ... } });
      console.log('[connect-provisioner] TODO: disable Connect user for', { mac, oktaUserId });

      await putState(pk, {
        mac,
        oktaUserId,
        connectUsername,
        connectInstanceId: config.instanceId,
        connectUserId: null,
        currentRole: role,
        status: 'DISABLED',
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ...responseBase,
        message: `${action} event processed (stub)`,
        connectUsername,
      }),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[connect-provisioner] Error processing event', { mac, role, action, message });
    return {
      statusCode: 200, // return 200 to prevent Okta from treating as hook failure
      body: JSON.stringify({ ...responseBase, message: 'Internal error — logged', error: message }),
    };
  }
}

// ── Unused SDK reference (prevents dead-code warnings; will be used in TODOs) ─
void OKTA_BASE_URL;
void OKTA_API_TOKEN_SECRET_ARN;
void secretsClient;
void ssmClient;
