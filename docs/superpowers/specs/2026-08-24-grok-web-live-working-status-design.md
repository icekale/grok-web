# Grok Web 工作态状态条设计

日期：2026-08-24  
仓库：`grok-web`  
状态：设计已获用户确认，待用户复核规格文件

## 目标

解决「正在工作时看起来像已经中断」的问题。工具卡和文本已经够多，缺的是一条不会被内容挤掉的忙碌信号。

## 现状与根因

`phaseLabel` 已经能显示 `Waiting for model...`、`Running {name}...` 等文案，并带脉冲。

`ChatWindow.tsx` 只在 `agentRunning && !hasStreamingContent` 时渲染这条状态。`hasStreamingContent` 为 `streamState.streamingMessage?.content.length` 有值。工具卡或文本一出现，状态条消失，直播区看起来像停住的历史记录。侧栏小转圈和 composer 停止按钮不够承担「还在干活」的语义。

停止中另有 `agentPhase?.kind === "stopping"` 分支，不受这条守卫影响。

## 方案

去掉工作态状态条上的 `!hasStreamingContent` 守卫。

`agentRunning && agentPhase && agentPhase.kind !== "stopping"` 时，始终把现有脉冲 `phaseLabel` 画在直播 `MessageView` 下方。文案、i18n、脉冲动画不变。

`stopping` 仍只走现有 Stopping 行。`bashRunning` 行、过程摘要、工具卡展开、composer、侧栏都不改。

不新增协议、字段、组件或样式系统。

## 测试

更新或新增 `ChatWindow` 源码契约测试：工作态状态条渲染条件不再要求 `!hasStreamingContent`；`stopping` 仍单独渲染。

## 不包含

- 加强 composer 边框或「Working」标签
- 当前工具卡高亮、完成卡变淡
- 改过程摘要、thinking 默认折叠、ACP/SSE
- 新的全局 header 忙碌条
