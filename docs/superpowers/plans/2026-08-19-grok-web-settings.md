# grok-web Settings, Login, MCP, Skills, Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页能登录/登出 Grok、开关 MCP 与技能，远程 Basic 用户名为 `grok`；浏览器 HTTP 形状保持 pi-web 不变。

**Architecture:** 适配器走已探过的 `_x.ai/auth/*`、`_x.ai/mcp/*`、`_x.ai/skills/*`。UI 仍打 `/api/auth/*`、`/api/plugins`、`/api/skills`、`/api/remote-access`。测试只扩 `fake-agent.mjs` 与 GROK_HOME 夹具，不启动真 `grok`、不打真登录。

**Tech Stack:** 现有 Node + Vite + TanStack + `lib/acp/*`。

**本计划不做：** 子代理 `_x.ai/subagent/*`、compact、图片、插件市场 `_x.ai/plugins/*`、改设置页视觉、skills.sh 安装改走真 grok CLI。

规格：`docs/superpowers/specs/2026-08-18-grok-web-design.md` 第 5 期（设置、登录、MCP/技能、远程访问）。

已对真 `grok agent stdio` 探过（实现必须按这个发；方法名带前缀 `_x.ai/`，否则 `-32601`）：

| UI | ACP |
| --- | --- |
| 登录状态 | `_x.ai/auth/check_subscription` `{}` → `{ authenticated, meta }` |
| grok.com 登录 | `_x.ai/auth/get_url` `{}` → `{ auth_url, external_provider, mode }`（`mode` 常为 `"device"`） |
| 提交码 | `_x.ai/auth/submit_code` `{ code }` → `{ submitted: true }` |
| 取消登录 | `_x.ai/auth/cancel` `{}` → `{ cancelled: true }` |
| 登出 | `_x.ai/auth/logout` `{}` → `{ ok, was_logged_in, email, api_key_still_set }` |
| API key | 标准 `authenticate` `{ methodId: "xai.api_key" }`；进程要能读到 `XAI_API_KEY` 或 `config.toml` 的 `api_key` |
| 列 MCP | `_x.ai/mcp/list` `{}` → `{ result: { servers: [{ name, source, type, command, session? }] } }` |
| 开关 MCP | `_x.ai/mcp/toggle` `{ session_id, server_name, enabled }` → `{ result: { ok: true } }`（蛇形字段） |
| 增改 MCP | `_x.ai/mcp/upsert` `{ session_id, server_name, command }` 或带 `url`；删除 `_x.ai/mcp/delete` `{ session_id, server_name }` |
| 列技能 | `_x.ai/skills/list` `{ cwd }` → `{ result: { skills: [{ name, description, path, scope, enabled, disable_model_invocation }] } }` |
| 开关技能 | `_x.ai/skills/toggle` `{ name, enabled }` → 整表 skills |

MCP 列表规则：启用的 server 没有 `session.enabled`；禁用的是 `session: { enabled: false }`，`command` 可能是 `""`。toggle 会写 `~/.grok/config.toml` 的 `[mcp_servers.<name>].enabled` 和 `disabled_mcp_servers`。

磁盘上的 MCP 在 `[mcp_servers.<name>]`，**不是** `[mcp.servers]`。

`initialize.authMethods`：已登录配置下常见 `xai.api_key` 与 `grok.com`。

---

## File structure

| 路径 | 职责 |
| --- | --- |
| `lib/acp/connection.ts` | auth / mcp / skills RPC |
| `lib/acp/fake-agent.mjs` | 上述方法的假实现 |
| `lib/acp/runtime.ts` | 把 auth/mcp/skills 暴露给 HTTP |
| `lib/grok-settings/home-config.ts` | 解析 `[mcp_servers]`；读写 `api_key` 行 |
| `app/api/auth/providers/route.ts` | 只报 Grok OAuth，不再依赖 ModelRuntime |
| `app/api/auth/all-providers/route.ts` | 只报 `xai.api_key` |
| `app/api/auth/login/[provider]/route.ts` | SSE：get_url + 轮询 check_subscription + submit_code |
| `app/api/auth/logout/[provider]/route.ts` | `_x.ai/auth/logout` |
| `app/api/auth/api-key/[provider]/route.ts` | 写/清 config `api_key` + `authenticate` / logout |
| `app/api/plugins/route.ts` | 列表/开关/增删走 MCP |
| `app/api/skills/route.ts` | GET/PATCH 优先 ACP |
| `lib/web-auth.ts` | Basic 用户名 `grok` |
| `lib/remote-access-config.ts` | snapshot.username `"grok"` |

