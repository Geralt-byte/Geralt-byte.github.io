---
layout: post-wide
title:  "02 Nanobot Bus模块解析"
date:   2026-05-10 20:00:00 +0800
categories: [nanobot]
---

## 一、Bus 模块整体架构

Nanobot 的 bus 模块实现了消息总线架构，用于聊天频道与代理核心之间的解耦通信。整体架构如下：

```
nanobot/bus/
├── __init__.py      # 模块入口，导出公共API
├── events.py        # 事件类型定义（入站/出站消息）
└── queue.py         # 异步消息队列实现
```

### 架构设计理念

1. **关注点分离**：频道处理通信细节，代理处理业务逻辑
2. **异步优先**：基于 Python asyncio 的高效异步消息传递
3. **类型安全**：使用类型注解确保消息类型正确性
4. **双向通信**：支持入站和出站两个方向的消息流

### 核心设计模式

- **观察者模式**：MessageBus 作为主题，频道和代理作为观察者
- **生产者-消费者模式**：通过队列解耦消息的生产和消费
- **中介者模式**：MessageBus 作为中介者减少组件间直接依赖

## 二、各文件功能详解

### 2.1 `__init__.py` - 模块接口

**文件作用**：定义模块的公共 API，统一导出接口

**导出内容**：
- `MessageBus`：异步消息总线类
- `InboundMessage`：入站消息数据类
- `OutboundMessage`：出站消息数据类

**设计优势**：
- 隐藏内部实现细节
- 提供简洁的导入接口
- 便于维护和重构

### 2.2 `events.py` - 事件类型定义

**文件作用**：定义消息总线中使用的所有数据结构

#### InboundMessage 类

```python
@dataclass
class InboundMessage:
    """Message received from a chat channel."""
    channel: str                      # 频道标识符
    sender_id: str                   # 发送者唯一标识
    chat_id: str                     # 聊天/频道标识符
    content: str                     # 消息文本内容
    timestamp: datetime = field(default_factory=datetime.now)
    media: list[str] = field(default_factory=list)     # 媒体URL列表
    metadata: dict[str, Any] = field(default_factory=dict)  # 频道元数据
    session_key_override: str | None = None              # 会话键覆盖
```

#### OutboundMessage 类

```python
@dataclass
class OutboundMessage:
    """Message to send to a chat channel."""
    channel: str                     # 目标频道标识符
    chat_id: str                     # 目标聊天标识符
    content: str                     # 消息内容
    reply_to: str | None = None      # 回复的消息ID
    media: list[str] = field(default_factory=list)     # 附件媒体
    metadata: dict[str, Any] = field(default_factory=dict)  # 元数据
    buttons: list[list[str]] = field(default_factory=list)  # 交互按钮
```

### 2.3 `queue.py` - 消息队列实现

**文件作用**：实现异步消息队列，提供消息发布和消费功能

#### MessageBus 类核心功能

```python
class MessageBus:
    """Async message bus that decouples chat channels from the agent core."""
    
    def __init__(self):
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
```

**主要方法**：
- `publish_inbound()`：发布入站消息
- `consume_inbound()`：消费入站消息
- `publish_outbound()`：发布出站消息
- `consume_outbound()`：消费出站消息
- `inbound_size`：入站队列大小
- `outbound_size`：出站队列大小

## 三、语法知识点总结

### 3.1 数据类（Data Classes）

**概念说明**：
Python 3.7+ 引入的装饰器，用于简化类的定义，自动生成 `__init__()`、`__repr__()` 等方法。

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

@dataclass
class InboundMessage:
    """使用 @dataclass 装饰器定义数据类"""
    channel: str                      # 必需字段
    sender_id: str                   # 必需字段
    chat_id: str                     # 必需字段
    content: str                     # 必需字段
    
    # 带默认值的字段
    timestamp: datetime = field(default_factory=datetime.now)
    
    # 可变默认值必须使用 field(default_factory=...)
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    # 可选字段
    session_key_override: str | None = None
