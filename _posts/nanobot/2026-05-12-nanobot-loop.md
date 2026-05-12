---
layout: post-wide
title:  "03 Nanobot Loop模块解析"
date:   2026-05-11 20:00:00 +0800
categories: [nanobot]
---

## 一、Loop 模块整体架构

Nanobot 的 loop 模块实现了 AI 代理的核心处理引擎，负责协调消息处理、工具执行、会话管理和内存整合等功能。整体架构如下：

```
nanobot/agent/
└── loop.py          # 核心代理循环引擎
```

### 架构设计理念

1. **钩子驱动架构**：通过钩子机制实现扩展点和事件处理
2. **异步优先**：基于 asyncio 的高效并发消息处理
3. **容错优先**：完善的错误处理、任务中断恢复和检查点机制
4. **资源管理**：会话级锁、并发控制、后台任务调度

### 核心设计模式

- **钩子模式**：AgentHook 作为基础接口，支持前置/后置钩子
- **组合模式**：CompositeHook 支持多个钩子的组合
- **生产者-消费者模式**：通过消息总线和待处理队列解耦消息流
- **策略模式**：根据消息类型选择不同的处理策略
- **责任链模式**：消息处理通过多层处理器链完成

## 二、各文件功能详解

### 2.1 `_LoopHook` 类 - 核心钩子实现

**文件作用**：实现代理循环的核心钩子机制，提供流式传输、进度更新、迭代控制等功能。

#### 关键特性：

```python
class _LoopHook(AgentHook):
    """Core hook for the main loop."""
    
    def __init__(
        self,
        agent_loop: AgentLoop,
        on_progress: Callable[..., Awaitable[None]] | None = None,
        on_stream: Callable[[str], Awaitable[None]] | None = None,
        on_stream_end: Callable[..., Awaitable[None]] | None = None,
        *,
        channel: str = "cli",
        chat_id: str = "direct",
        message_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        session_key: str | None = None,
    ) -> None:
        super().__init__(reraise=True)
        self._loop = agent_loop
        self._on_progress = on_progress
        self._on_stream = on_stream
        self._on_stream_end = on_stream_end
        self._stream_buf = ""
```

#### 主要方法：

**流式传输控制**：
- `wants_streaming()`：检查是否启用流式传输
- `on_stream()`：处理流式内容增量，过滤思考标签并发送增量
- `on_stream_end()`：标记流式传输结束，支持续传状态

**生命周期钩子**：
- `before_iteration()`：迭代开始前调用
- `before_execute_tools()`：工具执行前调用
- `after_iteration()`：迭代结束后调用
- `finalize_content()`：内容最终化处理

### 2.2 `AgentLoop` 类 - 代理循环核心

**文件作用**：实现完整的代理处理循环，包括消息路由、工具执行、会话管理、内存整合等核心功能。

#### 核心组件初始化：

```python
def __init__(
    self,
    bus: MessageBus,                              # 消息总线
    provider: LLMProvider,                        # LLM 提供商
    workspace: Path,                              # 工作区路径
    model: str | None = None,                     # 模型名称
    max_iterations: int | None = None,            # 最大迭代次数
    context_window_tokens: int | None = None,     # 上下文窗口大小
    context_block_limit: int | None = None,       # 上下文块限制
    max_tool_result_chars: int | None = None,     # 工具结果最大字符数
    provider_retry_mode: str = "standard",        # 提供商重试模式
    tool_hint_max_length: int | None = None,      # 工具提示最大长度
    web_config: WebToolsConfig | None = None,     # Web 工具配置
    exec_config: ExecToolConfig | None = None,    # 执行工具配置
    cron_service: CronService | None = None,      # 定时任务服务
    restrict_to_workspace: bool = False,          # 是否限制在工作区内
    session_manager: SessionManager | None = None, # 会话管理器
    mcp_servers: dict | None = None,              # MCP 服务器配置
    channels_config: ChannelsConfig | None = None, # 频道配置
    timezone: str | None = None,                  # 时区设置
    session_ttl_minutes: int = 0,                 # 会话生存时间
    consolidation_ratio: float = 0.5,              # 整合比例
    max_messages: int = 120,                      # 最大消息数
    hooks: list[AgentHook] | None = None,         # 自定义钩子
    unified_session: bool = False,                # 是否使用统一会话
    disabled_skills: list[str] | None = None,      # 禁用的技能列表
    tools_config: ToolsConfig | None = None,       # 工具配置
    provider_snapshot_loader: Callable[[], ProviderSnapshot] | None = None, # 提供商快照加载器
    provider_signature: tuple[object, ...] | None = None, # 提供商签名
):
```

#### 初始化的核心组件：