---

### Task 1: ACP 登录方法

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1: Write the failing test**

在 `lib/acp/connection.test.mjs` 的 `describe("AcpConnection")` 末尾加：

```javascript
it("checks auth, starts device login, submits a code, cancels, and logs out", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const status = await acp.authCheck();
    assert.equal(status.authenticated, false);
    const started = await acp.authGetUrl();
    assert.equal(started.mode, "device");
    assert.match(started.auth_url, /^https:\/\//);
    const submitted = await acp.authSubmitCode("123456");
    assert.equal(submitted.submitted, true);
    assert.equal((await acp.authCheck()).authenticated, true);
    const cancelled = await acp.authCancel();
    assert.equal(cancelled.cancelled, true);
    const loggedOut = await acp.authLogout();
    assert.equal(loggedOut.ok, true);
    assert.equal((await acp.authCheck()).authenticated, false);
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2:** `node --experimental-strip-types --test lib/acp/connection.test.mjs`

Expected: FAIL，`authCheck` 不存在。

- [ ] **Step 3: Implement**

`AcpConnection` 增加：

```typescript
authCheck(): Promise<{ authenticated: boolean; meta?: unknown }> {
  return this.rpc.request("_x.ai/auth/check_subscription", {}) as Promise<{ authenticated: boolean; meta?: unknown }>;
}

authGetUrl(): Promise<{ auth_url: string; external_provider?: boolean; mode?: string }> {
  return this.rpc.request("_x.ai/auth/get_url", {}) as Promise<{
    auth_url: string;
    external_provider?: boolean;
    mode?: string;
  }>;
}

authSubmitCode(code: string): Promise<{ submitted?: boolean }> {
  return this.rpc.request("_x.ai/auth/submit_code", { code }) as Promise<{ submitted?: boolean }>;
}

authCancel(): Promise<{ cancelled?: boolean }> {
  return this.rpc.request("_x.ai/auth/cancel", {}) as Promise<{ cancelled?: boolean }>;
}

authLogout(): Promise<{ ok?: boolean; was_logged_in?: boolean; api_key_still_set?: boolean }> {
  return this.rpc.request("_x.ai/auth/logout", {}) as Promise<{
    ok?: boolean;
    was_logged_in?: boolean;
    api_key_still_set?: boolean;
  }>;
}

authenticate(methodId: string): Promise<unknown> {
  return this.rpc.request("authenticate", { methodId });
}
```

`fake-agent.mjs` 在文件顶部加 `let authenticated = false;`，并处理：

```javascript
if (method === "_x.ai/auth/check_subscription") {
  result(id, { authenticated, meta: null });
  return;
}
if (method === "_x.ai/auth/get_url") {
  result(id, {
    auth_url: "https://accounts.x.ai/oauth2/device?user_code=FAKE-CODE",
    external_provider: false,
    mode: "device",
  });
  return;
}
if (method === "_x.ai/auth/submit_code") {
  if (!params?.code) {
    error(id, -32602, "missing field `code`");
    return;
  }
  authenticated = true;
  result(id, { submitted: true });
  return;
}
if (method === "_x.ai/auth/cancel") {
  result(id, { cancelled: true });
  return;
}
if (method === "_x.ai/auth/logout") {
  authenticated = false;
  result(id, { ok: true, was_logged_in: true, email: null, api_key_still_set: false });
  return;
}
if (method === "authenticate") {
  if (!params?.methodId) {
    error(id, -32602, "missing field `methodId`");
    return;
  }
  authenticated = true;
  result(id, {});
  return;
}
```

- [ ] **Step 4:** 再跑同一测试。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/connection.test.mjs
git commit -m "$(cat <<'EOF'
feat: talk ACP auth check login and logout

EOF
)"
```