```

**使用场景**：
- 数据容器类，主要用于存储数据而非复杂逻辑
- 需要自动生成初始化方法的场景
- 值对象（Value Object）模式

**注意事项**：
- 可变对象（如列表、字典）作为默认值时，必须使用 `field(default_factory=...)`
- 数据类默认是可变的，如需不可变可添加 `frozen=True` 参数

### 3.2 类型注解（Type Hints）

**概念说明**：
Python 3.5+ 引入的类型系统，用于标注变量、函数参数和返回值的类型，提高代码可读性和工具支持。

```python
# 基本类型注解
channel: str  # 字符串类型
timestamp: datetime  # datetime 对象类型

# 联合类型（Python 3.10+ 的 | 语法）
session_key_override: str | None  # 可以是字符串或 None

# 集合类型注解
media: list[str]  # 字符串列表
metadata: dict[str, Any]  # 键为字符串，值为任意类型的字典
buttons: list[list[str]]  # 二维字符串列表

# 泛型类型注解
self.inbound: asyncio.Queue[InboundMessage]  # 存储入站消息的队列
```

**使用场景**：
- 函数参数和返回值类型标注
- 类属性类型声明
- 提高代码可读性和 IDE 智能提示

**注意事项**：
- 类型注解在运行时不会强制类型检查
- 需要配合类型检查工具（如 mypy）进行静态类型检查
- Python 3.10+ 支持 `|` 语法，早期版本需要使用 `Union`

### 3.3 field() 函数

**概念说明**：
`dataclasses.field()` 函数用于自定义数据类字段的行为，支持设置默认值工厂、验证规则等。

```python
from dataclasses import dataclass, field

@dataclass
class Example:
    # 基本默认值
    name: str = "default"
    
    # 使用 default_factory 处理可变默认值
    items: list[str] = field(default_factory=list)
    data: dict[str, int] = field(default_factory=dict)
    
    # 自定义工厂函数
    def create_timestamp():
        from datetime import datetime
        return datetime.now()
    
    timestamp: datetime = field(default_factory=create_timestamp)
    
    # 使用 lambda 表达式
    tags: list[str] = field(default_factory=lambda: ["default"])
```

**使用场景**：
- 处理可变对象的默认值
- 需要复杂默认值逻辑的场景
- 控制字段的序列化行为

**注意事项**：
- 列表、字典等可变对象必须使用 `default_factory`
- `default` 参数用于不可变对象的默认值
- `default_factory` 接受一个可调用对象

### 3.4 属性装饰器（@property）

**概念说明**：
将方法转换为属性访问，提供计算属性和只读属性的功能。

```python
@dataclass
class InboundMessage:
    channel: str
    chat_id: str
    session_key_override: str | None = None
    
    @property
    def session_key(self) -> str:
        """将方法转换为属性访问"""
        # 优先使用覆盖值，否则生成默认键
        return self.session_key_override or f"{self.channel}:{self.chat_id}"

# 使用方式
msg = InboundMessage(channel="telegram", chat_id="12345")
# 像访问属性一样调用方法（不需要括号）
key = msg.session_key  # 返回 "telegram:12345"
```

**使用场景**：
- 需要计算的属性
- 提供只读访问接口
- 延迟计算（只在访问时才计算）

**注意事项**：
- `@property` 创建的是只读属性
- 如需设置器，可以使用 `@property_name.setter`
- 属性方法不应该有参数（除了 self）

### 3.5 异步编程基础

**概念说明**：
Python 的 `asyncio` 库提供异步 I/O 支持，通过协程、事件循环和Future对象实现并发编程。

```python
import asyncio

class MessageBus:
    def __init__(self):
        # 创建异步队列
        self.inbound: asyncio.Queue[InboundMessage] = asyncio.Queue()
        self.outbound: asyncio.Queue[OutboundMessage] = asyncio.Queue()
    
    # 异步方法：使用 async def 定义
    async def publish_inbound(self, msg: InboundMessage) -> None:
        """异步发布消息，不会阻塞调用者"""
        await self.inbound.put(msg)  # await 关键字等待异步操作完成
    
    async def consume_inbound(self) -> InboundMessage:
        """异步消费消息，会阻塞直到有消息可用"""
        return await self.inbound.get()
    
    @property
    def inbound_size(self) -> int:
        """同步属性，不需要 async"""
        return self.inbound.qsize()