```python
# 消息总线和核心配置
self.bus = bus
self.channels_config = channels_config
self.provider = provider
self.provider_signature = provider_signature
self.workspace = workspace
self.model = model or provider.get_default_model()

# 上下文和会话管理
self.context = ContextBuilder(workspace, timezone=timezone, disabled_skills=disabled_skills)
self.sessions = session_manager or SessionManager(workspace)

# 工具系统和状态跟踪
self.tools = ToolRegistry()
self._file_state_store = FileStateStore()  # 文件状态存储

# 代理运行器和子代理管理
self.runner = AgentRunner(provider)
self.subagents = SubagentManager(
    provider=provider,
    workspace=workspace,
    bus=bus,
    model=self.model,
    web_config=self.web_config,
    max_tool_result_chars=self.max_tool_result_chars,
    exec_config=self.exec_config,
    restrict_to_workspace=restrict_to_workspace,
    disabled_skills=disabled_skills,
    max_iterations=self.max_iterations,
)

# 内存管理系统
self.consolidator = Consolidator(
    store=self.context.memory,
    provider=provider,
    model=self.model,
    sessions=self.sessions,
    context_window_tokens=self.context_window_tokens,
    build_messages=self.context.build_messages,
    get_tool_definitions=self.tools.get_definitions,
    max_completion_tokens=provider.generation.max_tokens,
    consolidation_ratio=consolidation_ratio,
)

self.auto_compact = AutoCompact(
    sessions=self.sessions,
    consolidator=self.consolidator,
    session_ttl_minutes=session_ttl_minutes,
)

self.dream = Dream(
    store=self.context.memory,
    provider=provider,
    model=self.model,
)
```

#### 并发控制机制：

```python
# 会话锁：确保同一会话的消息串行处理
self._session_locks: dict[str, asyncio.Lock] = {}

# 待处理队列：用于中途消息注入
self._pending_queues: dict[str, asyncio.Queue] = {}

# 活动任务跟踪：session_key -> tasks 列表
self._active_tasks: dict[str, list[asyncio.Task]] = {}

# 并发控制门：限制最大并发请求数
_max = int(os.environ.get("NANOBOT_MAX_CONCURRENT_REQUESTS", "3"))
self._concurrency_gate: asyncio.Semaphore | None = (
    asyncio.Semaphore(_max) if _max > 0 else None
)

# 后台任务跟踪：用于清理和关闭
self._background_tasks: list[asyncio.Task] = []
```

## 三、语法知识点总结

### 3.1 异步上下文管理器

**概念说明**：
`AsyncExitStack` 是 Python 的异步上下文管理器，用于管理多个异步资源的自动清理，特别适合需要成对分配和释放资源的场景。

```python
from contextlib import AsyncExitStack

class AsyncResourceManager:
    """异步资源管理器示例"""
    
    def __init__(self):
        self.stack = AsyncExitStack()
        self.resources = []
    
    async def __aenter__(self):
        """进入上下文时分配资源"""
        resource = await allocate_resource()
        await self.stack.aclose(resource)
        self.resources.append(resource)
        return resource
    
    async def __aexit__(self, exc_type, exc_val, tb):
        """退出上下文时自动清理所有资源"""
        # 等待栈清理完成
        await self.stack.aclose()
        # 额外清理逻辑
        self.resources.clear()

# 使用示例
async with AsyncResourceManager() as resource:
    # 在这里使用资源
    await process_with_resource(resource)
    # 退出时自动清理
```

**使用场景**：
- 多个异步资源的统一管理
- 确保资源清理的顺序正确
- 支持嵌套的异步上下文管理

**注意事项**：
- `AsyncExitStack` 保证资源按照后进先出顺序清理
- 即使在异常情况下也会执行清理
- 适合需要成对分配和释放的资源

### 3.2 条件导入和类型检查

**概念说明**：
`TYPE_CHECKING` 是一个特殊的常量，用于类型注解的导入控制，避免在运行时导入不必要的模块。

```python
if TYPE_CHECKING:
    # 只在类型检查时才导入这些模块
    from nanobot.config.schema import ChannelsConfig, ExecToolConfig, ToolsConfig, WebToolsConfig
    from nanobot.cron.service import CronService
```

**使用场景**：
- 减少类型检查时的导入开销
- 避免循环导入依赖
- 在不同执行环境中提供不同的导入策略

**注意事项**：
- `TYPE_CHECKING` 通常由静态类型检查器（如 mypy）自动设置
- 在运行时导入的模块通常不会有实际的副作用
- 仅在类型检查阶段影响导入行为

### 3.3 复杂类型注解

**概念说明**：
Python 支持复杂的类型注解，包括联合类型、可选类型、嵌套类型等，用于精确描述函数参数和返回值的类型。

```python
from typing import TYPE_CHECKING, Any, Awaitable, Callable

# 联合类型注解
async def _run_agent_loop(
    self,
    initial_messages: list[dict],
    on_progress: Callable[..., Awaitable[None]] | None = None,
    on_stream: Callable[[str], Awaitable[None]] | None = None,
    on_stream_end: Callable[..., Awaitable[None]] | None = None,
    pending_queue: asyncio.Queue | None = None,
) -> tuple[str | None, list[str], list[dict], str, bool]:
    """
    返回类型是一个复杂的元组，包含：
    - str | None: 最终内容（可能为空）
    - list[str]: 使用的工具列表
    - list[dict]: 所有消息历史
    - str: 停止原因
    - bool: 是否有中途注入
    """
```

