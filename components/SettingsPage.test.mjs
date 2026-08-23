import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const settings = await readFile(new URL("./SettingsPage.tsx", import.meta.url), "utf8");
const runtime = await readFile(new URL("./AgentRuntimeConfig.tsx", import.meta.url), "utf8");
const picker = await readFile(new URL("./DirectoryPicker.tsx", import.meta.url), "utf8");

test("daily Grok tools open a tools panel instead of Settings chrome", () => {
  assert.match(shell, /setSettingsVariant\(/);
  assert.match(shell, /section === "skills" \|\| section === "plugins" \|\| section === "marketplace" \|\| section === "mcp"/);
  assert.match(shell, /variant=\{settingsVariant\}/);
  assert.match(settings, /variant === "tools"/);
  assert.match(settings, /TOOL_NAV_SECTIONS/);
  assert.match(settings, /settings\.grokTools/);
  assert.doesNotMatch(settings.slice(settings.indexOf("variant === \"tools\"")), /id: "general"/);
});

test("AppShell exposes one unified settings entry", () => {
  assert.match(shell, /<SettingsPage/);
  assert.equal((shell.match(/setSettingsOpen\(true\)/g) ?? []).length, 1);
  assert.doesNotMatch(shell, /<ModelsConfig|<SkillsConfig|<PluginsConfig/);
});

test("Agent Runtime renders persisted profile warnings", () => {
  assert.match(runtime, /body\.warnings\?\.length/);
  assert.match(runtime, /role="alert"/);
});

test("Agent Runtime owns the global permission profile", () => {
  assert.match(settings, /id: "runtime"/);
  assert.match(settings, /<AgentRuntimeConfig onDirtyChange=\{setRuntimeDirty\}/);
  assert.doesNotMatch(settings, /savePermissionMode/);
});

test("settings embeds the model, skill, plugin, and remote modules", () => {
  assert.match(settings, /<ModelsConfig cwd=\{cwd\} onControllerChange=\{setModelsController\} \/>/);
  assert.match(settings, /<SkillsConfig cwd=\{cwd\} onControllerChange=\{setSkillsController\} \/>/);
  assert.match(settings, /onControllerChange=\{setPluginsController\}/);
  assert.doesNotMatch(settings, /VisionToolkitConfig/);
  assert.match(settings, /<RemoteAccessConfig onControllerChange=\{setRemoteController\} \/>/);
  assert.match(settings, /export type SettingsSection = "general" \| "runtime" \| "remote" \| "archived" \| "models" \| "skills" \| "plugins" \| "marketplace" \| "mcp"/);
  assert.doesNotMatch(settings, /id: "project"/);
});

test("remote access sits after mcp and does not require a project", () => {
  assert.match(settings, /id: "mcp", label: t\("common\.mcp"\), disabled: !cwd \},\s*\{ id: "remote", label: t\("remote\.nav"\), disabled: false \}/);
  assert.match(settings, /id: "remote", label: t\("remote\.nav"\), disabled: false/);
  assert.match(settings, /GlobeLock/);
  assert.match(settings, /section === "remote"/);
  assert.match(settings, /setRemoteController/);
});

test("vision toolkit is not shown in Settings", () => {
  assert.doesNotMatch(settings, /id: "vision"/);
  assert.doesNotMatch(settings, /ScanEye/);
  assert.doesNotMatch(settings, /t\("vision\.openConfig"\)/);
});

test("settings guards every exit path behind one discard confirmation", () => {
  assert.match(settings, /const requestCloseOrNavigate = useCallback\(/);
  assert.match(settings, /if \(modelsController\?\.dirty \|\| remoteController\?\.dirty \|\| runtimeDirty\)/);
  assert.match(settings, /setPendingExit\(\(\) => action\)/);
  assert.match(settings, /setDiscardDialogOpen\(true\)/);
  assert.match(settings, /onClose=\{\(\) => requestCloseOrNavigate\(close\)\}/);
  assert.match(settings, /size="page"/);
  assert.match(settings, /<DialogShell[\s\S]*?size="confirm"/);
  assert.match(settings, /t\("models\.unsavedChanges"\)/);
  assert.match(settings, /t\("models\.keepEditing"\)/);
  assert.match(settings, /t\("models\.discard"\)/);
  assert.match(settings, /setRuntimeDirty\(false\)/);
  assert.match(settings, /setRuntimeDiscardSignal/);
});

test("Escape consumes Models layers before closing Settings", () => {
  assert.match(settings, /onEscape=\{\(\) => Boolean\(activeController\?\.handleBack\(\)\)\}/);
  assert.match(settings, /size="page"/);
});

test("Settings focuses the close button only on mount, not when the models draft becomes dirty", () => {
  assert.match(settings, /closeButtonRef\.current\?\.focus\(\);\s*\}, \[\]\);/);
  assert.doesNotMatch(settings, /closeButtonRef\.current\?\.focus\(\);\s*const onKeyDown/);
});

