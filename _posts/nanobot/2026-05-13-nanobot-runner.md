---
layout: post-wide
title:  "04 Nanobot AgentRunner解析"
date:   2026-05-13 20:00:00 +0800
categories: [nanobot]
---

## 模块整体架构

Nanobot AgentRunner 模块实现了一个完整的工具使用型LLM代理执行引擎，该模块负责管理LLM与工具之间的交互循环。模块采用React范式设计，通过迭代的方式实现"思考-行动-观察"的循环过程。

### 架构设计理念

该模块的核心设计理念是**关注点分离**，将执行逻辑与产品层逻辑完全解耦。Runner专注于底层的工具执行、上下文管理、错误处理等核心功能，而通过AgentHook机制提供扩展点，允许上层应用定制行为而不侵入核心逻辑。

### 模块组织结构

模块主要包含以下核心组件：

- **配置类**：`AgentRunSpec` 和 `AgentRunResult` 数据类
- **执行引擎**：`AgentRunner` 主类及其辅助方法
- **安全边界**：SSRF防护、工作区违规检测机制
- **上下文治理**：消息历史管理、压缩、截断等功能

### 各文件关系

Runner模块与nanobot生态系统中的其他模块有明确的依赖关系：
- 依赖 `nanobot.agent.hook` 模块提供生命周期钩子
- 依赖 `nanobot.agent.tools.registry` 提供工具注册表
- 依赖 `nanobot.providers.base` 提供LLM提供商抽象
- 依赖 `nanobot.utils` 模块提供各种辅助函数

## 各文件功能详解

### AgentRunSpec 数据类

`AgentRunSpec` 类封装了单次代理执行的所有配置参数，使用Python的dataclass装饰器简化数据类的创建。

```python
@dataclass(slots=True)
class AgentRunSpec:
    """Configuration for a single agent execution."""
    
    initial_messages: list[dict[str, Any]]        # 初始消息列表
    tools: ToolRegistry                            # 工具注册表
    model: str                                     # 模型名称
    max_iterations: int                              # 最大迭代次数
    max_tool_result_chars: int                       # 工具结果最大字符数
    temperature: float | None = None                # 温度参数
    max_tokens: int | None = None                  # 最大输出token数
    reasoning_effort: str | None = None            # 推理努力程度
    hook: AgentHook | None = None                  # 生命周期钩子
    concurrent_tools: bool = False                   # 是否允许并发工具调用
    fail_on_tool_error: bool = False               # 工具错误时是否失败
    workspace: Path | None = None                   # 工作区路径
    session_key: str | None = None                 # 会话标识符
    context_window_tokens: int | None = None        # 上下文窗口token数
    context_block_limit: int | None = None          # 上下文块限制
    # ... 其他配置参数
```

该类使用了 `slots=True` 参数，这是一种内存优化技术，可以减少实例的内存占用并提高属性访问速度。

### AgentRunResult 数据类

`AgentRunResult` 类封装了代理执行的最终结果：

```python
@dataclass(slots=True)
class AgentRunResult:
    """Outcome of a shared agent execution."""
    
    final_content: str | None                       # 最终回复内容
    messages: list[dict[str, Any]]                 # 完整消息历史
    tools_used: list[str] = field(default_factory=list)  # 使用的工具列表
    usage: dict[str, int] = field(default_factory=dict)   # Token使用统计
    stop_reason: str = "completed"                 # 停止原因
    error: str | None = None                       # 错误信息
    tool_events: list[dict[str, str]] = field(default_factory=list)  # 工具事件记录
    had_injections: bool = False                    # 是否发生了消息注入
```

### AgentRunner 主类

`AgentRunner` 类是整个模块的核心，实现了完整的工具使用型LLM执行循环。

#### 核心方法列表

