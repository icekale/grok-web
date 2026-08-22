# 模型页布局与 Provider 入口修复设计

## 背景

模型设置页的“自定义供应商”分组标题复用了折叠按钮样式。折叠按钮的固定宽度把标题压缩成窄列，中文因此逐字竖排。与此同时，“添加 Provider”弹窗只展示未连接/未配置的认证项，已连接环境中只剩自定义入口，丢失了原有的 Grok 与 xAI 入口。

## 目标

1. 让“自定义供应商”分组标题横向显示，同时保留折叠图标和可操作性。
2. “添加 Provider”始终保留三种入口：
   - Grok OAuth
   - xAI OAuth
   - 自定义 Provider
3. 已连接或已配置的 OAuth 入口不再消失；点击后执行已有的登录/连接流程，不改变认证运行时行为。
4. 保持现有模型配置 CRUD、认证状态、搜索、移动端布局和视觉系统不变。

## 方案

### 分组标题

为同时拥有 `.models-settings-group-label` 和 `.models-settings-disclosure` 的标题增加专用 CSS 覆盖：宽度占满导航栏、水平对齐、保留合理的标题内边距。普通 Provider 行的 24px 折叠按钮样式不变。

### Provider Picker

在 `AddProviderPicker` 中，将认证入口分成稳定的三类：

- OAuth 列表中保留 Grok，并为 xAI 提供固定入口；如果运行时 OAuth provider 列表提供 xAI，则复用该 provider id，否则使用现有 xAI provider 语义。
- OAuth 行不再因 `loggedIn` 被过滤，已连接状态通过现有详情页/登录流程处理。
- 自定义 Provider 继续保留现有创建流程。

不引入新的认证 API 或存储格式；只调整 Picker 的可见入口与选择回调。现有 API Key 认证列表不作为这组三项 OAuth/自定义入口的一部分，避免把 API Key 与用户要求的三种方式混淆。

## 验证

- 为分组标题 CSS 增加回归断言，防止固定宽度回归。
- 为 Provider Picker 增加源码级回归断言，确认 Grok、xAI OAuth 和自定义入口始终存在。
- 运行模型相关测试、类型检查/构建，并用浏览器检查中文标题的实际尺寸和 Picker 的三项入口。