test("settings registers one combined back handler with AppShell", () => {
  assert.match(settings, /onRegisterSettingsBack\(handleSettingsBack\)/);
  assert.match(settings, /if \(activeController\?\.handleBack\(\)\) return true;/);
  assert.match(settings, /setPendingExit\(\(\) => close\)/);
});

test("discard restores the baseline before completing the pending navigation", () => {
  assert.match(settings, /modelsController\?\.discard\(\);/);
  assert.match(settings, /remoteController\?\.discard\(\);/);
  assert.match(settings, /setModelsController\(null\);/);
  assert.match(settings, /action\?\.\(\);/);
});

test("Settings category strip hides while a nested mobile detail is open", () => {
  assert.match(settings, /data-hidden-mobile=\{activeController\?\.mobileDetailOpen \? "true" : undefined\}/);
});

test("active Skills or Plugins controller consumes back before Settings closes", () => {
  assert.match(settings, /if \(activeController\?\.handleBack\(\)\) return/);
  assert.match(settings, /section === "skills"/);
  assert.match(settings, /setSkillsController/);
  assert.match(settings, /setPluginsController/);
});

test("settings lists archived projects and restores them through the project registry", () => {
  assert.match(settings, /fetch\("\/api\/projects", \{ cache: "no-store" \}\)/);
  assert.match(settings, /fetch\("\/api\/sessions", \{ cache: "no-store" \}\)/);
  assert.match(settings, /project\.archived && !project\.removed/);
  assert.match(settings, /archivedSessionIds\.has\(session\.id\)/);
  assert.match(settings, /method: "PATCH"/);
  assert.match(settings, /JSON\.stringify\(\{ path, update: \{ archived: false \} \}\)/);
  assert.match(settings, /disabled=\{restoringProjects\.has\(project\.path\)\}/);
  assert.match(settings, /loadProjects\(false\)/);
  assert.match(settings, /<ArchiveRestore size=\{14\}/);
  assert.match(settings, /onProjectsChanged\(\)/);
  assert.match(settings, /sidebar\.restoreSession/);
});

test("settings owns general preferences", () => {
  assert.match(settings, /initialSection = "general"/);
  assert.match(settings, /useState<SettingsSection>\(initialSection\)/);
  assert.match(settings, /onThemeChange\(id\)/);
  assert.match(settings, /onLocaleChange\(event\.target\.value as Locale\)/);
  assert.match(settings, /role="switch" aria-checked=\{soundEnabled\}/);
  assert.match(settings, /settings\.completionSound[\s\S]*settings\.tokenSpeed/);
  assert.match(settings, /role="switch" aria-checked=\{tokenSpeedEnabled\}/);
  assert.doesNotMatch(settings, /onTrustProject/);
  assert.doesNotMatch(settings, /<svg/);
});

test("AppShell owns the token-speed preference like completion sound", () => {
  assert.match(shell, /useTokenSpeedPreference/);
  assert.match(shell, /tokenSpeedEnabled=\{tokenSpeedEnabled\}/);
  assert.match(shell, /onTokenSpeedToggle=\{onTokenSpeedToggle\}/);
});

test("directory picker creates a folder through the browse API", () => {
  assert.match(picker, /fetch\("\/api\/cwd\/browse", \{/);
  assert.match(picker, /method: "POST"/);
  assert.match(picker, /JSON\.stringify\(\{ parentPath: currentPath, name \}\)/);
  assert.match(picker, /await navigateTo\(data\.path\)/);
});