1. **`run(spec: AgentRunSpec) -> AgentRunResult`** - 主执行循环
2. **`_request_model()`** - 调用LLM提供商
3. **`_execute_tools()`** - 执行工具调用
4. **`_run_tool()`** - 单个工具执行的详细逻辑
5. **`_classify_violation()`** - 安全违规分类
6. **`_drop_orphan_tool_results()`** - 删除孤立工具结果
7. **`_backfill_missing_tool_results()`** - 回填缺失工具结果
8. **`_microcompact()`** - 微压缩消息历史
9. **`_apply_tool_result_budget()`** - 应用工具结果预算
10. **`_snip_history()`** - 截断历史消息
11. **`_partition_tool_batches()`** - 分区工具批次

## 语法知识点总结

### 1. 异步编程

#### 异步函数和协程

模块广泛使用了Python的异步编程特性，通过 `async def` 定义异步函数，使用 `await` 等待异步操作完成。

```python
async def run(self, spec: AgentRunSpec) -> AgentRunResult:
    # 初始化状态
    hook = spec.hook or AgentHook()
    messages = list(spec.initial_messages)
    
    # 主执行循环
    for iteration in range(spec.max_iterations):
        # 异步调用LLM
        response = await self._request_model(spec, messages_for_model, hook, context)
        
        # 异步执行工具
        results, new_events, fatal_error = await self._execute_tools(
            spec, tool_calls, external_lookup_counts, workspace_violation_counts,
        )
```

**使用场景**：当需要处理I/O密集型操作（如网络请求、文件读写）时，异步编程可以显著提高程序的并发性能。

#### 并发执行

模块使用 `asyncio.gather()` 实现并发工具执行：

```python
if spec.concurrent_tools and len(batch) > 1:
    batch_results = await asyncio.gather(*(
        self._run_tool(spec, tool_call, external_lookup_counts, workspace_violation_counts)
        for tool_call in batch
    ))
    tool_results.extend(batch_results)
```

**注意事项**：`asyncio.gather()` 会并发执行多个协程，当需要同时执行多个独立任务时非常有用。

#### 超时控制

使用 `asyncio.wait_for()` 实现超时控制：

```python
if timeout_s is None:
    return await coro
try:
    return await asyncio.wait_for(coro, timeout=timeout_s)
except asyncio.TimeoutError:
    return LLMResponse(
        content=f"Error calling LLM: timed out after {timeout_s:g}s",
        finish_reason="error",
        error_kind="timeout",
    )
```

**使用场景**：防止长时间运行的异步操作阻塞程序，提供超时保护机制。

### 2. 类型注解

模块使用了Python的类型注解系统，提供了完整的类型信息：

```python
from typing import Any, Optional

def _usage_dict(usage: dict[str, Any] | None) -> dict[str, int]:
    """将使用统计转换为整数字典"""
    if not usage:
        return {}
    result: dict[str, int] = {}
    for key, value in usage.items():
        try:
            result[key] = int(value or 0)
        except (TypeError, ValueError):
            continue
    return result
```

**类型注解的优点**：
- 提供代码文档功能
- 支持静态类型检查工具（如mypy）
- 改善IDE自动补全和错误检测

#### 联合类型

使用 `|` 操作符表示联合类型：

```python
temperature: float | None = None  # 等价于 Optional[float]
max_tokens: int | None = None     # 等价于 Optional[int]
```

### 3. 数据类

#### Dataclass装饰器

模块使用 `@dataclass` 装饰器简化数据类的创建：

```python
from dataclasses import dataclass, field

@dataclass(slots=True)
class AgentRunSpec:
    """Configuration for a single agent execution."""
    
    initial_messages: list[dict[str, Any]]
    tools: ToolRegistry
    model: str
    max_iterations: int
    max_tool_result_chars: int
    tools_used: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
```

**slots参数的作用**：
- 减少内存占用
- 提高属性访问速度
- 防止动态属性添加

#### Field函数

使用 `field()` 函数配置数据类字段的默认值：