---

### Task 2: Runtime + 登录 HTTP

**Files:**
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `lib/grok-settings/home-config.ts`
- Modify: `lib/grok-settings/home-config.test.mjs`
- Modify: `app/api/auth/providers/route.ts`
- Modify: `app/api/auth/all-providers/route.ts`
- Modify: `app/api/auth/login/[provider]/route.ts`
- Modify: `app/api/auth/logout/[provider]/route.ts`
- Modify: `app/api/auth/api-key/[provider]/route.ts`
- Create: `app/api/auth/login/route.test.mjs`

浏览器契约（不要改事件名）：

- `GET /api/auth/providers` → `{ providers: [{ id, name, usesCallbackServer, loggedIn, supportsApiKey }] }`
- `GET /api/auth/all-providers` → `{ providers: [{ id, displayName, configured, modelCount, supportsOAuth }] }`
- `GET /api/auth/login/:provider` SSE：`auth` / `device_code` / `success` / `error` / `cancelled`
- `POST /api/auth/login/:provider` `{ token, code }` → `authSubmitCode(code)`
- `POST /api/auth/logout/:provider` → `authLogout`
- `GET|POST|DELETE /api/auth/api-key/:provider`

只支持 `grok.com`（OAuth/device）和 `xai.api_key`（API key）。不要再 `ModelRuntime.create()`。

- [ ] **Step 1: Write failing tests**

`lib/acp/runtime.test.mjs` 加（用现有 fake connect 风格）：

```javascript
it("exposes auth check login logout and api-key authenticate", async () => {
  const runtime = runtimeWithFake();
  const status = await runtime.authCheck();
  assert.equal(status.authenticated, false);
  const url = await runtime.authGetUrl();
  assert.ok(url.auth_url);
  await runtime.authSubmitCode("999999");
  assert.equal((await runtime.authCheck()).authenticated, true);
  await runtime.authLogout();
  assert.equal((await runtime.authCheck()).authenticated, false);
  await runtime.authenticate("xai.api_key");
  assert.equal((await runtime.authCheck()).authenticated, true);
});
```

`home-config.test.mjs` 加：

```javascript
it("writes and clears a top-level api_key without exposing it in loadGrokSettings.auth", () => {
  const home = mkdtempSync(join(tmpdir(), "grok-apikey-"));
  assert.equal(hasGrokApiKey(home), false);
  writeGrokApiKey("test-key", home);
  assert.equal(hasGrokApiKey(home), true);
  assert.match(readFileSync(join(home, "config.toml"), "utf8"), /api_key = "test-key"/);
  clearGrokApiKey(home);
  assert.equal(hasGrokApiKey(home), false);
});
```

`app/api/auth/login/route.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

test("GET /api/auth/providers lists grok.com from runtime.authCheck", async () => {
  const runtime = await jiti.import("@/lib/acp/runtime.ts");
  const original = runtime.getAgentRuntime;
  runtime.getAgentRuntime = () => ({
    authCheck: async () => ({ authenticated: true }),
  });
  try {
    const { GET } = await jiti.import("./../providers/route.ts");
    const res = await GET();
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.providers[0].id, "grok.com");
    assert.equal(body.providers[0].loggedIn, true);
    assert.equal(body.providers[0].supportsApiKey, true);
  } finally {
    runtime.getAgentRuntime = original;
  }
});
```

同文件再测：`all-providers` 只含 `xai.api_key`；`POST logout` 调用 `authLogout`；未知 provider 登录返回 SSE `error`。

- [ ] **Step 2:** 跑这些测试。Expected: FAIL。

- [ ] **Step 3: Implement**

`AgentRuntime` 增加 `authCheck` / `authGetUrl` / `authSubmitCode` / `authCancel` / `authLogout` / `authenticate`，每个先 `ensureProcess()` 再转给 `AcpConnection`。

`home-config.ts`：

