# DSH 会话数据格式

> 本文档记录**实测确认**的 DeepSeek Harness 会话格式。
> 验证时间：2026-10-13 · 样本：本机 4 个真实会话（463 帧 / 994 行）
> 验证脚本：`probe/decode3.mjs`、`probe/decode4.mjs`、`probe/aggregate.mjs`

---

## 1. 文件位置

```
<DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.vN.jsonl.zstd
```

- `DSH_HOME` 默认 `~/.dsh`（Windows `%USERPROFILE%\.dsh`），可用环境变量覆盖
- `<workspace-slug>`：cwd 转义而来，如 `--C-Users-you-Documents-project--`
- 文件名为 `session.v<版本>.jsonl.zstd`；当前版本 **v4**

---

## 2. ⚠️ 最关键的一点：文件是多帧 zstd 拼接

DSH 会话是**追加式事件流**，每次追加写一个独立的 zstd 帧。因此磁盘上的文件是 **N 个完整 zstd 帧首尾拼接**。

实测帧数：

| 会话 | zstd 帧数 | 解码后行数 |
|---|---:|---:|
| 128ca5cf… | 60 | 173 |
| 8383b82c… | 96 | 195 |
| adb91e26… | 74 | 194 |
| session-32fd… | 233 | 432 |

### 失败的读法

| 方法 | 结果 |
|---|---|
| `zlib.zstdDecompressSync(整文件)` | ❌ **只返回第 1 帧**（实测只解出 1 行 header） |
| `zlib.createZstdDecompress()` 流式 | ❌ **同样只返回第 1 帧** |

> 这两种写法都会**静默丢数据** —— 不报错，但只拿到 1 行。这是最危险的坑。

### 正确读法

按 zstd magic number `28 B5 2F FD` 切分，逐帧解码后拼接：

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decodeFrames(buf) {
  const offsets = [];
  let p = 0;
  while (true) {
    const i = buf.indexOf(MAGIC, p);
    if (i < 0) break;
    offsets.push(i);
    p = i + MAGIC.length;
  }
  const parts = [];
  let badFrames = 0;
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      let s = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      if (s && !s.endsWith('\n')) s += '\n';   // 防止帧间粘连
      parts.push(s);
    } catch { badFrames += 1; }                 // 坏帧计数，不中断
  }
  return { frames: offsets.length, badFrames, text: parts.join('') };
}
```

**实测：463/463 帧全部解码成功。**

实现见 `src/adapters/zstd-frames.mjs`。

---

## 3. 记录结构

### 第 1 行：header（字段在**顶层**）

```json
{
  "type": "session",
  "version": 4,
  "id": "128ca5cf-c3be-493c-9e81-95e60349c0af",
  "createdAt": 1791706844354,
  "cwd": "C:\\Users\\you\\Documents\\project",
  "parentSession": "session-32fd3d17-...",
  "isSeeded": false,
  "origin": "subagent",
  "delegationDepth": 1,
  "agentPreset": "standard"
}
```

> ⚠️ 注意：header 字段在**顶层**，而事件字段在 `.data` —— 两者层级不同。

### 之后每行：事件

```json
{ "type": "tool/call", "seq": 20, "time": 1791706651919, "data": { ... } }
```

---

## 4. 事件类型

| 事件 | 实测存在 | 说明 |
|---|:---:|---|
| `user/message` | ✅ | 用户输入，内容在 `data.content[]` |
| `assistant/message` | ✅ | 助手消息，内容在 `data.message.content[]`，带 `data.usage` |
| `tool/call` | ✅ | 工具调用 |
| `tool/result` | ✅ | 工具结果 |
| `session/title` | ✅ | 会话标题，`data.title` |
| `approval/policy` | ✅ | 审批策略，`data.policy`（如 `"ask"`） |
| `sandbox/mode` | ✅ | 沙箱模式 |
| `model/selection` | ✅ | 模型选择 |
| `permission/preset` | ✅ | 权限预设 |
| `turn/start` `turn/end` | ✅ | 回合边界 |
| `step/start` `step/end` | ✅ | 步骤边界 |
| `subagent/catalog` | ✅ | 子代理目录 |
| `agent/inbox/spliced` | ✅ | 代理收件箱 |
| `workspace/changes` | ✅ | 工作区变更 |
| `deliverables/presented` | ✅ | 交付物 |
| `session-log-deepseek/delivery-accepted` | ✅ | 投递确认 |
| `request/header` `request/context` | ✅ | 请求元信息 |
| **`approval/asked`** | ❌ | **不存在** |
| **`approval/decided`** | ❌ | **不存在** |
| **`llm/retry`** | ❌ | **样本中未观测到** |
| **`assistant/chunk`** | ❌ | **不存在** |

> 后四项的缺失直接影响指标实现：N3（审批摩擦）、N4（API 重试）**无法按原设计实现**。

---

## 5. 关键字段

### usage（camelCase！）

```json
"usage": {
  "inputTokens": 7616,
  "outputTokens": 169,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "totalTokens": 7785
}
```

> ⚠️ 是 **camelCase**（`inputTokens`），不是 snake_case（`input_tokens`）。

### assistant/message 的内容块

`data.message.content[]`，元素 `type` 有三种：

| type | 字段 | 说明 |
|---|---|---|
| `reasoning` | `text` | 思考过程 |
| `text` | `text` | 正式回复 |
| `tool-call` | `id` `name` `arguments` | 工具调用（与独立 `tool/call` 事件对应） |

实测分布：`reasoning` 48 · `tool-call` 74 · `text` 26

### user/message

内容在 `data.content[]`（**注意不是 `data.message.content`**）：

```json
{ "content": [{ "type": "text", "text": "..." }],
  "source": { "kind": "user" }, "role": "user", "id": "..." }