```python
tools_used: list[str] = field(default_factory=list)
usage: dict[str, int] = field(default_factory=dict)
```

**注意事项**：对于可变默认值，必须使用 `default_factory` 函数而不是直接赋值，避免所有实例共享同一个可变对象。

### 4. 上下文管理器

#### Suppress上下文管理器

使用 `contextlib.suppress` 抑制特定异常：

```python
from contextlib import suppress

if callable(prepare_call):
    with suppress(Exception):
        prepared = prepare_call(tool_call.name, tool_call.arguments)
        if isinstance(prepared, tuple) and len(prepared) == 3:
            tool, params, prep_error = prepared
```

**使用场景**：当知道某些异常可以安全忽略时，使用 `suppress` 可以简化异常处理代码。

### 5. 函数式编程特性

#### Lambda表达式和高阶函数

模块中使用了一些函数式编程特性，特别是在工具批处理和消息处理方面：

```python
# 列表推导式和生成器表达式
ask_index = next((i for i, tc in enumerate(tool_calls) if tc.name == "ask_user"), None)

# 映射和过滤
tools_used.extend(tc.name for tc in tool_calls)
```

#### 装饰器概念

虽然没有直接定义装饰器，但模块使用了装饰器的概念，如 `@dataclass` 和 `@classmethod`：

```python
@classmethod
def _is_ssrf_violation(cls, text: str) -> bool:
    """检测文本是否包含SSRF违规标记"""
    if not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in cls._SSRF_MARKERS)
```

### 6. 异常处理

#### 自定义异常

模块定义了特殊的异常类型来控制执行流程：

```python
class AskUserInterrupt(BaseException):
    """内部信号：runner应该停止并等待用户输入"""
    
    def __init__(self, question: str, options: list[str] | None = None) -> None:
        self.question = question
        self.options = [str(option) for option in (options or []) if str(option)]
        super().__init__(question)
```

#### 多层异常处理

模块实现了复杂的异常处理逻辑：

```python
try:
    # 工具执行逻辑
    if tool is not None:
        result = await tool.execute(**params)
    else:
        result = await spec.tools.execute(tool_call.name, params)
except asyncio.CancelledError:
    raise  # 取消异常直接传播
except BaseException as exc:
    # 处理其他所有异常
    if isinstance(exc, AskUserInterrupt):
        return "", event, exc
    # 安全违规分类处理
    handled = self._classify_violation(...)
    if handled is not None:
        return handled
```

**异常处理策略**：
1. 特定异常特殊处理（如 `CancelledError`）
2. 异常类型判断和分类
3. 恢复性错误处理
4. 致命错误的适当传播

### 7. 字符串和数据处理

#### 字符串操作

模块包含大量的字符串处理逻辑：

```python
# 字符串分割和限制
detail = prep_error.split(": ", 1)[-1][:120]

# 字符串清理和格式化
detail = detail.replace("\n", " ").strip()

# 条件字符串构建
return f"{left}\n\n{right}" if left else right
```

#### 字典操作

模块使用了多种字典操作模式：

```python
# 字典默认值处理
target[key] = target.get(key, 0) + value

# 字典合并
merged = dict(left)
for key, value in right.items():
    merged[key] = merged.get(key, 0) + value

# 字典过滤和转换
result = {}
for key, value in usage.items():
    try:
        result[key] = int(value or 0)
    except (TypeError, ValueError):
        continue
```

### 8. 反射和内省

模块使用Python的反射机制来动态检查和调用对象：

```python
import inspect

# 检查函数签名
signature = inspect.signature(spec.injection_callback)
accepts_limit = (
    "limit" in signature.parameters
    or any(
        parameter.kind is inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
    )
)

# 动态获取方法
prepare_call = getattr(spec.tools, "prepare_call", None)
if callable(prepare_call):
    # 调用方法
    prepared = prepare_call(tool_call.name, tool_call.arguments)
```