```typescript
export function hasGrokApiKey(home = grokHome()): boolean {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return false;
  return /^api_key\s*=/m.test(readFileSync(file, "utf8"));
}

export function writeGrokApiKey(apiKey: string, home = grokHome()): void {
  const file = join(home, "config.toml");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `api_key = ${JSON.stringify(apiKey)}\n`;
  const next = /^api_key\s*=.*$/m.test(current)
    ? current.replace(/^api_key\s*=.*$/m, line.trimEnd())
    : `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${line}`;
  writeFileSync(file, next);
}

export function clearGrokApiKey(home = grokHome()): void {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return;
  const next = readFileSync(file, "utf8").replace(/^api_key\s*=.*\r?\n?/m, "");
  writeFileSync(file, next);
}
```

`loadGrokSettings().auth` 保持 `{ loggedIn, methods }`，**不要**把 key 放进 JSON。

`GET /api/auth/providers`：

```typescript
const grok = {
  id: "grok.com",
  name: "Grok",
  usesCallbackServer: false,
  loggedIn: false,
  supportsApiKey: true,
};
try {
  grok.loggedIn = (await getAgentRuntime().authCheck()).authenticated === true;
} catch {
  grok.loggedIn = readGrokAuth().loggedIn;
}
return Response.json({ providers: [grok] });
```

`GET /api/auth/all-providers`：

```typescript
return Response.json({
  providers: [{
    id: "xai.api_key",
    displayName: "xAI API Key",
    configured: hasGrokApiKey() || readGrokAuth().loggedIn,
    modelCount: 0,
    supportsOAuth: true,
  }],
});
```

登录 SSE（`provider` 必须是 `grok.com`，否则立刻 `error`）：

1. `authGetUrl()`
2. 发 `{ type: "auth", url: auth_url, instructions: null, token }`
3. 若 `mode === "device"`，从 `auth_url` 的 `user_code` 再发 `{ type: "device_code", userCode, verificationUri: auth_url, intervalSeconds: 2, expiresInSeconds: null }`
4. 每 2s `authCheck()`，`authenticated` 则 `{ type: "success" }` 并 close
5. 客户端断开：`authCancel()`
6. `POST` 用 body `code` 调 `authSubmitCode`；token 仍按现有 registry 校验

`POST logout`：对 `grok.com` / `xai.api_key` 调 `authLogout()`，忽略 ModelRuntime。

`POST /api/auth/api-key/xai.api_key`：校验 `apiKey` → `writeGrokApiKey` → `authenticate("xai.api_key")`（ACP 不可用则只写盘）→ `{ success: true }`。  
`DELETE`：`clearGrokApiKey` + `authLogout`。  
`GET`：`{ provider, displayName: "xAI API Key", configured: hasGrokApiKey() || authCheck, source: hasGrokApiKey() ? "api_key" : undefined, models: 0 }`。

- [ ] **Step 4:** 再跑测试。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs lib/grok-settings/home-config.ts lib/grok-settings/home-config.test.mjs app/api/auth
git commit -m "$(cat <<'EOF'
feat: log in and out of Grok through ACP

EOF
)"
```

---

### Task 3: ACP MCP list / toggle / upsert / delete

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
it("lists toggles upserts and deletes MCP servers", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const listed = await acp.mcpList();
    assert.ok(listed.servers.some((s) => s.name === "docs"));
    const { sessionId } = await acp.sessionNew("/tmp/p");
    await acp.mcpToggle(sessionId, "docs", false);
    const after = await acp.mcpList();
    const docs = after.servers.find((s) => s.name === "docs");
    assert.equal(docs.session?.enabled, false);
    await acp.mcpUpsert(sessionId, "tmpprobe", { command: "true" });
    assert.ok((await acp.mcpList()).servers.some((s) => s.name === "tmpprobe"));
    await acp.mcpDelete(sessionId, "tmpprobe");
    assert.ok(!(await acp.mcpList()).servers.some((s) => s.name === "tmpprobe"));
  } finally {
    child.kill();
  }
});
```

- [ ] **Step 2:** 跑 `connection.test.mjs`。Expected: FAIL。

- [ ] **Step 3: Implement**

