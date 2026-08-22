# 模型设置页去掉 Grok 只读 Effort

## 背景

设置 → 模型 的「Grok 模型」组把 ACP 返回的 `reasoningEfforts` 画成 `Effort: low · medium · high`。这是能力清单，不是可写配置：档位由 Grok Build 决定，当前会话强度只在对话输入栏通过 `session/set_mode` 切换。设置页把它摆成行尾文案，看起来像坏掉的控件。

## 目标

1. 「Grok 模型」每行只显示图标和模型名。
2. 推理强度继续只在对话输入栏改，行为不变。
3. 不删除「Grok 模型」整组，也不删分组说明。

## 非目标

- 不在设置里保存或编辑默认 Effort。
- 不改 ACP 模型列表、composer Effort 菜单、`session/set_mode`。
- 不改账户、自定义供应商、Provider Picker。
- 不改 `models.json` 里自定义模型的思考等级映射。

## 方案

从 live 行拿掉 Effort 文案和 `efforts` 数据。

- `LiveChatModelRow` 只保留 `id` / `name`。
- `ModelsConfig` 不再为导航栏计算 `visibleGrokEffortLevels`。
- 删除 `models.liveEffort` 文案。
- 只读行回到单行：图标 + 名称省略，不可点、无选中态。
- 分组标题「Grok 模型」和说明「当前对话用的就是这份 Grok ACP 列表。」保留。

## 验证

- 导航栏 live 行源码不再引用 `models.liveEffort` 或 `efforts`。
- 运行模型相关测试。
- 设置页能看到 Grok 模型名，看不到 Effort 行。
- 对话输入栏仍能切换 Effort。