**使用场景**：当需要编写灵活的代码，能够处理不同接口的对象时，反射机制非常有用。

### 9. 常量和不可变集合

模块使用了 `frozenset` 来定义不可变的工具集合：

```python
_COMPACTABLE_TOOLS = frozenset({
    "read_file", "exec", "grep", "glob",
    "web_search", "web_fetch", "list_dir",
})
```

**frozenset的特点**：
- 不可变，创建后无法修改
- 支持高效的成员检查
- 适合用作常量定义

### 10. 高级数据结构

#### 集合操作

模块使用了集合来进行高效的成员检查：

```python
declared: set[str] = set()
for idx, msg in enumerate(messages):
    if role == "assistant":
        for tc in msg.get("tool_calls") or []:
            if isinstance(tc, dict) and tc.get("id"):
                declared.add(str(tc["id"]))

if tid and str(tid) not in declared:
    # 处理孤立工具结果
```

#### 列表和元组

模块使用了多种列表和元组操作模式：

```python
# 元组解包
for assistant_idx, call_id, name in missing:
    insert_at = assistant_idx + 1 + offset
    # 处理逻辑

# 列表推导式
compactable_indices: list[int] = [
    idx for idx, msg in enumerate(messages)
    if msg.get("role") == "tool" and msg.get("name") in _COMPACTABLE_TOOLS
]
```

## 实际应用示例

### 基本使用方法

```python
import asyncio
from pathlib import Path
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.providers.openai import OpenAIProvider
from nanobot.agent.tools.registry import ToolRegistry

async def main():
    # 创建LLM提供商
    provider = OpenAIProvider(api_key="your-api-key")
    
    # 创建runner实例
    runner = AgentRunner(provider)
    
    # 准备工具注册表
    tools = ToolRegistry()
    tools.register_tool("read_file", read_file_tool)
    tools.register_tool("write_file", write_file_tool)
    
    # 配置执行规范
    spec = AgentRunSpec(
        initial_messages=[
            {"role": "user", "content": "请读取test.txt文件的内容"}
        ],
        tools=tools,
        model="gpt-4",
        max_iterations=10,
        max_tool_result_chars=10000,
        temperature=0.7,
        concurrent_tools=True,
        workspace=Path("/safe/workspace"),
        context_window_tokens=128000,
    )
    
    # 执行代理
    result = await runner.run(spec)
    
    # 处理结果
    print(f"最终内容: {result.final_content}")
    print(f"使用的工具: {result.tools_used}")
    print(f"停止原因: {result.stop_reason}")
    print(f"Token使用: {result.usage}")

if __name__ == "__main__":
    asyncio.run(main())
```

### 高级应用场景

#### 自定义钩子实现

```python
from nanobot.agent.hook import AgentHook, AgentHookContext

class CustomHook(AgentHook):
    """自定义生命周期钩子"""
    
    def wants_streaming(self) -> bool:
        """启用流式响应"""
        return True
    
    async def before_iteration(self, context: AgentHookContext) -> None:
        """每次迭代前的处理"""
        print(f"开始第 {context.iteration + 1} 次迭代")
        print(f"当前消息数量: {len(context.messages)}")
    
    async def on_stream(self, context: AgentHookContext, delta: str) -> None:
        """处理流式内容"""
        print(f"流式内容: {delta}", end="", flush=True)
    
    async def before_execute_tools(self, context: AgentHookContext) -> None:
        """工具执行前的处理"""
        print(f"\n准备执行 {len(context.tool_calls)} 个工具调用")
        for tool_call in context.tool_calls:
            print(f"  - {tool_call.name}: {tool_call.arguments}")
    
    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        """内容后处理"""
        if content:
            # 可以在这里添加内容过滤、格式化等逻辑
            return content.strip()
        return content

# 使用自定义钩子
spec = AgentRunSpec(
    # ... 其他参数
    hook=CustomHook(),
)
```

#### 进度回调实现