```typescript
mcpList(): Promise<{ servers: Array<{
  name: string;
  source?: string;
  type?: string;
  command?: string;
  session?: { enabled?: boolean };
}> }> {
  return this.rpc.request("_x.ai/mcp/list", {}).then((raw) => unwrapResult(raw) as never);
}

mcpToggle(sessionId: string, serverName: string, enabled: boolean): Promise<unknown> {
  return this.rpc.request("_x.ai/mcp/toggle", {
    session_id: sessionId,
    server_name: serverName,
    enabled,
  }).then(unwrapResult);
}

mcpUpsert(sessionId: string, serverName: string, transport: { command?: string; url?: string; args?: string[] }): Promise<unknown> {
  return this.rpc.request("_x.ai/mcp/upsert", {
    session_id: sessionId,
    server_name: serverName,
    ...transport,
  }).then(unwrapResult);
}

mcpDelete(sessionId: string, serverName: string): Promise<unknown> {
  return this.rpc.request("_x.ai/mcp/delete", {
    session_id: sessionId,
    server_name: serverName,
  }).then(unwrapResult);
}
```

fake-agent 内存 `Map` 初始含 `{ name: "docs", source: "local", type: "stdio", command: "true" }`。toggle 时设 `session: { enabled }`；`enabled === false` 时 `command` 置 `""`。upsert/delete 改 Map。返回一律包 `{ result: ... }`。

- [ ] **Step 4:** 测试 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/connection.test.mjs
git commit -m "$(cat <<'EOF'
feat: list and toggle MCP servers over ACP

EOF
)"
```

---

### Task 4: `/api/plugins` 接到 MCP

**Files:**
- Modify: `lib/acp/runtime.ts`
- Modify: `lib/acp/runtime.test.mjs`
- Modify: `app/api/plugins/route.ts`
- Create: `app/api/plugins/route.test.mjs`

设置页 Plugins 的 HTTP 不变：`GET /api/plugins?cwd=`、`POST { action, source, scope, cwd }`。  
把每个 MCP server 映射成一个 `PluginPackageInfo`：

```typescript
{
  source: server.name,
  scope: server.source === "project" ? "project" : "global",
  filtered: false,
  disabled: server.session?.enabled === false,
  packageName: server.name,
  counts: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
  resources: [],
  status: server.session?.enabled === false ? "disabled" : "loaded",
}
```

- [ ] **Step 1: Write failing tests**

runtime：`listMcp` / `toggleMcp` / `upsertMcp` / `deleteMcp`。toggle 需要 session：若 runtime 还没有 session，先 `createSession(cwd)`。

`app/api/plugins/route.test.mjs`：用注入的 fake runtime（或 `resetAgentRuntime` + 构造时 connect fake）。断言 GET 含 `docs`；POST `disable` `{ source: "docs", cwd }` 后该包装 `disabled: true`；POST `enable` 恢复；POST `remove` 删掉；ACP 不可用时 GET 仍能从磁盘 `[mcp_servers]` 列出（下一步会修好解析；本任务 GET 在 runtime 失败时返回 200 + `diagnostics`，不要 500）。

- [ ] **Step 2:** FAIL。

- [ ] **Step 3: Implement**

`AgentRuntime`：

```typescript
async listMcp() {
  await this.ensureProcess();
  return this.requireAcp().mcpList();
}

async withSession(cwd: string, fn: (sessionId: string) => Promise<unknown>) {
  await this.ensureProcess();
  const existing = [...this.sessions.keys()][0];
  const sessionId = existing ?? await this.createSession(cwd);
  return fn(sessionId);
}
```

`toggleMcp(cwd, name, enabled)` / `upsertMcp` / `deleteMcp` 走 `withSession`。

`GET /api/plugins`：优先 `getAgentRuntime().listMcp()`；失败则 `listMcpServers(readGrokConfig())` 填同样 DTO。  
`POST`：

- `enable` / `disable` → `toggleMcp(cwd, source, action === "enable")`
- `remove` → `deleteMcp`
- `install`：`source` 以 `http://` 或 `https://` 开头则 `upsertMcp(cwd, name, { url: source })`，否则 `{ command: source }`。`name` 取 source 最后一个非空 path 段，去掉查询串，不合法则 `"server"`。
- `update` → 400 `{ error: "MCP update is not supported" }`