**使用场景**：
- 描述复杂的函数返回类型
- 支持多种可能的返回状态
- 提高代码的可读性和类型安全性

**注意事项**：
- 联合类型的顺序很重要，通常按照重要性排序
- 可选类型使用 `| None` 语法
- 类型注解不会在运行时强制类型检查

### 3.4 钩子基类和继承

**概念说明**：
钩子基类 `AgentHook` 提供了代理循环的扩展点接口，通过继承和多态实现自定义逻辑。

```python
# 基础钩子类
class AgentHook:
    """代理钩子基类，定义了钩子生命周期方法"""
    
    def __init__(self, reraise: bool = False) -> None:
        """初始化钩子"""
    
    async def before_iteration(self, context: AgentHookContext) -> None:
        """迭代开始前调用"""
    
    async def before_execute_tools(self, context: AgentHookContext) -> None:
        """工具执行前调用"""
    
    async def after_iteration(self, context: AgentHookContext) -> None:
        """迭代结束后调用"""
    
    def finalize_content(self, context: AgentHookContext, content: str | None) -> str | None:
        """内容最终化处理"""
    
    @property
    def wants_streaming(self) -> bool:
        """是否需要流式传输"""
        return False

# 组合钩子类
class CompositeHook(AgentHook):
    """组合多个钩子，按顺序调用"""
    
    def __init__(self, hooks: list[AgentHook]) -> None:
        """初始化并组合多个钩子"""
        super().__init__()
        self.hooks = hooks or []
```

**使用场景**：
- 扩展代理循环的功能而不修改核心代码
- 实现横切关注点（如日志、监控、验证）
- 支持多个独立扩展点的组合

**注意事项**：
- 钩子方法的调用顺序由组合类决定
- 如果钩子抛出异常，会影响整个处理流程
- 使用 `reraise=True` 确保异常正确传播

### 3.5 异步超时处理

**概念说明**：
`asyncio.wait_for()` 函数用于等待异步操作完成，支持超时设置，在超时时抛出 `asyncio.TimeoutError` 异常。

```python
import asyncio

async def process_with_timeout(coro, timeout_seconds: float):
    """带超时的异步操作"""
    try:
        result = await asyncio.wait_for(coro, timeout=timeout_seconds)
        return result
    except asyncio.TimeoutError:
        print(f"操作超时（{timeout_seconds}秒）")
        return None
    except Exception as e:
        print(f"操作异常：{e}")
        raise

# 使用示例
async def main_loop():
    while True:
        try:
            # 尝试获取消息，超时1秒
            msg = await asyncio.wait_for(
                consume_message(),
                timeout=1.0
            )
            if msg:
                await process_message(msg)
        except asyncio.TimeoutError:
            # 超时时检查过期会话
            await cleanup_expired_sessions()
        except Exception as e:
            print(f"循环异常：{e}")
            await asyncio.sleep(1)  # 延迟后重试
```

**使用场景**：
- 限制等待时间，避免无限阻塞
- 优雅处理超时情况
- 在超时时执行清理和恢复逻辑
- 提供重试机制

**注意事项**：
- `asyncio.wait_for()` 会在超时时取消被等待的协程
- 需要正确处理 `asyncio.CancelledError` 异常
- 超时时间应根据实际操作合理设置

### 3.6 任务取消和资源清理

**概念说明**：
异步任务的取消需要正确处理，确保资源被正确释放，避免内存泄漏和资源竞争。

```python
import asyncio
import contextlib
from typing import TYPE_CHECKING

async def graceful_task_cancellation():
    """优雅的任务取消示例"""
    tasks = []
    resources = []
    
    async def worker(task_id: int):
        """可以被取消的工作协程"""
        resource = await acquire_resource()
        resources.append(resource)
        
        try:
            while True:
                # 模拟工作
                await asyncio.sleep(0.1)
                if should_cancel():
                    break
                    
                await cleanup_resource(resource)
        except asyncio.CancelledError:
            print(f"任务 {task_id} 被取消")
        finally:
            # 确保资源被清理
            await cleanup_resource(resource)
    
    async def manager():
        """管理多个工作协程"""
        task_count = 3
        
        # 启动多个任务
        for i in range(task_count):
            task = asyncio.create_task(worker(i))
            tasks.append(task)
        
        # 运行一段时间后取消所有任务
        await asyncio.sleep(2)
        print("取消所有任务...")
        
        # 取消所有任务
        for task in tasks:
            task.cancel()
        
        # 等待所有任务完成
        await asyncio.gather(*tasks, return_exceptions=True)
        print("所有任务已清理完毕")

asyncio.run(manager())
```

**使用场景**：
- 优雅地关闭正在运行的任务
- 清理所有分配的资源
- 正确处理异常情况
- 提供状态监控和错误恢复

**注意事项**：
- 任务取消是协作的，不能强制终止
- 使用 `return_exceptions=True` 避免一个任务失败影响其他任务
- `finally` 块确保无论是否异常都会执行清理

### 3.7 并发控制原语

