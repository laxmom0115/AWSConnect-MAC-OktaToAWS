import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

// ── AWS SDK clients (singleton) ──────────────────────────────────────────────
const sqsClient = new SQSClient({});

// ── Environment variables ─────────────────────────────────────────────────────
const OKTA_BASE_URL = process.env.OKTA_BASE_URL ?? 'https://cms.okta.com';
const PROVISIONING_QUEUE_URL = process.env.PROVISIONING_QUEUE_URL ?? '';
const OKTA_SHARED_SECRET = process.env.OKTA_SHARED_SECRET ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────
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

/** Message schema written to SQS and consumed by the worker Lambda. */
export interface ProvisioningTask {
  action: 'ADDED' | 'REMOVED' | 'UNKNOWN';
  oktaUserId: string;
  groupName: string;
  mac: string;
  role: 'agent' | 'supervisor' | 'admin';
  receivedAt: string;
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
  console.log(`[connect-webhook-receiver] ${label}: ${serialised}`);
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
  // 1. Validate shared secret — return 401 immediately if invalid
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

  // 5. If we cannot determine mac/role/user, return 200 (Okta requires 200 for delivery)
  if (!parsed || !oktaUserId || !groupName) {
    safeLog('Cannot determine mac/role or user — skipping enqueue', responseBase);
    return {
      statusCode: 200,
      body: JSON.stringify({ ...responseBase, message: 'Skipped: incomplete event data' }),
    };
  }

  const { mac, role } = parsed;

  // 6. Enqueue the provisioning task — all long-running work happens in the worker Lambda
  const task: ProvisioningTask = {
    action,
    oktaUserId,
    groupName,
    mac,
    role,
    receivedAt: new Date().toISOString(),
  };

  try {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: PROVISIONING_QUEUE_URL,
      MessageBody: JSON.stringify(task),
      // Group by MAC so messages for the same MAC are processed in order within the queue
      MessageGroupId: mac,
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[connect-webhook-receiver] Failed to enqueue provisioning task', { mac, role, action, message });
    // Return 500 so Okta retries delivery
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Failed to enqueue event — please retry', error: message }),
    };
  }

  safeLog('Enqueued provisioning task', { mac, role, action, oktaUserId });

  return {
    statusCode: 200,
    body: JSON.stringify({ ...responseBase, message: 'Event accepted' }),
  };
}

// OKTA_BASE_URL is referenced only to satisfy the env-var pattern used across both
// Lambda packages and to allow future use (e.g., Okta verification challenge response).
void OKTA_BASE_URL;