```

**使用场景**：
- I/O 密集型操作（网络请求、文件读写）
- 需要并发处理多个任务
- 避免阻塞主线程的场景

**注意事项**：
- `async def` 定义协程函数，调用后返回协程对象
- `await` 只能在异步函数中使用
- 混合使用同步和异步代码需要小心

### 3.6 异步队列（asyncio.Queue）

**概念说明**：
`asyncio.Queue` 是线程安全的异步队列，专为协程间通信设计。

```python
import asyncio
from dataclasses import dataclass

@dataclass
class Message:
    content: str

async def producer(queue: asyncio.Queue):
    """生产者：向队列发送消息"""
    for i in range(5):
        msg = Message(content=f"Message {i}")
        await queue.put(msg)  # 异步放入队列
        print(f"Produced: {msg.content}")
        await asyncio.sleep(0.1)  # 模拟异步操作

async def consumer(queue: asyncio.Queue):
    """消费者：从队列获取消息"""
    while True:
        msg = await queue.get()  # 异步获取消息，阻塞直到有消息
        print(f"Consumed: {msg.content}")
        queue.task_done()  # 标记任务完成

async def main():
    queue = asyncio.Queue()
    
    # 并发运行生产者和消费者
    await asyncio.gather(
        producer(queue),
        consumer(queue)
    )

asyncio.run(main())
```

**使用场景**：
- 协程间通信
- 生产者-消费者模式
- 任务调度和缓冲

**注意事项**：
- `asyncio.Queue` 是协程安全的，不是线程安全的
- `queue.get()` 会阻塞直到有消息可用
- 使用 `queue.task_done()` 和 `queue.join()` 等待所有任务完成

### 3.7 类型别名和联合类型

**概念说明**：
类型别名提高代码可读性，联合类型表示可以是多种类型之一。

```python
from typing import Any

# 联合类型：使用 | 语法（Python 3.10+）
session_key_override: str | None  # 可以是字符串或 None

# 早期版本的写法
from typing import Optional
session_key_override: Optional[str]  # 等同于 str | None

# 复杂的联合类型
def process_data(data: str | int | list[str]) -> str:
    """参数可以是字符串、整数或字符串列表"""
    if isinstance(data, str):
        return data.upper()
    elif isinstance(data, int):
        return str(data)
    else:
        return ",".join(data)

# Any 类型：表示任意类型
metadata: dict[str, Any]  # 值可以是任意类型
```

**使用场景**：
- 函数可能接受多种类型的参数
- 可选参数（使用 `| None`）
- 需要类型别名的复杂类型

**注意事项**：
- 过度使用 `Any` 会失去类型检查的优势
- 联合类型应该使用 `isinstance()` 进行类型检查
- Python 3.10+ 推荐使用 `|` 语法

### 3.8 字典和列表的类型注解

**概念说明**：
为字典和列表添加类型注解，指定键值对或元素的具体类型。

```python
from typing import Any

# 列表类型注解
media: list[str] = []  # 字符串列表
buttons: list[list[str]] = []  # 二维字符串列表

# 字典类型注解
metadata: dict[str, Any] = {}  # 键为字符串，值为任意类型

# 更复杂的字典类型
from typing import Dict, List
config: Dict[str, List[str]] = {
    "channels": ["telegram", "discord"],
    "features": ["streaming", "media"]
}

# 嵌套类型注解
complex_data: dict[str, list[dict[str, str | int]]] = {
    "users": [
        {"name": "Alice", "age": 30},
        {"name": "Bob", "age": 25}
    ]
}
```

**使用场景**：
- 数据结构明确的场景
- 需要类型检查的复杂数据结构
- API 接口定义

**注意事项**：
- 过于复杂的类型注解可能降低可读性
- 运行时不会强制类型检查
- 可以使用 `TypedDict` 进一步约束字典结构

### 3.9 默认参数和默认值工厂

**概念说明**：
函数参数可以设置默认值，对于可变对象需要使用工厂函数。

```python
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

@dataclass
class Message:
    content: str
    
    # 不可变对象的默认值
    priority: int = 1
    
    # 可变对象必须使用 default_factory
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    
    # 使用 datetime.now() 作为默认值
    created_at: datetime = field(default_factory=datetime.now)
    
    # 自定义工厂函数
    @staticmethod
    def create_default_headers():
        return {"Content-Type": "application/json"}
    
    headers: dict[str, str] = field(default_factory=create_default_headers)

