# Grok Web

Grok Build 的本地浏览器工作区。它挂在一个长期运行的 `grok agent` ACP 进程和现有的 `~/.grok` 主目录前面，因此 TUI 和网页可以继续同一批会话。

这是给本机单人使用的应用，不是托管的多租户 Grok，浏览器也不会直接讲 ACP。

## 要求

- Node.js `>= 22.19.0`
- `PATH` 上有 `grok` CLI

## 运行

```bash
npm install
npm run dev
```

默认监听 `http://127.0.0.1:30142`。回环地址不需要登录。

```bash
npm run start
```

以同样方式启动打包后的服务。`npm run dev:lan` / `npm run start:lan` 绑定 `0.0.0.0`，供同一信任域的局域网使用。

## 远程访问

非回环绑定需要密码。设置 `GROK_WEB_PASSWORD`，或在设置里配置。Basic Auth 用户名为 `grok`。

密码会经过不信任网络时，请使用 HTTPS 或受信任的 VPN。

## 数据

会话、认证、模型、skills 和 MCP 存放在 `~/.grok`（可用 `GROK_HOME` 覆盖）。仅属于本应用的元数据在 `~/.grok/grok-web/`。

## 发布

```bash
npm run pack:tanstack
```

会构建 TanStack 服务、暂存包含 CLI（`bin/grok-web.js` 及其导入的 `lib/` 文件）的包，并在临时目录生成 tarball。不要把发布脚本指到仓库内的输出目录。

## 许可证

MIT。见 [LICENSE](LICENSE)。英文说明：[README.md](README.md)。