**概念说明**：
`asyncio.Semaphore` 是并发控制原语，用于限制同时访问共享资源的最大并发数。

```python
import asyncio

class RateLimiter:
    """基于信号量的速率限制器"""
    
    def __init__(self, max_concurrent: int):
        # 初始化信号量，限制最大并发数
        self.semaphore = asyncio.Semaphore(max_concurrent)
        self._active_count = 0
    
    async def __aenter__(self):
        """进入上下文时获取信号量"""
        await self.semaphore.acquire()
        self._active_count += 1
        print(f"当前活动连接数：{self._active_count}")
    
    async def __aexit__(self, exc_type, exc_val, tb):
        """退出上下文时释放信号量"""
        self.semaphore.release()
        self._active_count -= 1
        print(f"连接释放，当前活动数：{self._active_count}")

async def limited_request(url: str, limiter: RateLimiter):
    """使用速率限制器的请求"""
    async with limiter:
        # 在这里进行受并发限制的请求
        result = await fetch_data(url)
        return result

async def main():
    limiter = RateLimiter(max_concurrent=3)
    
    # 模拟多个并发请求
    tasks = [
        limited_request("https://api.example.com/1", limiter),
        limited_request("https://api.example.com/2", limiter),
        limited_request("https://api.example.com/3", limiter),
        limited_request("https://api.example.com/4", limiter),
        limited_request("https://api.example.com/5", limiter),
    ]
    
    # 虽然启动5个任务，但同时只有3个能执行
    results = await asyncio.gather(*tasks)
    print(f"完成 {len(results)} 个请求")
```

**使用场景**：
- 限制对外部 API 的并发请求数
- 保护共享资源（如数据库连接）
- 实现公平的并发调度
- 避免系统过载

**注意事项**：
- 信号量是公平的，按请求顺序分配资源
- 在上下文管理器中使用时效果最好
- 超时时需要注意避免死锁

### 3.8 异步队列操作

**概念说明**：
`asyncio.Queue` 提供了多种队列操作方法，包括同步和异步的获取、等待、任务加入等操作。

```python
import asyncio

async def queue_operations_demo():
    """演示异步队列的各种操作"""
    queue = asyncio.Queue()
    
    # 基本的入队和出队
    await queue.put("message1")
    await queue.put("message2")
    
    # 非阻塞获取
    item1 = await queue.get_nowait()
    print(f"非阻塞获取：{item1}")
    
    # 阻塞获取
    item2 = await queue.get()
    print(f"阻塞获取：{item2}")
    
    # 获取队列大小
    size = queue.qsize()
    print(f"队列大小：{size}")
    
    # 等待队列非空
    await queue.join()
    print("队列已清空")
```

**使用场景**：
- 实现生产者-消费者模式
- 任务调度和缓冲
- 流量控制
- 优雅的关闭和清理

**注意事项**：
- `get()` 会阻塞直到有元素可用
- `get_nowait()` 在队列为空时会引发异常
- `join()` 需要配合 `task_done()` 使用

### 3.9 检查点机制

**概念说明**：
运行时检查点机制通过在消息处理过程中保存关键状态到会话元数据，在任务中断时可以恢复处理进度，避免重复工作或数据丢失。

```python
def _set_runtime_checkpoint(self, session: Session, payload: dict[str, Any]) -> None:
    """将最新的进行中轮次状态持久化到会话元数据中"""
    session.metadata[self._RUNTIME_CHECKPOINT_KEY] = payload
    self.sessions.save(session)

def _restore_runtime_checkpoint(self, session: Session) -> bool:
    """将未完成的轮次具体化为会话历史记录"""
    from datetime import datetime
    
    checkpoint = session.metadata.get(self._RUNTIME_CHECKPOINT_KEY)
    if not isinstance(checkpoint, dict):
        return False
    
    assistant_message = checkpoint.get("assistant_message")
    completed_tool_results = checkpoint.get("completed_tool_results") or []
    pending_tool_calls = checkpoint.get("pending_tool_calls") or []
    
    # 恢复助手消息和已完成的工具结果
    restored_messages: list[dict[str, Any]] = []
    if isinstance(assistant_message, dict):
        restored = dict(assistant_message)
        restored.setdefault("timestamp", datetime.now().isoformat())
        restored_messages.append(restored)
    
    for message in completed_tool_results:
        if isinstance(message, dict):
            restored = dict(message)
            restored.setdefault("timestamp", datetime.now().isoformat())
            restored_messages.append(restored)
    
    # 为待处理的工具调用创建错误消息
    for tool_call in pending_tool_calls:
        if not isinstance(tool_call, dict):
            continue
        tool_id = tool_call.get("id")
        name = ((tool_call.get("function") or {}).get("name")) or "tool"
        restored_messages.append({
            "role": "tool",
            "tool_call_id": tool_id,
            "name": name,
            "content": "Error: Task interrupted before this tool finished.",
            "timestamp": datetime.now().isoformat(),
        })
    
    # 计算重叠部分避免重复
    overlap = 0
    max_overlap = min(len(session.messages), len(restored_messages))
    for size in range(max_overlap, 0, -1):
        existing = session.messages[-size:]
        restored = restored_messages[:size]
        if all(
            self._checkpoint_message_key(left) == self._checkpoint_message_key(right)
            for left, right in zip(existing, restored)
        ):
            overlap = size
            break
    
    # 恢复历史记录并清理检查点
    session.messages.extend(restored_messages[overlap:])
    self._clear_pending_user_turn(session)
    self._clear_runtime_checkpoint(session)
    return True
```