```python
from typing import Any

async def progress_callback(delta: str) -> None:
    """进度回调函数"""
    print(f"进度更新: {delta}")

# 检查点回调
async def checkpoint_callback(payload: dict[str, Any]) -> None:
    """检查点回调，用于状态持久化"""
    phase = payload.get("phase")
    iteration = payload.get("iteration")
    print(f"检查点: {phase} - 迭代 {iteration}")
    # 可以在这里实现状态保存逻辑

# 注入回调
async def injection_callback(limit: int | None = None) -> list[Any]:
    """消息注入回调"""
    # 可以实现用户中断、动态消息注入等功能
    return []

spec = AgentRunSpec(
    # ... 其他参数
    progress_callback=progress_callback,
    checkpoint_callback=checkpoint_callback,
    injection_callback=injection_callback,
    stream_progress_deltas=True,
)
```

### 最佳实践建议

#### 1. 上下文管理

合理设置上下文窗口限制，避免超出模型限制：

```python
spec = AgentRunSpec(
    # ... 其他参数
    context_window_tokens=128000,        # 设置上下文窗口大小
    context_block_limit=100000,           # 设置上下文块限制
    max_tool_result_chars=5000,          # 限制工具结果大小
)
```

#### 2. 错误处理策略

根据应用场景选择合适的错误处理策略：

```python
# 开发环境：立即失败，便于调试
spec_development = AgentRunSpec(
    fail_on_tool_error=True,             # 工具错误时立即失败
    # ... 其他参数
)

# 生产环境：容错处理
spec_production = AgentRunSpec(
    fail_on_tool_error=False,            # 工具错误时继续执行
    concurrent_tools=True,               # 启用并发工具执行
    # ... 其他参数
)
```

#### 3. 性能优化

启用并发工具执行和进度流式传输：

```python
spec = AgentRunSpec(
    # ... 其他参数
    concurrent_tools=True,               # 启用并发工具执行
    stream_progress_deltas=True,         # 启用进度流式传输
    progress_callback=progress_callback,  # 设置进度回调
)
```

#### 4. 安全配置

配置工作区限制和安全检查：

```python
spec = AgentRunSpec(
    # ... 其他参数
    workspace=Path("/safe/workspace"),  # 限制工作区范围
    session_key="user_session_123",     # 设置会话标识符
)
```

## 核心执行流程详解

### 整体执行流程图

