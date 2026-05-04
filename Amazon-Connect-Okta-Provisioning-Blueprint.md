# Amazon Connect Provisioning Blueprint (Okta → AWS → Amazon Connect)
**Pilot MAC:** `noridian`  
**AWS Region:** `us-east-1`  
**Okta Org:** `https://cms.okta.com`  
**Provisioning scope:** Agent Workspace users for one MAC-specific Amazon Connect instance  
**Roles supported (stacked permissions):** Agent, Supervisor, Admin  
**Pilot username strategy:** `usernameSource = email` (can be changed later per MAC)

---

## 1. Objective
Automate the provisioning and deprovisioning of Amazon Connect users when a MAC-specific job code is assigned outside Amazon Connect (via EUA → Okta profile updates). The process must:
- Create or update an Amazon Connect user in the correct MAC’s Amazon Connect instance.
- Assign the correct permissions based on role (Agent/Supervisor/Admin), with Supervisor and Admin also having Agent capabilities.
- Disable the Amazon Connect user when job code is removed (i.e., user removed from the MAC’s Connect authorization group).
- Use Okta as the source of truth and trigger point.

---

## 2. High-level architecture
1. **EUA**: HR/onboarding system assigns job code and identity attributes (name/email + possibly euaId).
2. **Okta (cms.okta.com)**: receives/synchronizes user profile updates including job code; rules assign the user to an Okta group representing access.
3. **Okta Event Hook** (or Okta Workflows): emits events on group membership changes.
4. **AWS API Gateway (us-east-1)**: receives Okta webhook events.
5. **AWS Lambda (us-east-1)**: validates event, fetches user details from Okta API, loads MAC config, provisions user in Amazon Connect, persists state.
6. **Amazon Connect instance (noridian)**: target Connect instance where users are created/updated/disabled.
7. **SSM Parameter Store**: stores per-MAC configuration (instance IDs, routing profile IDs, security profile IDs, usernameSource).
8. **DynamoDB**: stores provisioning state for idempotency and audit.

---

## 3. Naming conventions (standard)
### 3.1 MAC key
- Lowercase MAC name, no spaces.
- Pilot: `noridian`

### 3.2 Okta group names (per MAC)
Format:
- `connect_{mac}_{role}`

Where:
- `{role}` ∈ `agent | supervisor | admin`

For pilot `noridian`:
- `connect_noridian_agent`
- `connect_noridian_supervisor`
- `connect_noridian_admin`

### 3.3 Job code naming (TBD)
Job codes are TBD; however, the automation is designed so job codes can change without AWS code changes as long as Okta group naming remains consistent.

---

## 4. Role and permission model (stacked)
Supervisor and Admin must also be able to operate as Agents.

### 4.1 Security profile stacking
When provisioning into Amazon Connect:
- **Agent role**: assign security profiles `[Agent]`
- **Supervisor role**: assign `[Supervisor, Agent]`
- **Admin role**: assign `[Admin, Supervisor, Agent]`

### 4.2 Routing profile
- All roles receive a baseline routing profile for the MAC instance (can be refined later).

### 4.3 Hierarchy group
- Optional. If used, set to a MAC-specific hierarchy group.

---

## 5. Identity strategy (pilot)
### 5.1 Connect Username selection
This blueprint supports per-MAC selection of Amazon Connect Username based on:
- `email` (pilot)
- `euaId` (future option for MACs with EUA IDs)

**Pilot decision:** `usernameSource = email` for `noridian`.

### 5.2 Why per-MAC usernameSource matters
Some MACs may not have `euaId` today. Using per-MAC configuration allows:
- Standard automation across all MACs.
- Smooth future migration by changing only config (SSM), not code.

**Note:** Changing `usernameSource` later can imply user identifier migration in Amazon Connect. Plan migrations carefully (may require creating new Connect user + disabling the old).

---