**使用场景**：
- 在长时间运行的工具调用过程中保护处理状态
- 支持任务中断和恢复
- 避免重复执行和资源浪费
- 提供更好的用户体验

**注意事项**：
- 检查点应该包含足够的信息用于恢复
- 定期清理旧的检查点避免内存泄漏
- 在恢复时需要验证数据的完整性

### 3.10 元组解包

**概念说明**：
元组解包允许将元组中的元素直接赋值给对应的变量，提高代码的可读性。

```python
# 元组解包的基本用法
user_id, chat_id, content = parse_message(msg)
# 等价于
user_id = msg.sender_id
chat_id = msg.chat_id
content = msg.content

# 在函数参数中使用解包
async def process_message(msg: InboundMessage):
    # 直接在函数签名中解包
    await handle_message(msg.channel, msg.sender_id, msg.chat_id, msg.content)

# 解包嵌套元组
async def complex_function(data: tuple):
    user_info, metadata, content = data  # 解包三层元组
    await process_user(user_info)
    await process_metadata(metadata)
    await process_content(content)
```

**使用场景**：
- 从数据结构中提取多个字段
- 简化函数调用参数
- 提高代码可读性
- 减少中间变量定义

**注意事项**：
- 元组结构要和解包的变量数量匹配
- 元组中的元素顺序很重要
- 可以使用占位符 `_` 忽略不需要的元素

## 四、实际应用示例

### 4.1 基本代理循环

```python
import asyncio
from nanobot.agent.loop import AgentLoop
from nanobot.bus import MessageBus
from nanobot.providers.base import LLMProvider

async def basic_agent_example():
    """基本的代理循环使用示例"""
    # 创建消息总线和模拟提供商
    bus = MessageBus()
    
    class MockProvider(LLMProvider):
        """模拟的 LLM 提供商"""
        
        async def chat(self, messages, **kwargs):
            # 模拟简单的响应
            return type('MockResponse', {
                'content': 'Hello! This is a simulated response.',
                'tool_calls': [],
                'finish_reason': 'stop',
                'usage': {},
            })
        
        @property
        def generation(self):
            """返回模拟的生成设置"""
            return type('GenerationSettings', max_tokens=4096)
        
        async def chat_stream(self, messages, on_content_delta=None, **kwargs):
            """流式模拟响应"""
            response = await self.chat(messages, **kwargs)
            if on_content_delta and response.content:
                await on_content_delta(response.content)
            return response
        
        def get_default_model(self) -> str:
            return "mock-model"
    
    # 创建代理循环
    from pathlib import Path
    provider = MockProvider()
    
    loop = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=Path.home() / ".nanobot" / "workspace",
        model="mock-model",
        max_iterations=3,
        context_window_tokens=8192,
    )
    
    # 启动代理循环
    async def simulate_messages():
        """模拟接收一些消息"""
        for i in range(5):
            await asyncio.sleep(1)  # 模拟间隔
            
            # 创建入站消息
            from nanobot.bus.events import InboundMessage
            msg = InboundMessage(
                channel="test",
                sender_id="user1",
                chat_id="chat1",
                content=f"这是第{i+1}条测试消息"
            )
            await bus.publish_inbound(msg)
    
    # 启动消息模拟和代理循环
    await asyncio.gather(simulate_messages())

asyncio.run(main())
```

### 4.2 自定义钩子扩展

```python
import asyncio
from nanobot.agent.loop import AgentLoop, AgentHook
from nanobot.bus.events import InboundMessage

class LoggingHook(AgentHook):
    """自定义钩子：记录所有代理循环事件"""
    
    def __init__(self, name: str = "logging"):
        super().__init__()
        self.name = name
        self.events = []
    
    async def before_iteration(self, context):
        """记录迭代开始"""
        self.events.append(f"iteration-{context.iteration}-start")
        print(f"[{self.name}] 迭代 {context.iteration} 开始")
    
    async def before_execute_tools(self, context):
        """记录工具执行开始"""
        self.events.append(f"tools-{context.iteration}-start")
        print(f"[{self.name}] 工具执行：{[tc.name for tc in context.tool_calls]}")
    
    async def after_iteration(self, context):
        """记录迭代结束"""
        self.events.append(f"iteration-{context.iteration}-end")
        print(f"[{self.name}] 迭代 {context.iteration} 结束，使用: {context.usage}")

async def custom_hook_example():
    """演示自定义钩子的使用"""
    # 创建消息总线和模拟提供商
    bus = MessageBus()
    
    class MockProvider(LLMProvider):
        async def chat(self, messages, **kwargs):
            return type('MockResponse', {
                'content': 'Response from AI',
                'tool_calls': [],
                'finish_reason': 'stop',
                'usage': {},
            })
        
        @property
        def generation(self):
            return type('GenerationSettings', max_tokens=4096)
        
        def get_default_model(self) -> str:
            return "mock-model"
    
    # 创建自定义钩子
    logging_hook = LoggingHook(name="custom")
    
    # 创建代理循环并传入自定义钩子
    from pathlib import Path
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=Path.home() / ".nanobot" / "workspace",
        model="mock-model",
        hooks=[logging_hook],  # 传入自定义钩子
    )
    
    # 模拟接收消息
    from nanobot.bus.events import InboundMessage
    for i in range(3):
        msg = InboundMessage(
            channel="test",
            sender_id="user1",
            chat_id="chat1",
            content=f"测试消息 {i+1}"
        )
        await bus.publish_inbound(msg)
    
    # 等待处理完成
    await asyncio.sleep(5)
    print(f"钩子记录的事件：{logging_hook.events}")

asyncio.run(main())
```