```
开始执行
    ↓
初始化状态 (hook, messages, counters等)
    ↓
进入迭代循环 (max_iterations次)
    ↓
┌─────────────────────────────────────┐
│  上下文治理                        │
│  - 删除孤立工具结果                │
│  - 回填缺失工具结果                │
│  - 微压缩消息历史                  │
│  - 应用工具结果预算                │
│  - 截断历史消息                    │
│  - 异常恢复处理                    │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  调用前钩子                       │
│  await hook.before_iteration()       │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  请求LLM响应                       │
│  await self._request_model()        │
│  - 构建请求参数                   │
│  - 处理超时控制                   │
│  - 流式/非流式/增量流式调用       │
│  - 提取usage和tool_calls          │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  响应类型判断                     │
│  response.should_execute_tools?     │
└─────────────────────────────────────┘
    ↓
    ├─ 是 → 工具执行流程
    │        ↓
    │   截取ask_user之前的工具调用
    │        ↓
    │   构建assistant_message
    │        ↓
    │   流式结束处理 (resuming=True)
    │        ↓
    │   执行前钩子
    │        ↓
    │   ┌─────────────────────────────────┐
    │   │  工具执行                     │
    │   │  - 分区工具批次               │
    │   │  - 并发/串行执行             │
    │   │  - _run_tool详细处理          │
    │   └─────────────────────────────────┘
    │        ↓
    │   构建tool_messages
    │        ↓
    │   ┌─────────────────────────────────┐
    │   │  致命错误处理               │
    │   │  - AskUserInterrupt → 停止    │
    │   │  - 其他错误 → 错误恢复       │
    │   │  - 注入处理检查             │
    │   └─────────────────────────────────┘
    │        ↓
    │   工具执行后注入检查
    │        ↓
    │   迭代后钩子
    │        ↓
    │   继续下一次迭代
    │
    └─ 否 → 最终响应处理流程
             ↓
        ┌─────────────────────────────────┐
        │  空内容处理                  │
        │  - 重试逻辑                  │
        │  - 最终化重试               │
        │  - 注入处理检查             │
        └─────────────────────────────────┘
             ↓
        ┌─────────────────────────────────┐
        │  长度截断恢复               │
        │  - 长度恢复计数             │
        │  - 继续截断逻辑             │
        │  - 注入处理检查             │
        └─────────────────────────────────┘
             ↓
        ┌─────────────────────────────────┐
        │  最终响应处理               │
        │  - 构建assistant_message    │
        │  - 注入检查 (关键点)        │
        │  - 流式结束处理           │
        │  - 注入处理检查           │
        └─────────────────────────────────┘
             ↓
        ┌─────────────────────────────────┐
        │  错误处理                  │
        │  - 模型错误处理             │
        │  - 空响应处理               │
        │  - 注入处理检查             │
        └─────────────────────────────────┘
             ↓
        ┌─────────────────────────────────┐
        │  正常完成                  │
        │  - 返回最终结果             │
        │  - 迭代后钩子               │
        └─────────────────────────────────┘
    ↓
正常跳出或达到最大迭代次数
    ↓
┌─────────────────────────────────────┐
│  最大迭代次数处理                  │
│  - 设置停止原因                   │
│  - 生成最大迭代消息               │
│  - 处理剩余注入                  │
└─────────────────────────────────────┘
    ↓
返回AgentRunResult
    ↓
结束
```

### _run_tool 函数详细流程

`_run_tool` 函数实现了单个工具执行的完整逻辑，包含多层安全检查和错误处理。

```
开始执行单个工具
    ↓
┌─────────────────────────────────────┐
│  重复外部查找检查                 │
│  - 检查web_fetch/web_search重复    │
│  - 超过_MAX_REPEAT_EXTERNAL_LOOKUPS│
│  - 返回阻塞错误                   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  工具准备调用                    │
│  - 检查prepare_call方法          │
│  - 执行工具准备逻辑              │
│  - 获取tool, params, prep_error   │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  准备错误处理                    │
│  - 安全违规分类                  │
│  - SSRF检查                      │
│  - 工作区违规检查                │
│  - 重复违规升级                  │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  工具执行                        │
│  try:                            │
│  - tool.execute(**params)          │
│  - 或 spec.tools.execute()         │
│  except:                         │
│  - 取消异常直接传播              │
│  - 其他异常分类处理              │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  执行异常处理                    │
│  - AskUserInterrupt特殊处理        │
│  - 安全违规分类                  │
│  - fail_on_tool_error判断         │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  结果字符串错误检查               │
│  - 检查result.startswith("Error")  │
│  - 安全违规分类                  │
│  - fail_on_tool_error判断         │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  成功结果处理                    │
│  - 构建event记录                │
│  - 格式化详细信息                │
│  - 返回 (result, event, None)    │
└─────────────────────────────────────┘
    ↓
返回工具执行结果
```

### 安全违规分类流程

```
开始安全违规分类
    ↓
┌─────────────────────────────────────┐
│  SSRF违规检查                    │
│  - 检查internal/private url标记   │
│  - 检查private address标记       │
│  返回不可重试错误+安全边界说明  │
└─────────────────────────────────────┘
    ↓
┌─────────────────────────────────────┐
│  工作区违规检查                  │
│  - 检查outside workspace标记      │
│  - 检查path traversal标记         │
│  - 计算违规签名                  │
│  - 检查重复违规次数             │
└─────────────────────────────────────┘
    ↓
    ├─ 首次违规 → 返回软错误+提示
    │
    └─ 重复违规 → 返回升级错误+强制停止提示
         ↓
    返回None → 继续正常错误处理流程
```