# 错误示例：所有实例共享同一个列表
@dataclass
class BadMessage:
    tags: list[str] = []  # ❌ 错误！所有实例共享同一个列表

# 正确示例：每个实例都有独立的列表
@dataclass  
class GoodMessage:
    tags: list[str] = field(default_factory=list)  # ✅ 正确
```

**使用场景**：
- 为参数提供合理的默认值
- 处理可变对象的默认值
- 延迟创建默认值

**注意事项**：
- 可变对象（列表、字典、集合）必须使用 `default_factory`
- `default_factory` 接受一个无参数的可调用对象
- 默认值在类定义时创建，工厂函数在实例创建时调用

### 3.10 模块导入和导出

**概念说明**：
Python 的模块系统支持选择性导入和导出，控制模块的公共接口。

```python
# __init__.py 文件
from nanobot.bus.events import InboundMessage, OutboundMessage
from nanobot.bus.queue import MessageBus

# 定义模块的公共接口
__all__ = ["MessageBus", "InboundMessage", "OutboundMessage"]

# 使用方式
# from nanobot.bus import MessageBus, InboundMessage, OutboundMessage
```

**使用场景**：
- 控制模块的公共 API
- 简化导入语句
- 隐藏内部实现细节

**注意事项**：
- `__all__` 只影响 `from module import *` 的行为
- 显式导入不受 `__all__` 限制
- 合理使用可以避免循环导入

## 四、实际应用示例

### 4.1 基本消息传递

```python
import asyncio
from nanobot.bus import MessageBus, InboundMessage, OutboundMessage

async def basic_message_flow():
    """演示基本的消息传递流程"""
    bus = MessageBus()
    
    # 创建入站消息
    inbound_msg = InboundMessage(
        channel="telegram",
        sender_id="user123",
        chat_id="chat456",
        content="Hello, nanobot!"
    )
    
    # 发布消息
    await bus.publish_inbound(inbound_msg)
    print(f"Inbound queue size: {bus.inbound_size}")
    
    # 消费消息
    received_msg = await bus.consume_inbound()
    print(f"Received: {received_msg.content}")
    
    # 创建出站消息
    outbound_msg = OutboundMessage(
        channel=received_msg.channel,
        chat_id=received_msg.chat_id,
        content=f"Echo: {received_msg.content}"
    )
    
    # 发布响应
    await bus.publish_outbound(outbound_msg)
    
    # 消费响应
    response = await bus.consume_outbound()
    print(f"Response: {response.content}")

asyncio.run(basic_message_flow())
```

### 4.2 多生产者多消费者模式

```python
import asyncio
import random
from nanobot.bus import MessageBus, InboundMessage, OutboundMessage

async def channel_producer(bus: MessageBus, channel_name: str, message_count: int):
    """模拟多个频道同时发送消息"""
    for i in range(message_count):
        msg = InboundMessage(
            channel=channel_name,
            sender_id=f"user_{random.randint(1000, 9999)}",
            chat_id=f"chat_{random.randint(100, 999)}",
            content=f"Message {i+1} from {channel_name}"
        )
        await bus.publish_inbound(msg)
        await asyncio.sleep(random.uniform(0.1, 0.5))  # 随机延迟

async def agent_worker(bus: MessageBus, worker_id: int):
    """模拟多个代理工作协程并发处理消息"""
    while True:
        msg = await bus.consume_inbound()
        print(f"Worker {worker_id} processing: {msg.content}")
        
        # 模拟处理时间
        await asyncio.sleep(random.uniform(0.2, 0.8))
        
        # 生成响应
        response = OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f"Processed by worker {worker_id}: {msg.content}"
        )
        await bus.publish_outbound(response)

async def channel_consumer(bus: MessageBus):
    """模拟频道消费响应"""
    while True:
        response = await bus.consume_outbound()
        print(f"Sending response: {response.content}")

async def multi_producer_consumer():
    """多生产者多消费者示例"""
    bus = MessageBus()
    
    # 创建多个生产者
    producers = [
        channel_producer(bus, "telegram", 5),
        channel_producer(bus, "discord", 5),
        channel_producer(bus, "slack", 5)
    ]
    
    # 创建多个消费者
    workers = [
        agent_worker(bus, i) for i in range(3)
    ]
    
    # 创建响应消费者
    consumer = channel_consumer(bus)
    
    # 并发运行所有任务
    await asyncio.gather(*producers, *workers, consumer)