```

### tool/call

```json
{ "turn": 1, "step": 1,
  "callId": "call_00_JvO2HbR2qQQj2LcHmYJA5551",
  "name": "web_fetch",
  "arguments": "{\"url\": \"https://...\"}" }
```

> ⚠️ `arguments` 是 **JSON 字符串**，不是对象 —— 哈希前必须先 `JSON.parse`。

### tool/result 的失败信号（双重）

```json
{ "turn": 1, "step": 10,
  "message": { "isError": true,
               "content": [{ "type": "text", "text": "Error: tool call aborted" }] },
  "error": { "name": "AbortError", "code": "ABORTED" } }
```

判定失败：`data.error` 存在 **或** `data.message.isError === true`。

---

## 6. 实测基线（4 会话）

```
463 帧 / 994 行 / 85 助手消息 / 22 用户消息 / 220 工具调用
错误 16（7.3%）
input 421,174 · output 112,140 · cacheRead 6,447,872 · cacheWrite 0
cacheRead 占比 93.9%
解析耗时 128ms
TOP 工具：web_fetch 156 · web_search 26 · pwsh 13 · list_agents 4
```

> **`cacheRead` 占比 93.9%** 说明缓存工作良好。任何基于 "cache_read 占比低 = 上下文膨胀" 的判据都需要按真实分布重新标定。

---

## 7. 版本差异

| 版本 | 压缩 | 状态 |
|---|---|---|
| v4 | 多帧 zstd | 当前，已实测 |
| v3 | 待验证（可能是单帧或无压缩） | 未实测 |
| 无压缩 `.jsonl` | 明文 | 代码已支持（无 magic 时按明文读） |

适配层按 header 的 `version` 字段分发；未知版本应**跳过该源并明确提示**，不得静默处理。

---

## 8. 验证方法

```bash
node src/cli.mjs scan          # 应输出 会话数 / 帧数 / 行数
node src/cli.mjs show "<file>#L20"   # 展开第 20 行，核对行号一致
```