### 4.3 错误处理和恢复

```python
import asyncio
import logging
from nanobot.agent.loop import AgentLoop
from nanobot.bus import MessageBus

class ResilientAgent:
    """具有错误恢复能力的代理"""
    
    def __init__(self):
        self.error_count = 0
        self.success_count = 0
    
    async def process_with_retry(self, loop: AgentLoop, message: str):
        """带重试的消息处理"""
        max_retries = 3
        retry_delay = 1.0
        
        for attempt in range(max_retries):
            try:
                from nanobot.bus.events import InboundMessage
                msg = InboundMessage(
                    channel="test",
                    sender_id="user1", 
                    chat_id="chat1",
                    content=message
                )
                
                await loop.process_direct(
                    content=message,
                    session_key="test-session"
                )
                
                print(f"处理成功（尝试 {attempt + 1}/{max_retries}）")
                self.success_count += 1
                return  # 成功则直接返回
                
            except asyncio.CancelledError:
                print("任务被取消")
                raise
                
            except Exception as e:
                print(f"处理失败（尝试 {attempt + 1}/{max_retries}）：{e}")
                self.error_count += 1
                
                if attempt < max_retries - 1:
                    await asyncio.sleep(retry_delay)
                    retry_delay *= 2  # 指数退避
                else:
                    print("达到最大重试次数，放弃")
                    raise

async def main():
    """测试错误恢复机制"""
    from nanobot.agent.loop import AgentLoop
    from nanobot.bus import MessageBus
    from nanobot.providers.base import LLMProvider
    
    bus = MessageBus()
    
    class MockProvider(LLMProvider):
        async def chat(self, messages, **kwargs):
            return type('MockResponse', {
                'content': 'Response',
                'tool_calls': [],
                'finish_reason': 'stop',
                'usage': {},
            })
        
        @property
        def generation(self):
            return type('GenerationSettings', max_tokens=4096)
        
        def get_default_model(self) -> str:
            return "mock-model"
    
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=".",
        model="mock-model",
    )
    
    # 测试错误处理
    await process_with_retry(
        loop, 
        "这是会失败的消息"
    )
    
    print(f"处理完成：成功 {success_count} 次，失败 {error_count} 次")

asyncio.run(main())
```

### 4.4 并发控制和性能优化

```python
import asyncio
import time
from nanobot.agent.loop import AgentLoop
from nanobot.bus import MessageBus
from nanobot.providers.base import LLMProvider

class PerformanceMonitor:
    """性能监控器"""
    
    def __init__(self):
        self.request_count = 0
        self.start_time = time.time()
    
    async def track_request(self, operation: str):
        """跟踪请求"""
        self.request_count += 1
        current_time = time.time()
        
        elapsed = current_time - self.start_time
        if elapsed > 0 and self.request_count % 10 == 0:
            avg_time = elapsed / self.request_count
            print(f"性能报告：已处理 {self.request_count} 个请求，平均耗时 {avg_time:.3f}秒")
        
        if elapsed > 5.0:
            print(f"警告：操作 '{operation}' 耗时 {elapsed:.2f}秒，可能需要优化")

async def concurrent_processing_demo():
    """演示并发处理和性能监控"""
    bus = MessageBus()
    
    class MockProvider(LLMProvider):
        async def chat(self, messages, **kwargs):
            await asyncio.sleep(0.1)  # 模拟处理时间
            return type('MockResponse', {
                'content': 'Processed',
                'tool_calls': [],
                'finish_reason': 'stop',
                'usage': {},
            })
        
        @property
        def generation(self):
            return type('GenerationSettings', max_tokens=4096)
        
        def get_default_model(self) -> str:
            return "mock-model"
    
    monitor = PerformanceMonitor()
    
    async def worker(worker_id: int, loop: AgentLoop):
        """工作协程"""
        print(f"工作协程 {worker_id} 启动")
        
        # 模拟处理一些请求
        for i in range(20):
            from nanobot.bus.events import InboundMessage
            msg = InboundMessage(
                channel="test",
                sender_id="user1",
                chat_id=f"worker-{worker_id}",
                content=f"请求 {i+1} 来自工作协程 {worker_id}"
            )
            
            await monitor.track_request("并发处理")
            await bus.publish_inbound(msg)
            
            # 随机模拟一些慢速请求
            if i % 5 == 0:
                await asyncio.sleep(0.5)  # 模拟处理时间
            
        print(f"工作协程 {worker_id} 完成")

async def main():
    """主函数"""
    from nanobot.agent.loop import AgentLoop
    from nanobot.providers.base import LLMProvider
    
    bus = MessageBus()
    
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=".",
        model="mock-model",
    )
    
    # 启动多个工作协程
    workers = [
        asyncio.create_task(worker(i, loop)) 
        for i in range(4)
    ]
    
    # 启动一个监控协程
    monitor_task = asyncio.create_task(monitor.track_request("系统监控"))
    
    # 并发运行所有工作协程
    print("启动并发处理系统...")
    start_time = time.time()
    
    await asyncio.gather(*workers, monitor_task)
    
    total_time = time.time() - start_time
    print(f"所有工作协程完成，总耗时 {total_time:.2f}秒")

asyncio.run(main())
```