不要再 `SettingsManager` / `DefaultPackageManager`。

- [ ] **Step 4:** PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/runtime.ts lib/acp/runtime.test.mjs app/api/plugins
git commit -m "$(cat <<'EOF'
feat: drive the plugins API from Grok MCP

EOF
)"
```

---

### Task 5: 技能列表与开关走 ACP

**Files:**
- Modify: `lib/acp/connection.ts`
- Modify: `lib/acp/fake-agent.mjs`
- Modify: `lib/acp/connection.test.mjs`
- Modify: `lib/acp/runtime.ts`
- Modify: `app/api/skills/route.ts`
- Modify: `app/api/skills/route.test.mjs`

- [ ] **Step 1: Write failing tests**

connection：

```javascript
it("lists and toggles skills over ACP", async () => {
  const { child, acp } = spawnFake();
  try {
    await acp.initialize();
    const listed = await acp.skillsList("/tmp/p");
    assert.ok(listed.skills.some((s) => s.name === "demo" && s.enabled === true));
    const toggled = await acp.skillsToggle("demo", false);
    const demo = toggled.skills.find((s) => s.name === "demo");
    assert.equal(demo.enabled, false);
  } finally {
    child.kill();
  }
});
```

`app/api/skills/route.test.mjs` 现有 GET 夹具保留。再加：当 runtime.listSkills 可用时，`disableModelInvocation` 等于 `!enabled`；PATCH `{ filePath, disableModelInvocation: true }` 调 `skillsToggle(name, false)` 且 200。

- [ ] **Step 2:** FAIL。

- [ ] **Step 3: Implement**

```typescript
skillsList(cwd: string): Promise<{ skills: Array<{
  name: string;
  description?: string;
  path: string;
  scope?: string;
  enabled?: boolean;
  disable_model_invocation?: boolean;
}> }> {
  return this.rpc.request("_x.ai/skills/list", { cwd }).then((raw) => unwrapResult(raw) as never);
}

skillsToggle(name: string, enabled: boolean): Promise<{ skills: Array<{ name: string; enabled?: boolean; path?: string }> }> {
  return this.rpc.request("_x.ai/skills/toggle", { name, enabled }).then((raw) => unwrapResult(raw) as never);
}
```

fake-agent 初始 skills：`demo`（user）与 `local`（local），`enabled: true`。

Runtime：`listSkills(cwd)` / `toggleSkill(name, enabled)`。

`GET /api/skills`：先 `getAgentRuntime().listSkills(cwd)`，映射：

```typescript
{
  name: skill.name,
  description: skill.description ?? "",
  filePath: skill.path,
  baseDir: cwd,
  disableModelInvocation: skill.enabled === false || skill.disable_model_invocation === true,
  sourceInfo: { source: "grok", scope: skill.scope === "user" ? "user" : "project" },
}
```

ACP 失败则保留现在的 `listGrokSkills` 回退。

`PATCH`：用列表按 `filePath` 找到 `name`，`toggleSkill(name, !disableModelInvocation)`。找不到或 ACP 失败，再退回现有改 SKILL.md frontmatter 的逻辑。

- [ ] **Step 4:** PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/acp/connection.ts lib/acp/fake-agent.mjs lib/acp/connection.test.mjs lib/acp/runtime.ts app/api/skills
git commit -m "$(cat <<'EOF'
feat: list and toggle Grok skills over ACP

EOF
)"
```

---

### Task 6: 磁盘设置读真正的 `[mcp_servers]`

**Files:**
- Modify: `lib/grok-settings/home-config.ts`
- Modify: `lib/grok-settings/home-config.test.mjs`

- [ ] **Step 1: Write the failing test**

把现有 fixture 从：

```toml
[mcp.servers.docs]
command = "npx"
```

改成：

```toml
disabled_mcp_servers = ["offbox"]

[mcp_servers.docs]
command = "npx"
enabled = true

[mcp_servers.offbox]
command = "echo"
enabled = false
```

断言 `listMcpServers` 含 `docs`（`command: "npx"`）和 `offbox`（`enabled: false`）。旧的 `[mcp.servers]` 夹具不再作为成功条件。