## 6. Okta design (cms.okta.com)
### 6.1 Okta user attributes required
Minimum attributes Lambda will use:
- `profile.email`
- `profile.firstName`
- `profile.lastName`
- `profile.euaId` (optional; required only when `usernameSource = euaId`)
- Okta User ID (for API lookup)

### 6.2 Group-driven authorization model
Okta groups represent authorization to a MAC’s Connect instance and role:
- Membership in `connect_noridian_agent` authorizes provisioning into Noridian instance as Agent.
- Membership in `connect_noridian_supervisor` authorizes provisioning into Noridian instance as Supervisor.
- Membership in `connect_noridian_admin` authorizes provisioning into Noridian instance as Admin.

### 6.3 Job code → group rules (to be configured when job codes exist)
For `noridian`, configure Okta Profile Rules:
- If job code == `<noridian_agent_job_code>` then add to `connect_noridian_agent`, remove from supervisor/admin.
- If job code == `<noridian_supervisor_job_code>` then add to `connect_noridian_supervisor`, remove from agent/admin.
- If job code == `<noridian_admin_job_code>` then add to `connect_noridian_admin`, remove from agent/supervisor.

Rules must be **mutually exclusive** per MAC.

### 6.4 Event triggers
Preferred: **Okta Event Hooks** for:
- User added to group
- User removed from group

Alternate: **Okta Workflows** with the same triggers.

### 6.5 Okta API token (for Lambda)
Create a service token that can:
- Read users
- Read user group memberships
- (Optional) read group details if events only provide group IDs

Okta API base URL:
- `https://cms.okta.com`

Endpoints typically used by Lambda:
- `GET /api/v1/users/{oktaUserId}`
- `GET /api/v1/users/{oktaUserId}/groups`
- `GET /api/v1/groups/{groupId}` (only if needed)

Store token in **AWS Secrets Manager**.

---

## 7. AWS design (us-east-1)
### 7.1 API Gateway
- Endpoint: `POST /okta/connect-provision`
- Receives webhook events from Okta Event Hooks/Workflows.

Security recommendation:
- Require a shared secret header (e.g., `X-Okta-Secret`) validated by Lambda.
- Optionally implement AWS WAF rules.

### 7.2 Lambda: `connect-provisioner`
Responsibilities:
1. Validate request (shared secret, basic schema).
2. Determine action: ADDED or REMOVED.
3. Identify the target Okta group and parse `(mac, role)` from group name.
4. Fetch authoritative user profile from Okta API using Okta User ID.
5. Load per-MAC configuration from SSM.
6. Determine Connect username based on `usernameSource`:
   - If `email`: Connect Username = Okta `email`.
   - If `euaId`: Connect Username = Okta `euaId` (must exist).
7. Upsert user into the correct Amazon Connect instance:
   - Create if not present.
   - Update security profiles and routing profile if present.
8. For REMOVED events, disable Connect user **only if** user is no longer in any `connect_{mac}_*` group (prevents disable during role transitions).
9. Write/update provisioning state in DynamoDB for idempotency/audit.

### 7.3 SSM Parameter Store configuration (per MAC)
Parameter naming:
- `/connect/macs/{mac}`

Pilot parameter:
- `/connect/macs/noridian`

Value (JSON template):
```json
{
  "mac": "noridian",
  "instanceId": "<NORIDIAN_CONNECT_INSTANCE_ID>",
  "usernameSource": "email",
  "routingProfileIdBaseline": "<NORIDIAN_ROUTING_PROFILE_ID>",
  "securityProfiles": {
    "agent": "<NORIDIAN_SECURITY_PROFILE_ID_AGENT>",
    "supervisor": "<NORIDIAN_SECURITY_PROFILE_ID_SUPERVISOR>",
    "admin": "<NORIDIAN_SECURITY_PROFILE_ID_ADMIN>"
  },
  "hierarchyGroupId": "<OPTIONAL_HIERARCHY_GROUP_ID>"
}
```