## 五、最佳实践建议

### 5.1 钩子设计最佳实践

```python
class BestPracticeHook(AgentHook):
    """最佳实践钩子示例"""
    
    def __init__(self, name: str = "best-practice"):
        super().__init__()
        self.name = name
    
    async def before_iteration(self, context):
        """在迭代开始前进行前置检查"""
        # 验证必要的前置条件
        if not context.messages:
            raise ValueError("消息列表不能为空")
        
        # 资源准备
        print(f"[{self.name}] 迭代 {context.iteration} 前置检查完成")
    
    async def before_execute_tools(self, context):
        """工具执行前的资源准备"""
        if not context.tool_calls:
            print(f"[{self.name}] 没有工具需要执行，跳过")
            return
        
        print(f"[{self.name}] 准备执行 {len(context.tool_calls)} 个工具")
    
    async def after_iteration(self, context):
        """迭代结束后的资源清理和验证"""
        # 验证执行结果
        if context.stop_reason == "error":
            print(f"[{self.name}] 迭代 {context.iteration} 发生错误，需要检查")
        
        print(f"[{self.name}] 迭代 {context.iteration} 完成，令牌使用：{context.usage}")
    
    def finalize_content(self, context, content):
        """内容最终化和验证"""
        if not content:
            print(f"[{self.name}] 警告：生成的内容为空")
            return "我无法生成响应内容。"
        
        # 内容长度验证
        if len(content) > 10000:
            print(f"[{self.name}] 警告：响应内容过长，可能需要优化")
        
        return content
```

### 5.2 资源管理最佳实践

```python
import asyncio
from contextlib import AsyncExitStack

class ResourceManager:
    """资源管理器最佳实践"""
    
    def __init__(self):
        self.stack = AsyncExitStack()
        self._owned_resources = set()
    
    async def __aenter__(self):
        """资源获取和所有权管理"""
        resource = await self._acquire_resource()
        await self.stack.aclose(resource)
        self._owned_resources.add(id(resource))
        print(f"资源 {id(resource)} 已获取并记录")
        return resource
    
    async def _acquire_resource(self):
        """获取资源的具体实现"""
        await asyncio.sleep(0.1)  # 模拟获取耗时
        return f"resource-{asyncio.get_event_loop().time()}"
    
    async def __aexit__(self, exc_type, exc_val, tb):
        """资源释放和所有权清理"""
        # 清理栈中的所有资源
        while self.stack._exit_callbacks:
            resource = await self.stack.aclose()
            resource_id = id(resource)
            if resource_id in self._owned_resources:
                self._owned_resources.remove(resource_id)
                print(f"资源 {resource_id} 已释放")
```

### 5.3 性能优化和监控