- [ ] **Step 2:** FAIL（当前实现读 `config.mcp.servers`）。

- [ ] **Step 3: Implement**

```typescript
export function listMcpServers(config: Record<string, unknown> = readGrokConfig()): Array<{
  name: string;
  command?: string;
  enabled?: boolean;
}> {
  const table = config.mcp_servers;
  if (!table || typeof table !== "object" || Array.isArray(table)) return [];
  const disabled = new Set(
    Array.isArray(config.disabled_mcp_servers)
      ? config.disabled_mcp_servers.filter((name): name is string => typeof name === "string")
      : [],
  );
  return Object.entries(table as Record<string, unknown>).map(([name, value]) => {
    const rec = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const command = typeof rec.command === "string" ? rec.command : undefined;
    const enabled = rec.enabled === false || disabled.has(name) ? false : true;
    return { name, ...(command ? { command } : {}), enabled };
  });
}
```

`GrokSettings.mcpServers` 类型加上可选 `enabled?: boolean`。

- [ ] **Step 4:** PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/grok-settings/home-config.ts lib/grok-settings/home-config.test.mjs
git commit -m "$(cat <<'EOF'
fix: read Grok mcp_servers from config.toml

EOF
)"
```

---

### Task 7: 远程 Basic 用户名改为 `grok`

**Files:**
- Modify: `lib/web-auth.ts`
- Modify: `lib/web-auth.test.mjs`
- Modify: `lib/remote-access-config.ts`
- Modify: `lib/remote-access-config.test.mjs`（若有 username 断言）
- Modify: `app/api/remote-access/route.test.mjs`
- Modify: `components/RemoteAccessConfig.tsx`
- Modify: `lib/i18n/messages/en.ts`
- Modify: `lib/i18n/messages/zh-CN.ts`

- [ ] **Step 1: Write failing tests**

`web-auth.test.mjs`：把所有 `authorization("pi", ...)` 改成 `authorization("grok", ...)`，并断言 `pi` 被拒绝、`grok` 通过。测试名从 “fixed pi username” 改成 “fixed grok username”。

`app/api/remote-access/route.test.mjs`：`assert.equal(body.username, "grok")`。

- [ ] **Step 2:** FAIL。

- [ ] **Step 3: Implement**

```typescript
export const GROK_WEB_AUTH_USERNAME = "grok";
```

```typescript
username: "grok";
```

`RemoteAccessConfig.tsx` 的 snapshot 类型改为 `"grok"`。

`remote.savedAuthHint`：

- en: `Settings saved. The browser will ask for username grok and the password you just set.`
- zh 保持「用户名固定为 {username}」即可；不要写死 `pi`。

配置文件路径仍用现有 `pi-web.json`（已有密码不能丢）。只改用户名。

- [ ] **Step 4:**

```bash
node --experimental-strip-types --test lib/web-auth.test.mjs lib/remote-access-config.test.mjs app/api/remote-access/route.test.mjs lib/grok-settings/*.test.mjs lib/acp/*.test.mjs app/api/skills/route.test.mjs app/api/plugins/route.test.mjs app/api/auth/login/route.test.mjs
```

Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add lib/web-auth.ts lib/web-auth.test.mjs lib/remote-access-config.ts app/api/remote-access/route.test.mjs components/RemoteAccessConfig.tsx lib/i18n/messages/en.ts lib/i18n/messages/zh-CN.ts
git commit -m "$(cat <<'EOF'
fix: use grok as the remote Basic Auth username

EOF
)"
```

---

## 自检

1. **规格覆盖：** 登录/`x.ai/auth`、MCP 开关、技能列表/开关、远程用户名 `grok`、设置读 `~/.grok` 都有任务。外观（主题/语言/声音）已在客户端，本阶段不重做。
2. **无占位：** 方法名、字段（`session_id` / `server_name` / `cwd` / `code`）都写死。
3. **类型一致：** `mcpToggle(sessionId, serverName, enabled)`、`skillsToggle(name, enabled)` 前后任务相同。
4. **不做：** 子代理协议、插件市场、skills.sh `--agent pi` 安装、视觉改版。