# asyncio.run(multi_producer_consumer())
```

### 4.3 带超时的消息处理

```python
import asyncio
from nanobot.bus import MessageBus, InboundMessage

async def message_with_timeout():
    """演示带超时的消息处理"""
    bus = MessageBus()
    
    try:
        # 尝试在1秒内获取消息，超时则抛出异常
        msg = await asyncio.wait_for(
            bus.consume_inbound(),
            timeout=1.0
        )
        print(f"Received message: {msg.content}")
    except asyncio.TimeoutError:
        print("No message received within timeout")
    
    # 发布消息后再尝试
    await bus.publish_inbound(InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content="Test message"
    ))
    
    try:
        msg = await asyncio.wait_for(
            bus.consume_inbound(),
            timeout=1.0
        )
        print(f"Received: {msg.content}")
    except asyncio.TimeoutError:
        print("Timeout again")

asyncio.run(message_with_timeout())
```

### 4.4 队列监控和负载均衡

```python
import asyncio
from nanobot.bus import MessageBus, InboundMessage, OutboundMessage

async def queue_monitor(bus: MessageBus, interval: float = 1.0):
    """监控队列状态"""
    while True:
        print(f"Queue status - Inbound: {bus.inbound_size}, Outbound: {bus.outbound_size}")
        
        # 负载均衡逻辑
        if bus.inbound_size > 10:
            print("Warning: High inbound queue size, consider scaling up workers")
        if bus.outbound_size > 10:
            print("Warning: High outbound queue size, check channel connectivity")
        
        await asyncio.sleep(interval)

async def load_balanced_worker(bus: MessageBus, worker_id: int):
    """根据队列负载调整行为的消费者"""
    while True:
        # 检查队列负载
        if bus.inbound_size > 5:
            # 高负载时快速处理
            processing_time = 0.1
        else:
            # 低负载时正常处理
            processing_time = 0.5
        
        msg = await bus.consume_inbound()
        print(f"Worker {worker_id} (load: {bus.inbound_size}): {msg.content}")
        
        await asyncio.sleep(processing_time)
        
        response = OutboundMessage(
            channel=msg.channel,
            chat_id=msg.chat_id,
            content=f"Processed in {processing_time}s"
        )
        await bus.publish_outbound(response)

async def monitored_system():
    """带监控的消息系统"""
    bus = MessageBus()
    
    # 启动监控
    monitor = queue_monitor(bus)
    
    # 启动自适应工作器
    workers = [load_balanced_worker(bus, i) for i in range(2)]
    
    # 模拟消息生产
    async def produce_messages():
        for i in range(20):
            await bus.publish_inbound(InboundMessage(
                channel="test",
                sender_id="user1",
                chat_id="chat1",
                content=f"Message {i+1}"
            ))
            await asyncio.sleep(0.2)
    
    await asyncio.gather(monitor, *workers, produce_messages())

# asyncio.run(monitored_system())
```

### 4.5 优雅关闭和错误处理

```python
import asyncio
from nanobot.bus import MessageBus, InboundMessage, OutboundMessage

class GracefulShutdown:
    """优雅关闭管理器"""
    
    def __init__(self):
        self.shutdown = False
        self.bus = MessageBus()
    
    async def producer(self):
        """可被中断的生产者"""
        while not self.shutdown:
            try:
                msg = InboundMessage(
                    channel="test",
                    sender_id="user1", 
                    chat_id="chat1",
                    content=f"Message at {asyncio.get_event_loop().time()}"
                )
                await self.bus.publish_inbound(msg)
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                print("Producer cancelled, cleaning up...")
                break
    
    async def consumer(self, worker_id: int):
        """可被中断的消费者"""
        while not self.shutdown:
            try:
                msg = await asyncio.wait_for(
                    self.bus.consume_inbound(),
                    timeout=1.0
                )
                print(f"Worker {worker_id}: {msg.content}")
                
                response = OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"Processed by worker {worker_id}"
                )
                await self.bus.publish_outbound(response)
                
            except asyncio.TimeoutError:
                continue  # 正常超时，继续循环
            except asyncio.CancelledError:
                print(f"Worker {worker_id} cancelled")
                break
    
    async def shutdown_handler(self):
        """关闭处理器"""
        print("Initiating graceful shutdown...")
        self.shutdown = True
        
        # 等待队列清空
        print(f"Waiting for queues to clear... Inbound: {self.bus.inbound_size}, Outbound: {self.bus.outbound_size}")
        
        # 给一些时间让正在处理的消息完成
        await asyncio.sleep(2)
        
        print(f"Final queue status - Inbound: {self.bus.inbound_size}, Outbound: {self.bus.outbound_size}")
        print("Shutdown complete")