```python
import asyncio
import time
from typing import Callable

class MetricsCollector:
    """性能指标收集器"""
    
    def __init__(self):
        self.metrics = {
            'total_requests': 0,
            'successful_requests': 0,
            'failed_requests': 0,
            'avg_response_time': 0.0,
            'max_response_time': 0.0,
            'min_response_time': 0.0,
            'active_connections': 0,
        }
    
    async def record_request(self, success: bool, duration: float):
        """记录请求指标"""
        self.metrics['total_requests'] += 1
        
        if success:
            self.metrics['successful_requests'] += 1
        else:
            self.metrics['failed_requests'] += 1
        
        # 更新响应时间统计
        if duration > 0:
            total = self.metrics['total_requests']
            current_avg = self.metrics['avg_response_time']
            
            # 计算新的平均值
            new_avg = current_avg + (duration - current_avg) / total
            self.metrics['avg_response_time'] = new_avg
            
            # 更新最大最小值
            self.metrics['max_response_time'] = max(self.metrics['max_response_time'], duration)
            self.metrics['min_response_time'] = min(self.metrics['min_response_time'], duration) if duration > 0 else duration
        
    def get_metrics(self) -> dict:
        """获取当前性能指标"""
        return self.metrics.copy()
    
    def reset_metrics(self):
        """重置性能指标"""
        self.metrics = {
            'total_requests': 0,
            'successful_requests': 0,
            'failed_requests': 0,
            'avg_response_time': 0.0,
            'max_response_time': 0.0,
            'min_response_time': 0.0,
            'active_connections': 0,
        }
        
        print(f"性能指标已重置")

async def performance_monitoring():
    """性能监控示例"""
    collector = MetricsCollector()
    
    async def monitored_operation(collector, operation_name: str):
        """受监控的操作"""
        start_time = time.time()
        
        # 模拟操作执行
        await asyncio.sleep(0.05)  # 模拟50ms处理时间
        
        # 模拟成功率
        success = (hash(operation_name) % 3 != 0)  # 简单的成功率模拟
        
        duration = time.time() - start_time
        await collector.record_request(success, duration)
        
        if success:
            print(f"{operation_name} 成功，耗时 {duration*1000:.1f}ms")
        else:
            print(f"{operation_name} 失败，耗时 {duration*1000:.1f}ms")

async def main():
    """主监控循环"""
    operations = [
        "LLM请求", "工具执行", "内存整合", 
        "会话管理", "文件操作", "网络请求"
    ]
    
    # 模拟连续监控
    for i in range(10):
        for op in operations:
            await monitored_operation(collector, f"{op}_{i}")
        
        # 每5个操作输出一次指标
        if i % 5 == 4:
            metrics = collector.get_metrics()
            print(f"\n=== 性能报告 (第 {i//5 + 1} 轮) ===")
            print(f"总请求数：{metrics['total_requests']}")
            print(f"成功率：{metrics['successful_requests']/metrics['total_requests']*100:.1f}%")
            print(f"平均响应时间：{metrics['avg_response_time']*1000:.1f}ms")
            print(f"最大响应时间：{metrics['max_response_time']*1000:.1f}ms")
            print(f"最小响应时间：{metrics['min_response_time']*1000:.1f}ms")

asyncio.run(main())
```

### 5.4 测试策略

```python
import pytest
import asyncio
from nanobot.agent.loop import AgentLoop
from nanobot.bus import MessageBus
from nanobot.providers.base import LLMProvider

class MockProvider(LLMProvider):
    """模拟的 LLM 提供商"""
    
    async def chat(self, messages, **kwargs):
        return type('MockResponse', {
            'content': 'Test response',
            'tool_calls': [],
            'finish_reason': 'stop',
            'usage': {},
        })
    
    @property
    def generation(self):
        return type('GenerationSettings', max_tokens=4096)
    
    def get_default_model(self) -> str:
            return "mock-model"

@pytest.mark.asyncio
async def test_basic_message_flow():
    """测试基本消息流"""
    bus = MessageBus()
    
    # 创建代理循环
    from pathlib import Path
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=Path.home() / ".test-workspace",
        model="mock-model",
    )
    
    # 测试消息处理
    from nanobot.bus.events import InboundMessage
    msg = InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content="test message"
    )
    
    await bus.publish_inbound(msg)
    
    # 给一些时间处理
    await asyncio.sleep(0.1)
    
    # 验证消息被正确处理
    # 注意：实际测试中需要验证具体的行为

@pytest.mark.asyncio
async def test_concurrent_sessions():
    """测试并发会话处理"""
    bus = MessageBus()
    
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=".",
        model="mock-model",
    )
    
    # 创建多个会话的消息
    from nanobot.bus.events import InboundMessage
    messages = [
        InboundMessage(
            channel="test",
            sender_id="user1",
            chat_id="chat1",
            content=f"session {i} message {j+1}"
        )
        for i in range(3)
        for j in range(2)
    ]
    
    # 发布所有消息
    for msg in messages:
        await bus.publish_inbound(msg)
    
    # 等待处理完成
    await asyncio.sleep(0.5)
    
    # 验证会话处理完成

@pytest.mark.asyncio
async def test_error_recovery():
    """测试错误恢复机制"""
    bus = MessageBus()
    
    loop = AgentLoop(
        bus=bus,
        provider=MockProvider(),
        workspace=".",
        model="mock-model",
    )
    
    # 测试检查点恢复
    from nanobot.bus.events import InboundMessage
    
    # 模拟一个会话消息
    msg1 = InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content="first message"
    )
    
    await bus.publish_inbound(msg1)
    await asyncio.sleep(0.2)  # 模拟处理开始
    
    # 触发中断（模拟 /stop）
    loop.stop()
    
    # 等待中断完成
    await asyncio.sleep(0.1)
    
    # 验证检查点恢复
    # 模拟中断后重新发送消息
    msg2 = InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content="second message after interrupt"
    )
    
    await bus.publish_inbound(msg2)
    await asyncio.sleep(0.3)
    
    # 验证恢复逻辑是否正常工作
```

Nanobot Loop 模块通过精心设计的异步架构、完善的钩子机制和强大的并发控制，实现了一个高性能、高可靠性的 AI 代理核心处理引擎。其代码质量和架构设计为构建复杂的 AI 系统提供了优秀的参考实现。