### 7.4 DynamoDB state table
Table: `connect-provisioning-state`  
Partition key: `pk` (string) = `{mac}#{connectUsername}`

Recommended attributes:
- `oktaUserId`
- `mac`
- `connectUsername`
- `connectInstanceId`
- `connectUserId`
- `currentRole`
- `status` (`PROVISIONED` | `DISABLED` | `ERROR`)
- `updatedAt`

Rationale:
- Prevent duplicate user creation on webhook retries.
- Enable fast update/disable operations.
- Provide audit trail.

### 7.5 Required IAM permissions (high level)
Lambda execution role needs:
- Amazon Connect user management for target instances:
  - List/find users
  - Create user
  - Update user security profiles
  - Update user routing profile
  - (Optional) update identity info and hierarchy group
  - Disable user
- `ssm:GetParameter` for `/connect/macs/*` (and `kms:Decrypt` if encrypted)
- DynamoDB read/write for `connect-provisioning-state`
- Secrets Manager read for Okta API token
- CloudWatch Logs write permissions

---

## 8. Amazon Connect (per MAC instance) prerequisites
For the Noridian Connect instance:
1. Security profiles exist:
   - Agent
   - Supervisor
   - Admin (or least-privilege admin equivalent)
2. Routing profile exists:
   - baseline routing profile ID captured
3. Optional hierarchy group exists:
   - captured if used
4. Collect IDs and populate `/connect/macs/noridian` accordingly.

---

## 9. Provisioning logic details
### 9.1 Group parsing
Group name pattern:
- `connect_{mac}_{role}`

Regex:
- `^connect_(?<mac>[a-z0-9]+)_(?<role>agent|supervisor|admin)$`

### 9.2 Idempotency approach
- First attempt lookup in DynamoDB by `pk`.
- If absent or stale, lookup in Connect by Username.
- Only create if user truly does not exist.

### 9.3 Removal (disable) guard
To avoid disabling during role changes (agent → supervisor → admin):
- On REMOVED event, call Okta API to list current groups.
- If user is still in any of:
  - `connect_{mac}_agent`
  - `connect_{mac}_supervisor`
  - `connect_{mac}_admin`
  then **skip disable**.
- Otherwise disable user in Connect and update state.

---

## 10. Pilot rollout plan (Noridian)
### Phase 1: Setup
1. Create 3 Okta groups for `noridian`.
2. Create `/connect/macs/noridian` SSM config (with placeholder IDs initially).
3. Create DDB table `connect-provisioning-state`.
4. Deploy API Gateway + Lambda with Okta token in Secrets Manager.
5. Gather Noridian Connect instance IDs and update SSM config with real values.

### Phase 2: Test cases
1. Add a test user to `connect_noridian_agent`
   - Expect: Connect user created/updated; security profiles include Agent.
2. Change user role to supervisor (remove agent group, add supervisor group)
   - Expect: user not disabled; security profiles updated to Supervisor+Agent.
3. Remove user from all `connect_noridian_*` groups
   - Expect: Connect user disabled.
4. Retry webhook delivery (simulate duplicates)
   - Expect: no duplicate Connect user creation; idempotent updates.

### Phase 3: Expand
- Repeat SSM config + Okta groups for additional MACs.
- Set `usernameSource = email` unless a MAC is confirmed to use `euaId`.

---

## 11. Open items / decisions (tracked)
1. Final job code values per MAC (Agent/Supervisor/Admin) and their Okta attribute name.
2. Final SSO identifier alignment per MAC (whether Connect Username should remain `email` or migrate to `euaId`).
3. Whether hierarchy groups will be required for reporting/governance per MAC.

---

## 12. Appendix: Summary for stakeholders
- Okta groups are the “switch” that controls access to each MAC’s Connect instance.
- AWS Lambda provisions users into the correct Connect instance and applies role-based security profiles (with stacking).
- Pilot uses email as Connect Username to support MACs without EUA IDs.
- Future shift to euaId is supported via per-MAC configuration, not code changes.