### 异常判断分支逻辑

```
异常处理总分支结构：

┌─────────────────────────────────────────────────────────────┐
│                    主异常处理入口                          │
│  try:                                                   │
│      # 主要逻辑                                          │
│  except Exception:                                        │
│      # 异常恢复处理                                      │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│              上下文治理异常处理                           │
│  - 记录异常日志                                        │
│  - 尝试最小恢复 (drop_orphan + backfill)                │
│  - 恢复失败则使用原始消息                              │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│              工具执行异常处理                             │
│  - CancelledError: 直接传播                              │
│  - AskUserInterrupt: 特殊处理，停止并等待用户           │
│  - BaseException: 一般异常处理                            │
│    * 安全违规分类                                        │
│    * fail_on_tool_error判断                               │
│    * 注入处理检查                                       │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│              LLM响应异常处理                             │
│  - finish_reason == "error": 模型错误                    │
│  - 空内容响应: 重试或最终化                            │
│  - finish_reason == "length": 长度恢复                    │
│  - 所有情况都进行注入检查                                │
└─────────────────────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────────────────────┐
│              注入处理分支                                 │
│  - 检查injection_cycles是否超限                         │
│  - 调用drain_injections获取注入消息                     │
│  - 附加注入消息到历史                                   │
│  - 发出检查点事件                                       │
│  - 返回 should_continue 决策                             │
└─────────────────────────────────────────────────────────────┘
```

### 工具执行批处理流程

```
工具批处理开始
    ↓
┌─────────────────────────────────────┐
│  检查concurrent_tools配置        │
└─────────────────────────────────────┘
    ↓
    ├─ False → 串行执行
    │        ↓
    │   每个工具单独一批
    │        ↓
    │   顺序执行每个工具调用
    │        ↓
    │   AskUserInterrupt时停止
    │
    └─ True → 智能批处理
             ↓
        遍历工具调用列表
             ↓
        ┌─────────────────────────────────┐
        │  检查工具并发安全性          │
        │  tool.concurrency_safe?       │
        └─────────────────────────────────┘
             ↓
             ├─ True → 加入当前批次
             │          ↓
             │   继续下一个工具
             │
             └─ False → 当前批次结束
                       ↓
                  开始新批次 (当前工具)
                       ↓
        所有工具处理完成
             ↓
        ┌─────────────────────────────────┐
        │  批次执行                    │
        │  - 单一批次: 串行执行        │
        │  - 多个工具: 并发执行        │
        │  - AskUserInterrupt中断       │
        └─────────────────────────────────┘
             ↓
        返回批处理结果
```

## 总结

Nanobot AgentRunner 模块实现了一个功能完整、设计优雅的LLM工具调用执行引擎。该模块通过以下核心特性提供了强大的代理执行能力：

1. **React范式实现**：通过迭代循环实现思考-行动-观察的执行模式
2. **健壮的异常处理**：多层异常处理机制，确保系统稳定性
3. **智能上下文管理**：压缩、截断、清理等多种上下文治理策略
4. **安全边界防护**：SSRF防护、工作区隔离、重复操作限制
5. **可扩展架构**：通过钩子机制提供灵活的扩展点
6. **性能优化**：并发工具执行、进度流式传输、上下文压缩
7. **完善的可观察性**：检查点、事件记录、进度回调

该模块的设计充分体现了Python异步编程的优势，结合了类型安全、内存优化、函数式编程等多种编程范式，为构建复杂的LLM代理应用提供了坚实的基础。

通过理解该模块的设计思路和实现细节，开发者可以更好地理解LLM代理系统的架构设计，并为类似应用开发提供宝贵的参考。
