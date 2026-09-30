---
name: zcode-build-deploy
description: ZCode 仓库的编译、部署与故障排查指南。编译/构建/部署 web 或 desktop 版、启动本地服务、agent 进程崩溃、聊天窗口/composer 无法输入、ERR_MODULE_NOT_FOUND、dist 缺失、前端白屏或 TypeError 排查时务必使用本技能；用户提到「构建 zcode」「部署 zcode」「起服务」「页面卡死/输入不了」等场景也要使用。
---

# ZCode 编译部署指南

本技能记录一次完整排障得出的构建顺序、部署机制与踩坑教训。核心教训：**构建顺序错了不会立刻报错，而是表现为运行时 agent 崩溃循环、前端组件诡异禁用**——必须在部署前按正确顺序构建。

## 构建顺序（关键）

pnpm workspace + turbo，包之间通过 `package.json` exports 指向 `dist/` 互相引用。**TypeScript 源码不构建 dist 时，import 会在运行时失败**，即使有 tsx 之类的 TS 直接执行器也一样（见下文「agent 运行机制」）。

```bash
# 1. 根目录安装依赖
pnpm install

# 2. 构建 apps/zcode-cli 工作区全部包（agent 运行时的依赖，缺一个都会崩）
cd apps/zcode-cli && pnpm -r --filter './packages/*' build && cd -

# 3. 按需构建根工作区的包（shared / services / server / ui 等）
pnpm -r build        # 或按需: pnpm --filter @zcode/contracts build 等

# 4. 前端 web 构建
cd packages/web && pnpm build
```

### 为什么 apps/zcode-cli 的 dist 必须构建

agent 运行时以 `tsx apps/zcode-cli/packages/cli/src/main.ts app-server --stdio` 直接执行 TS 源码，**但**它解析 `@zcode/contracts/plugins` 这类子路径导入时走 `package.json` 的 `exports` 映射 → 指向 `./dist/plugins/index.js` → dist 不存在即 `ERR_MODULE_NOT_FOUND`。tsx 只跳过「当前正在执行的 TS 文件」的转译，不会替依赖包生成 dist。

**症状特征**（2026-09-30 实际事故）：agent 进程启动即退出 → 服务端反复上报 runtime `unavailable` → 前端 `draftRuntimeRebuilding` 门禁循环重置 → **聊天窗口/composer 永久禁用、无法输入，且 F12 无任何报错**。

检查是否有包缺构建：

```bash
cd apps/zcode-cli/packages && for p in */; do
  [ -d "$p/src" ] && [ ! -f "$p/dist/index.js" ] && echo "MISSING DIST: $p"
done
```

## web 版部署机制

服务端在本机直接跑，静态目录**直连构建产物**：

```bash
ZCODE_WEB_STATIC_ROOT=$PWD/packages/web/dist \
ZCODE_DATA_BASE_DIR=$HOME/zcode-data \
ZCODE_ENV=production \
node packages/server/dist/entry-http.js > /tmp/zcode-server.log 2>&1 &
```

- 端口 3030；`ZCODE_WEB_STATIC_ROOT` 指向 `packages/web/dist`，**前端重新构建后无需重启服务**，浏览器 Ctrl+Shift+R 强刷即可。
- 但 `packages/server/dist/entry-http.js` 本身是构建产物——server 侧源码改动后需要重新构建并重启进程。
- 确认部署的 bundle 是否最新：页面源码里 `index-*.js` 的 hash 应与 `packages/web/dist/assets/` 下最新文件一致。

## 健康检查与日志

日志在 `/tmp/zcode-server.log`（可能上 GB，务必用 grep/awk 按时间过滤，别直接 tail 大段）：

```bash
# agent 是否存活：看到 started 后跟着一串 OK 即正常
grep -E "ZCode agent process (started|exited)" /tmp/zcode-server.log | tail -5
grep -E "subscribeSessionsIndexV4 OK|sendConversationCommandV4 OK" /tmp/zcode-server.log | tail -3

# 崩溃循环特征：started/exited/cleanup 高频交替出现
awk '/09:55:[0-9][0-9]/ && /zcode-agent|ERR_MODULE|cleanup|unavailable/' /tmp/zcode-server.log | tail -20
```

前端接口探测：`curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3030/api/status`

## 排障 playbook

### 聊天窗口/composer 无法输入（无 console 报错）

按序排查：
1. 先看服务端日志是否有 agent 崩溃循环（最常见根因，见上文 dist 缺失）。
2. composer 禁用因子来自 `SessionPane.tsx`：`connecting || draftRuntimeRebuilding || queueEditActiveForCurrentComposer || quotaBanner.state.blocksSubmit`。可在 `ConversationComposer.tsx` 的发送按钮容器临时加 `data-debug-*` 属性暴露各布尔值，让用户在 console 读取，定位后**记得移除**。
3. `draftRuntimeRebuilding` 有 5s 超时兜底，持续为 true 必然是上游 `unavailable` 事件在反复触发。

### 前端压缩栈报错（如 `imeComposition-xxx.js:8 TypeError`）

用 sourcemap 还原，别靠猜：

```bash
node -e "
const {SourceMapConsumer}=require('<repo>/node_modules/source-map');
const map=JSON.parse(require('fs').readFileSync('packages/web/dist/assets/<chunk>.js.map','utf8'));
const c=new SourceMapConsumer(map);
console.log(c.originalPositionFor({line:8,column:47312,bias:SourceMapConsumer.LEAST_UPPER_BOUND}));
"
```

对栈里每一帧逐一还原（含 react 内部帧与 index chunk 帧），还原出的调用链通常直接指到出问题的源码文件。

### Rules of Hooks 违规（本仓库已知踩坑模式）

历史上出现过 3 处同款违规（均已修复于 useZCodeSessionService / useZCodeAgentService / useZCodeTaskService）：

```ts
// 错误：条件调用 hook，workspacePath 两次渲染间变化时 hook 链错位崩溃
const services = workspacePath ? useWorkspaceServices(...) : useServices();
// 正确：无条件调用，只按条件选返回值
const ws = useWorkspaceServices(workspacePath ?? null, ...);
const ctx = useServices();
return (workspacePath ? ws : ctx).service;
```

这类 bug 的典型表现：`useCallback`/`useSyncExternalStore` 内部 `Cannot read properties of undefined (reading 'length')`（React `areHookInputsEqual` 读到其他 hook 的 memoizedState）。改动 hooks 相关代码时主动检查此模式。

## desktop 版备注

desktop 的 `postinstall` 会触发 node-pty 重建；若环境无法编译原生模块，仓库里曾临时改为跳过（`packages/desktop/package.json` 的 postinstall 与 `pnpm-workspace.yaml` 的 `node-pty: false`）。node-pty 只影响终端功能，不影响 agent 聊天链路。