async def graceful_shutdown_example():
    """优雅关闭示例"""
    manager = GracefulShutdown()
    
    # 启动生产者和消费者
    producer_task = asyncio.create_task(manager.producer())
    consumer_tasks = [
        asyncio.create_task(manager.consumer(i)) 
        for i in range(2)
    ]
    
    # 运行一段时间后触发关闭
    await asyncio.sleep(3)
    await manager.shutdown_handler()
    
    # 取消所有任务
    producer_task.cancel()
    for task in consumer_tasks:
        task.cancel()
    
    # 等待任务清理
    await asyncio.gather(producer_task, *consumer_tasks, return_exceptions=True)

asyncio.run(graceful_shutdown_example())
```

## 五、最佳实践建议

### 5.1 错误处理

```python
async def safe_consumer(bus: MessageBus):
    """带有完善错误处理的消费者"""
    while True:
        try:
            msg = await bus.consume_inbound()
            
            # 处理消息
            try:
                response = process_message(msg)
                await bus.publish_outbound(response)
            except Exception as e:
                print(f"Error processing message: {e}")
                # 发送错误响应
                error_response = OutboundMessage(
                    channel=msg.channel,
                    chat_id=msg.chat_id,
                    content=f"Error: {str(e)}"
                )
                await bus.publish_outbound(error_response)
                
        except asyncio.CancelledError:
            print("Consumer cancelled gracefully")
            break
        except Exception as e:
            print(f"Unexpected error in consumer: {e}")
            await asyncio.sleep(1)  # 避免错误循环
```

### 5.2 性能优化

```python
import asyncio
from typing import Callable

async def batch_consumer(
    bus: MessageBus, 
    batch_size: int = 10,
    timeout: float = 1.0,
    handler: Callable = None
):
    """批量处理消息以提高性能"""
    batch = []
    
    while True:
        try:
            # 收集批量消息
            msg = await asyncio.wait_for(
                bus.consume_inbound(),
                timeout=timeout
            )
            batch.append(msg)
            
            # 达到批量大小时处理
            if len(batch) >= batch_size:
                if handler:
                    await handler(batch)
                batch = []
                
        except asyncio.TimeoutError:
            # 超时后处理剩余消息
            if batch and handler:
                await handler(batch)
                batch = []
        except asyncio.CancelledError:
            # 清理剩余消息
            if batch and handler:
                await handler(batch)
            break
```

### 5.3 测试策略

```python
import pytest
from nanobot.bus import MessageBus, InboundMessage, OutboundMessage

@pytest.mark.asyncio
async def test_message_flow():
    """测试基本消息流"""
    bus = MessageBus()
    
    # 测试发布和消费
    msg = InboundMessage(
        channel="test",
        sender_id="user1",
        chat_id="chat1",
        content="test message"
    )
    
    await bus.publish_inbound(msg)
    assert bus.inbound_size == 1
    
    received = await bus.consume_inbound()
    assert received.content == "test message"
    assert bus.inbound_size == 0

@pytest.mark.asyncio
async def test_concurrent_access():
    """测试并发访问"""
    bus = MessageBus()
    
    async def producer():
        for i in range(100):
            await bus.publish_inbound(InboundMessage(
                channel="test", sender_id="user1", chat_id="chat1", content=f"msg{i}"
            ))
    
    async def consumer():
        count = 0
        while count < 100:
            await bus.consume_inbound()
            count += 1
    
    await asyncio.gather(producer(), consumer())
    assert bus.inbound_size == 0
```

Nanobot Bus 模块通过简洁的设计实现了强大的异步消息传递功能，是构建可扩展 AI 代理系统的重要基础设施。其清晰的接口设计和完善的类型系统使得开发者可以轻松集成新的频道和代理组件。
