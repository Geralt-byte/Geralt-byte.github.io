---
layout: post-wide
title:  "05 Nanobot ContextBuilder解析"
date:   2026-05-14 20:00:00 +0800
categories: [nanobot]
---

## 模块整体架构

Nanobot ContextBuilder 模块是一个专门用于构建大型语言模型（LLM）代理上下文的核心组件。该模块负责组装完整的系统提示词和消息列表，整合了身份信息、引导文件、记忆存储、技能系统、历史记录等多种上下文元素。

### 架构设计理念

ContextBuilder 采用**分层构建**的设计理念，将复杂的上下文构建过程分解为多个独立的层次：

1. **身份层**：定义代理的基本身份和行为规范
2. **引导层**：加载自定义的配置和指导文件
3. **记忆层**：整合长期记忆和短期历史
4. **技能层**：管理可用的技能和能力
5. **运行时层**：注入动态的运行时元数据

这种分层设计的优势在于：
- **关注点分离**：每个层次负责特定的信息源
- **可扩展性**：新的上下文元素可以轻松添加到相应层次
- **可维护性**：修改某个层次的实现不会影响其他层次
- **灵活性**：可以根据需要启用或禁用特定的上下文元素

### 模块组织结构

ContextBuilder 模块是一个独立的单文件模块，包含以下核心组件：

- **主构建器类**：`ContextBuilder` 类，负责整体上下文构建
- **常量定义**：引导文件列表、配置参数、标签定义
- **静态方法**：工具方法和辅助函数
- **实例方法**：需要访问实例状态的上下文构建方法

### 各组件关系

ContextBuilder 模块与nanobot生态系统中的其他模块有明确的依赖关系：

```
ContextBuilder
    ├── MemoryStore (记忆管理)
    ├── SkillsLoader (技能加载)
    ├── 模板系统 (prompt_templates)
    ├── 工具函数 (utils.helpers)
    └── 平台信息 (platform)
```

这种依赖关系体现了模块间的**单向依赖原则**，确保了架构的清晰性和可测试性。

## 各文件功能详解

### ContextBuilder 类

ContextBuilder 是模块的核心类，提供了完整的上下文构建功能。

#### 核心类属性

```python
class ContextBuilder:
    """构建代理上下文的构建器"""
    
    # 引导文件列表
    BOOTSTRAP_FILES = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"]
    
    # 运行时上下文标签
    _RUNTIME_CONTEXT_TAG = "[Runtime Context — metadata only, not instructions]"
    _RUNTIME_CONTEXT_END = "[/Runtime Context]"
    
    # 历史记录限制
    _MAX_RECENT_HISTORY = 50
    _MAX_HISTORY_CHARS = 32_000
```

这些属性定义了上下文构建的关键配置参数，体现了**配置外部化**的设计思想。

#### 主要方法列表

| 方法名 | 类型 | 功能描述 |
|--------|------|----------|
| `__init__` | 构造函数 | 初始化工作区、时区和技能加载器 |
| `build_system_prompt` | 实例方法 | 构建完整的系统提示词 |
| `build_messages` | 实例方法 | 构建完整的消息列表 |
| `_get_identity` | 实例方法 | 获取身份信息部分 |
| `_load_bootstrap_files` | 实例方法 | 加载引导文件内容 |
| `_build_runtime_context` | 静态方法 | 构建运行时元数据块 |
| `_build_user_content` | 实例方法 | 构建用户消息内容（支持图片） |
| `_merge_message_content` | 静态方法 | 合并消息内容 |
| `_is_template_content` | 静态方法 | 检查内容是否为模板 |
| `add_tool_result` | 实例方法 | 添加工具执行结果 |
| `add_assistant_message` | 实例方法 | 添加助手消息 |

### 核心功能实现描述

#### 1. 系统提示词构建

`build_system_prompt` 方法实现了复杂的系统提示词构建逻辑：

```python
def build_system_prompt(
    self,
    skill_names: list[str] | None = None,
    channel: str | None = None,
) -> str:
    """从身份、引导文件、记忆和技能构建系统提示词"""
    parts = [self._get_identity(channel=channel)]  # 身份部分
    
    bootstrap = self._load_bootstrap_files()  # 引导文件
    if bootstrap:
        parts.append(bootstrap)
    
    memory = self.memory.get_memory_context()  # 记忆部分
    if memory and not self._is_template_content(
        self.memory.read_memory(), "memory/MEMORY.md"
    ):
        parts.append(f"# Memory\n\n{memory}")
    
    always_skills = self.skills.get_always_skills()  # 常用技能
    if always_skills:
        always_content = self.skills.load_skills_for_context(always_skills)
        if always_content:
            parts.append(f"# Active Skills\n\n{always_content}")
    
    skills_summary = self.skills.build_skills_summary(exclude=set(always_skills))  # 技能摘要
    if skills_summary:
        parts.append(render_template("agent/skills_section.md", skills_summary=skills_summary))
    
    entries = self.memory.read_unprocessed_history(  # 历史记录
        since_cursor=self.memory.get_last_dream_cursor()
    )
    if entries:
        capped = entries[-self._MAX_RECENT_HISTORY:]
        history_text = "\n".join(
            f"- [{e['timestamp']}] {e['content']}" for e in capped
        )
        history_text = truncate_text(history_text, self._MAX_HISTORY_CHARS)
        parts.append("# Recent History\n\n" + history_text)
    
    return "\n\n---\n\n".join(parts)  # 用分隔符连接各部分
```

该方法的**分步构建策略**确保了每个上下文元素都按照正确的顺序和格式被整合到最终的系统提示词中。

#### 2. 消息列表构建

`build_messages` 方法负责构建完整的消息列表，处理了多种复杂情况：

```python
def build_messages(
    self,
    history: list[dict[str, Any]],
    current_message: str,
    skill_names: list[str] | None = None,
    media: list[str] | None = None,
    channel: str | None = None,
    chat_id: str | None = None,
    current_role: str = "user",
    session_summary: str | None = None,
    sender_id: str | None = None,
) -> list[dict[str, Any]]:
    """构建用于LLM调用的完整消息列表"""
    # 构建运行时上下文
    runtime_ctx = self._build_runtime_context(
        channel, chat_id, self.timezone, 
        session_summary=session_summary, sender_id=sender_id
    )
    
    # 构建用户内容（可能包含图片）
    user_content = self._build_user_content(current_message, media)
    
    # 合并运行时上下文和用户内容到单个用户消息
    # 避免某些提供商拒绝的连续同角色消息
    if isinstance(user_content, str):
        merged = f"{runtime_ctx}\n\n{user_content}"
    else:
        merged = [{"type": "text", "text": runtime_ctx}] + user_content
    
    # 构建消息列表
    messages = [
        {"role": "system", "content": self.build_system_prompt(skill_names, channel=channel)},
        *history,
    ]
    
    # 处理角色交替
    if messages[-1].get("role") == current_role:
        last = dict(messages[-1])
        last["content"] = self._merge_message_content(last.get("content"), merged)
        messages[-1] = last
        return messages
    
    messages.append({"role": current_role, "content": merged})
    return messages
```

该方法的**智能合并策略**解决了消息角色交替的问题，确保与不同的LLM提供商兼容。

## 语法知识点总结

### 1. 类型注解（Type Hints）

#### 概念说明

类型注解是Python 3.5+引入的类型系统特性，允许在函数参数、返回值和变量上标注类型信息，提高代码的可读性和可维护性。

#### 代码示例

```python
from typing import Any, Optional, List, Dict

def build_system_prompt(
    self,
    skill_names: list[str] | None = None,  # 联合类型：字符串列表或None
    channel: str | None = None,            # 可选参数
) -> str:                                  # 返回类型：字符串
    """从身份、引导文件、记忆和技能构建系统提示词"""
    # 函数实现
    return "system prompt content"

def build_messages(
    self,
    history: list[dict[str, Any]],          # 复杂类型：包含任意值的字典列表
    current_message: str,
    skill_names: list[str] | None = None,
    media: list[str] | None = None,         # 文件路径列表或None
    channel: str | None = None,
    chat_id: str | None = None,
    current_role: str = "user",            # 默认参数
    session_summary: str | None = None,
    sender_id: str | None = None,
) -> list[dict[str, Any]]:                 # 返回类型：消息字典列表
    """构建用于LLM调用的完整消息列表"""
    return []
```

#### 使用场景和注意事项

**使用场景**：
- **大型项目**：提高代码的可读性和维护性
- **团队协作**：明确函数的输入输出契约
- **IDE支持**：获得更好的代码补全和错误检查
- **文档生成**：自动生成API文档

**注意事项**：
1. **可选类型**：使用 `| None` 或 `Optional[T]` 表示可选参数
2. **复杂类型**：使用 `list[dict[str, Any]]` 表示嵌套类型
3. **运行时不检查**：类型注解在运行时不会被强制执行
4. **渐进式采用**：可以在关键函数上先使用，逐步扩展到整个项目

### 2. 静态方法和实例方法

#### 概念说明

Python中的静态方法（@staticmethod）不需要访问实例状态，而实例方法可以访问和修改实例属性。正确选择方法类型对于面向对象设计非常重要。

#### 代码示例

```python
class ContextBuilder:
    """构建代理上下文的构建器"""
    
    def __init__(self, workspace: Path, timezone: str | None = None):
        """实例方法：需要访问实例状态"""
        self.workspace = workspace           # 实例属性
        self.timezone = timezone
        self.memory = MemoryStore(workspace)  # 依赖其他组件
    
    @staticmethod
    def _build_runtime_context(
        channel: str | None, 
        chat_id: str | None, 
        timezone: str | None = None,
        session_summary: str | None = None, 
        sender_id: str | None = None,
    ) -> str:
        """静态方法：不访问实例状态，纯函数"""
        lines = [f"Current Time: {current_time_str(timezone)}"]
        if channel and chat_id:
            lines += [f"Channel: {channel}", f"Chat ID: {chat_id}"]
        if sender_id:
            lines += [f"Sender ID: {sender_id}"]
        if session_summary:
            lines += ["", "[Resumed Session]", session_summary]
        return ContextBuilder._RUNTIME_CONTEXT_TAG + "\n" + "\n".join(lines) + "\n" + ContextBuilder._RUNTIME_CONTEXT_END
    
    def build_system_prompt(self, skill_names: list[str] | None = None) -> str:
        """实例方法：访问实例属性和其他组件"""
        identity = self._get_identity()          # 访问实例方法
        memory = self.memory.get_memory_context() # 访问实例属性
        # ... 更多实现细节
```

#### 使用场景和注意事项

**使用场景**：
- **静态方法**：工具函数、纯计算、常量相关操作
- **实例方法**：需要访问或修改对象状态的操作

**注意事项**：
1. **方法选择**：如果方法不需要访问实例状态，考虑使用静态方法
2. **调用方式**：静态方法可以通过类名或实例名调用
3. **测试性**：静态方法更容易进行单元测试
4. **性能**：静态方法避免了实例绑定的开销

### 3. 路径操作和文件处理

#### 概念说明

Python的`pathlib`模块提供了面向对象的路径操作接口，相比传统的字符串路径操作更加安全和直观。

#### 代码示例

```python
from pathlib import Path

class ContextBuilder:
    def __init__(self, workspace: Path, timezone: str | None = None):
        # 路径对象：支持链式操作和跨平台兼容性
        self.workspace = workspace
    
    def _load_bootstrap_files(self) -> str:
        """从工作区加载所有引导文件"""
        parts = []
        
        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename  # 路径拼接操作
            
            if file_path.exists():  # 检查文件是否存在
                content = file_path.read_text(encoding="utf-8")  # 读取文件内容
                parts.append(f"## {filename}\n\n{content}")
        
        return "\n\n".join(parts) if parts else ""
    
    def _build_user_content(self, text: str, media: list[str] | None):
        """构建用户消息内容（支持图片）"""
        if not media:
            return text
        
        images = []
        for path in media:
            p = Path(path)  # 将字符串路径转换为Path对象
            if not p.is_file():  # 检查是否为文件
                continue
            
            raw = p.read_bytes()  # 读取二进制内容
            # ... 图片处理逻辑
        
        return images + [{"type": "text", "text": "text"}]
```

#### 使用场景和注意事项

**使用场景**：
- **文件操作**：读取、写入、检查文件状态
- **路径操作**：拼接、解析、规范化路径
- **跨平台**：处理不同操作系统的路径差异

**注意事项**：
1. **路径拼接**：使用 `/` 操作符而不是字符串拼接
2. **路径解析**：使用 `.resolve()` 解析绝对路径
3. **文件检查**：使用 `.exists()`, `.is_file()` 等方法
4. **编码处理**：指定正确的字符编码（如 "utf-8"）

### 4. 列表推导式和数据过滤

#### 概念说明

列表推导式是Python中创建列表的简洁语法，结合了循环、条件判断和数据转换功能，代码更加简洁和高效。

#### 代码示例

```python
def build_system_prompt(self) -> str:
    """展示列表推导式的多种应用"""
    
    # 基础列表推导式：过滤和格式化历史记录
    entries = self.memory.read_unprocessed_history(
        since_cursor=self.memory.get_last_dream_cursor()
    )
    
    # 过滤最近50条记录
    capped = entries[-self._MAX_RECENT_HISTORY:]
    
    # 列表推导式：格式化时间戳和内容
    history_items = [
        f"- [{e['timestamp']}] {e['content']}" 
        for e in capped
    ]
    
    # 字符串拼接
    history_text = "\n".join(history_items)
    
    return history_text

def _build_user_content(self, text: str, media: list[str] | None):
    """展示复杂的列表推导式和条件过滤"""
    images = []
    for path in media:
        p = Path(path)
        if not p.is_file():  # 条件过滤
            continue
        
        raw = p.read_bytes()
        mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
        
        # 条件过滤：只处理图片文件
        if not mime or not mime.startswith("image/"):
            continue
        
        b64 = base64.b64encode(raw).decode()
        
        # 字典推导式：构建图片数据结构
        image_data = {
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
            "_meta": {"path": str(p)},
        }
        images.append(image_data)
    
    return images + [{"type": "text", "text": text}]
```

#### 使用场景和注意事项

**使用场景**：
- **数据转换**：将一种数据格式转换为另一种
- **过滤筛选**：根据条件选择特定元素
- **列表创建**：从其他数据结构创建列表
- **性能优化**：比传统for循环更高效

**注意事项**：
1. **可读性**：复杂的逻辑应该使用传统for循环
2. **内存使用**：列表推导式会立即创建整个列表
3. **嵌套推导**：避免多层嵌套，影响可读性
4. **副作用**：避免在推导式中执行有副作用的操作

### 5. 异常处理和错误恢复

#### 概念说明

Python的异常处理机制允许程序在运行时错误发生时优雅地恢复，而不是崩溃。合理使用异常处理是编写健壮代码的关键。

#### 代码示例

```python
from contextlib import suppress

class ContextBuilder:
    @staticmethod
    def _is_template_content(content: str, template_path: str) -> bool:
        """检查内容是否与内置模板相同"""
        with suppress(Exception):  # 抑制所有异常
            # 尝试加载内置模板文件
            tpl = pkg_files("nanobot") / "templates" / template_path
            
            if tpl.is_file():
                template_content = tpl.read_text(encoding="utf-8").strip()
                user_content = content.strip()
                return user_content == template_content
        
        return False  # 如果出现异常，返回False
    
    def _build_user_content(self, text: str, media: list[str] | None):
        """处理文件操作中的异常"""
        images = []
        for path in media:
            try:
                p = Path(path)
                if not p.is_file():
                    continue
                
                # 可能抛出异常的操作
                raw = p.read_bytes()
                
                # 处理图片数据
                mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
                
                if not mime or not mime.startswith("image/"):
                    continue
                
                b64 = base64.b64encode(raw).decode()
                images.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:{mime};base64,{b64}"},
                })
                
            except FileNotFoundError:
                # 文件不存在异常
                continue
            except PermissionError:
                # 权限错误异常
                continue
            except Exception as e:
                # 其他异常，记录日志但继续处理
                print(f"Error processing image {path}: {e}")
                continue
        
        return images + [{"type": "text", "text": text}] if images else text
```

#### 使用场景和注意事项

**使用场景**：
- **文件操作**：处理文件不存在、权限错误等情况
- **网络请求**：处理连接超时、网络错误等
- **数据验证**：检查数据格式和完整性
- **资源清理**：确保资源被正确释放

**注意事项**：
1. **特定异常优先**：优先捕获具体的异常类型
2. **异常范围**：尽量缩小try块的范围
3. **异常处理**：提供有意义的错误处理逻辑
4. **过度使用**：避免用异常处理控制正常流程

### 6. 字符串处理和模板渲染

#### 概念说明

Python提供了强大的字符串处理能力，包括格式化、拼接、分割、替换等操作。模板渲染允许使用变量替换生成动态字符串。

#### 代码示例

```python
from nanobot.utils.prompt_templates import render_template

class ContextBuilder:
    def _get_identity(self, channel: str | None = None) -> str:
        """获取核心身份部分"""
        # 字符串格式化
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        
        # 条件字符串构建
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"
        
        # 模板渲染
        return render_template(
            "agent/identity.md",                # 模板文件路径
            workspace_path=workspace_path,         # 模板变量
            runtime=runtime,
            platform_policy=render_template(        # 嵌套模板渲染
                "agent/platform_policy.md", 
                system=system
            ),
            channel=channel or "",                 # 空值处理
        )
    
    def build_system_prompt(self) -> str:
        """展示多种字符串处理技巧"""
        parts = [self._get_identity()]
        
        # 条件字符串构建
        bootstrap = self._load_bootstrap_files()
        if bootstrap:
            parts.append(bootstrap)
        
        memory = self.memory.get_memory_context()
        if memory and not self._is_template_content(
            self.memory.read_memory(), "memory/MEMORY.md"
        ):
            # 字符串格式化和拼接
            parts.append(f"# Memory\n\n{memory}")
        
        # 使用分隔符连接多个字符串
        return "\n\n---\n\n".join(parts)
    
    @staticmethod
    def _merge_message_content(left: Any, right: Any):
        """合并消息内容，处理不同数据类型"""
        if isinstance(left, str) and isinstance(right, str):
            # 条件字符串拼接
            return f"{left}\n\n{right}" if left else right
        
        # 处理列表类型的内容
        def _to_blocks(value: Any) -> list[dict[str, Any]]:
            if isinstance(value, list):
                return [
                    item if isinstance(item, dict) 
                    else {"type": "text", "text": str(item)}
                    for item in value
                ]
            if value is None:
                return []
            return [{"type": "text", "text": str(value)}]
        
        return _to_blocks(left) + _to_blocks(right)
```

#### 使用场景和注意事项

**使用场景**：
- **动态内容生成**：根据不同条件生成不同内容
- **模板文件**：使用模板文件管理复杂字符串格式
- **多语言支持**：支持不同语言的文本生成
- **数据格式化**：将数据转换为人类可读的文本

**注意事项**：
1. **性能考虑**：大量字符串操作时考虑性能影响
2. **编码处理**：注意字符串编码问题
3. **模板安全**：避免在模板中执行危险代码
4. **内存使用**：大字符串拼接时考虑内存消耗

### 7. Base64编码和数据编码

#### 概念说明

Base64是一种编码方式，将二进制数据转换为ASCII字符串，常用于在文本协议中传输二进制数据。

#### 代码示例

```python
import base64

class ContextBuilder:
    def _build_user_content(self, text: str, media: list[str] | None):
        """构建用户消息内容（支持图片）"""
        if not media:
            return text
        
        images = []
        for path in media:
            p = Path(path)
            if not p.is_file():
                continue
            
            # 读取二进制数据
            raw = p.read_bytes()
            
            # 检测MIME类型
            mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
            
            if not mime or not mime.startswith("image/"):
                continue
            
            # Base64编码：将二进制数据转换为字符串
            b64 = base64.b64encode(raw).decode()
            
            # 构建数据URL：用于在HTTP协议中传输内联数据
            data_url = f"data:{mime};base64,{b64}"
            
            images.append({
                "type": "image_url",
                "image_url": {"url": data_url},
                "_meta": {"path": str(p)},
            })
        
        return images + [{"type": "text", "text": text}] if images else text
```

#### 使用场景和注意事项

**使用场景**：
- **图片传输**：在文本消息中嵌入图片
- **文件上传**：在JSON或XML中传输二进制数据
- **数据存储**：将二进制数据存储为文本格式
- **邮件附件**：在邮件中嵌入附件

**注意事项**：
1. **大小增加**：Base64编码会增加约33%的数据大小
2. **性能影响**：编码和解码需要计算资源
3. **内存使用**：大文件的Base64编码会占用大量内存
4. **安全性**：Base64不是加密，不要用于敏感数据保护

### 8. 平台信息和跨平台处理

#### 概念说明

Python的`platform`模块提供了获取系统平台信息的功能，使代码能够适应不同的操作系统环境。

#### 代码示例

```python
import platform

class ContextBuilder:
    def _get_identity(self, channel: str | None = None) -> str:
        """获取核心身份部分"""
        workspace_path = str(self.workspace.expanduser().resolve())
        
        # 获取平台信息
        system = platform.system()      # 操作系统名称
        machine = platform.machine()      # 硬件架构
        python_version = platform.python_version()  # Python版本
        
        # 条件字符串构建：处理macOS的特殊名称
        runtime = f"{'macOS' if system == 'Darwin' else system} {machine}, Python {python_version}"
        
        return render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template(
                "agent/platform_policy.md", 
                system=system  # 传递系统信息到模板
            ),
            channel=channel or "",
        )
```

#### 使用场景和注意事项

**使用场景**：
- **跨平台支持**：适配不同操作系统的行为
- **路径处理**：处理不同系统的路径格式
- **依赖管理**：根据平台选择不同的依赖库
- **用户界面**：根据平台提供不同的用户体验

**注意事项**：
1. **平台测试**：确保在所有支持的平台上测试
2. **功能差异**：注意不同平台的功能差异
3. **路径处理**：使用`pathlib`处理路径差异
4. **环境变量**：注意不同平台的环境变量差异

## 实际应用示例

### 基本使用方法

#### 创建上下文构建器

```python
from pathlib import Path
from nanobot.agent.context import ContextBuilder

# 创建上下文构建器
context_builder = ContextBuilder(
    workspace=Path("/path/to/workspace"),
    timezone="Asia/Shanghai",      # 可选：设置时区
    disabled_skills=["deprecated_skill"]  # 可选：禁用特定技能
)

# 构建系统提示词
system_prompt = context_builder.build_system_prompt(
    skill_names=["analysis", "coding"],
    channel="discord"
)
print("系统提示词:")
print(system_prompt)
```

#### 构建基本消息

```python
# 准备历史消息
history = [
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": "你好！有什么我可以帮助你的吗？"},
]

# 构建完整消息列表
messages = context_builder.build_messages(
    history=history,
    current_message="请分析这个项目的代码结构",
    skill_names=["file_analysis", "code_review"],
    channel="telegram",
    chat_id="chat_12345",
    session_summary="继续之前的代码分析讨论"
)

for msg in messages:
    print(f"{msg['role']}: {msg['content'][:100]}...")
```

### 高级应用场景

#### 图片消息处理

```python
# 构建包含图片的用户消息
messages = context_builder.build_messages(
    history=[],
    current_message="请分析这张图片中的代码",
    media=[
        "/path/to/screenshot1.png",
        "/path/to/screenshot2.jpg",
        "/path/to/invalid.pdf"  # 会被自动过滤掉
    ]
)

# 消息会包含base64编码的图片
user_msg = messages[-1]
if isinstance(user_msg["content"], list):
    for item in user_msg["content"]:
        if item["type"] == "image_url":
            print(f"图片: {item['_meta']['path']}")
        elif item["type"] == "text":
            print(f"文本: {item['text']}")
```

#### 多轮对话管理

```python
class ConversationManager:
    """管理多轮对话的上下文"""
    
    def __init__(self, workspace: Path):
        self.context_builder = ContextBuilder(workspace)
        self.history = []
        self.current_session_id = None
    
    def add_user_message(self, content: str, media: list[str] | None = None):
        """添加用户消息到对话历史"""
        messages = self.context_builder.build_messages(
            history=self.history,
            current_message=content,
            media=media,
            channel="discord",
            chat_id=self.current_session_id
        )
        
        # 将新消息添加到历史
        user_msg = messages[-1]
        self.history.append(user_msg)
        return messages
    
    def add_assistant_message(self, content: str, tool_calls: list[dict] | None = None):
        """添加助手回复到对话历史"""
        messages = self.context_builder.add_assistant_message(
            self.history,
            content=content,
            tool_calls=tool_calls
        )
        return messages
    
    def add_tool_result(self, tool_call_id: str, tool_name: str, result: str):
        """添加工具执行结果"""
        messages = self.context_builder.add_tool_result(
            self.history,
            tool_call_id,
            tool_name,
            result
        )
        return messages
    
    def get_full_context(self) -> list[dict]:
        """获取完整的对话上下文"""
        return self.context_builder.build_messages(
            history=self.history[:-1],  # 排除最后一条消息
            current_message=self.history[-1]["content"] if self.history else "",
            channel="discord"
        )

# 使用示例
manager = ConversationManager(Path("/workspace"))
manager.add_user_message("帮我分析这个文件")
manager.add_assistant_message("好的，我会帮你分析")
manager.add_tool_result("call_123", "read_file", "文件内容...")
full_context = manager.get_full_context()
```

#### 自定义引导文件

```python
# 在工作区创建引导文件
workspace = Path("/workspace")
(workspace / "AGENTS.md").write_text("""
# Agent Identity

你是一个专业的代码分析助手，擅长：
- 静态代码分析
- 架构设计评估
- 性能优化建议
""")

(workspace / "SOUL.md").write_text("""
# Personality and Tone

- 专业且友好
- 注重实用性和效率
- 提供具体的代码示例
- 鼓励最佳实践
""")

(workspace / "TOOLS.md").write_text("""
# Available Tools

## File Operations
- `read_file`: 读取文件内容
- `write_file`: 写入文件内容
- `search_files`: 搜索文件内容

## Analysis Tools  
- `analyze_code`: 代码静态分析
- `check_performance`: 性能检查
""")

# 创建上下文构建器，会自动加载引导文件
context_builder = ContextBuilder(workspace)
system_prompt = context_builder.build_system_prompt()
print("包含自定义引导的系统提示词:")
print(system_prompt)
```

### 最佳实践建议

#### 1. 上下文大小管理

合理管理上下文大小，避免超出模型限制：

```python
class ContextManager:
    def __init__(self, max_history_chars: int = 10000):
        self.context_builder = ContextBuilder(workspace=Path("/workspace"))
        self.max_history_chars = max_history_chars
        self.history = []
    
    def add_to_history(self, message: dict):
        """添加消息到历史，控制大小"""
        self.history.append(message)
        
        # 计算总字符数
        total_chars = sum(len(str(msg.get("content", ""))) for msg in self.history)
        
        # 如果超出限制，移除最旧的消息（保留系统消息）
        while total_chars > self.max_history_chars and len(self.history) > 2:
            if self.history[0]["role"] != "system":
                removed = self.history.pop(0)
                total_chars -= len(str(removed.get("content", "")))
            else:
                break
    
    def get_context(self) -> list[dict]:
        """获取符合大小限制的上下文"""
        return self.context_builder.build_messages(
            history=self.history,
            current_message="",
            channel="discord"
        )
```

#### 2. 错误处理和日志记录

实现完善的错误处理和日志记录：

```python
import logging
from typing import Optional

class SafeContextBuilder(ContextBuilder):
    """带有错误处理的上下文构建器"""
    
    def __init__(self, workspace: Path, logger: Optional[logging.Logger] = None):
        super().__init__(workspace)
        self.logger = logger or logging.getLogger(__name__)
    
    def build_system_prompt(self, skill_names: list[str] | None = None, 
                          channel: str | None = None) -> str:
        """构建系统提示词，带有错误处理"""
        try:
            return super().build_system_prompt(skill_names, channel)
        except Exception as e:
            self.logger.error(f"构建系统提示词失败: {e}")
            # 返回最小的系统提示词
            return "You are a helpful AI assistant."
    
    def _load_bootstrap_files(self) -> str:
        """加载引导文件，带有错误处理"""
        parts = []
        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            try:
                if file_path.exists():
                    content = file_path.read_text(encoding="utf-8")
                    parts.append(f"## {filename}\n\n{content}")
                    self.logger.info(f"成功加载引导文件: {filename}")
                else:
                    self.logger.debug(f"引导文件不存在: {filename}")
            except Exception as e:
                self.logger.warning(f"加载引导文件 {filename} 失败: {e}")
                continue
        
        return "\n\n".join(parts) if parts else ""
    
    def _build_user_content(self, text: str, media: list[str] | None):
        """构建用户内容，处理媒体文件错误"""
        if not media:
            return text
        
        images = []
        for path in media:
            try:
                processed = self._process_single_image(path)
                if processed:
                    images.append(processed)
            except Exception as e:
                self.logger.warning(f"处理图片 {path} 失败: {e}")
                continue
        
        return images + [{"type": "text", "text": text}] if images else text
    
    def _process_single_image(self, path: str) -> Optional[dict]:
        """处理单个图片文件"""
        p = Path(path)
        if not p.is_file():
            raise FileNotFoundError(f"文件不存在: {path}")
        
        raw = p.read_bytes()
        mime = detect_image_mime(raw) or mimetypes.guess_type(path)[0]
        
        if not mime or not mime.startswith("image/"):
            raise ValueError(f"不是图片文件: {path}")
        
        b64 = base64.b64encode(raw).decode()
        return {
            "type": "image_url",
            "image_url": {"url": f"data:{mime};base64,{b64}"},
            "_meta": {"path": str(p)},
        }
```

#### 3. 性能优化

实现缓存和延迟加载以提高性能：

```python
from functools import lru_cache
import hashlib

class OptimizedContextBuilder(ContextBuilder):
    """性能优化的上下文构建器"""
    
    def __init__(self, workspace: Path, **kwargs):
        super().__init__(workspace, **kwargs)
        self._bootstrap_cache = None
        self._bootstrap_hash = None
        self._skills_cache = {}
    
    def _load_bootstrap_files(self) -> str:
        """缓存引导文件内容"""
        # 计算引导文件的哈希值
        current_hash = self._calculate_bootstrap_hash()
        
        # 如果文件没有变化，返回缓存
        if self._bootstrap_hash == current_hash and self._bootstrap_cache:
            return self._bootstrap_cache
        
        # 重新加载引导文件
        self._bootstrap_cache = super()._load_bootstrap_files()
        self._bootstrap_hash = current_hash
        return self._bootstrap_cache
    
    def _calculate_bootstrap_hash(self) -> str:
        """计算引导文件的哈希值"""
        hash_str = ""
        for filename in self.BOOTSTRAP_FILES:
            file_path = self.workspace / filename
            if file_path.exists():
                content = file_path.read_text(encoding="utf-8")
                hash_str += content
        
        return hashlib.md5(hash_str.encode()).hexdigest()
    
    @lru_cache(maxsize=32)
    def get_cached_system_prompt(self, skills_tuple: tuple = tuple(), 
                                channel: str = "") -> str:
        """缓存系统提示词"""
        skill_names = list(skills_tuple) if skills_tuple else None
        return self.build_system_prompt(skill_names, channel or None)
```

#### 4. 模块化设计

实现模块化的上下文构建：

```python
from abc import ABC, abstractmethod
from typing import List, Dict, Any

class ContextPlugin(ABC):
    """上下文插件抽象基类"""
    
    @abstractmethod
    def get_content(self) -> str:
        """获取插件内容"""
        pass
    
    @abstractmethod
    def get_order(self) -> int:
        """获取插件顺序"""
        pass

class IdentityPlugin(ContextPlugin):
    """身份插件"""
    
    def __init__(self, workspace: Path, channel: str | None = None):
        self.workspace = workspace
        self.channel = channel
    
    def get_content(self) -> str:
        workspace_path = str(self.workspace.expanduser().resolve())
        system = platform.system()
        runtime = f"{'macOS' if system == 'Darwin' else system} {platform.machine()}, Python {platform.python_version()}"
        return render_template(
            "agent/identity.md",
            workspace_path=workspace_path,
            runtime=runtime,
            platform_policy=render_template("agent/platform_policy.md", system=system),
            channel=self.channel or "",
        )
    
    def get_order(self) -> int:
        return 0  # 身份插件优先级最高

class MemoryPlugin(ContextPlugin):
    """记忆插件"""
    
    def __init__(self, memory_store):
        self.memory_store = memory_store
    
    def get_content(self) -> str:
        memory = self.memory_store.get_memory_context()
        if memory:
            return f"# Memory\n\n{memory}"
        return ""
    
    def get_order(self) -> int:
        return 10  # 记忆插件优先级中等

class ModularContextBuilder:
    """模块化上下文构建器"""
    
    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.plugins: List[ContextPlugin] = []
    
    def register_plugin(self, plugin: ContextPlugin):
        """注册插件"""
        self.plugins.append(plugin)
        # 按顺序排序插件
        self.plugins.sort(key=lambda p: p.get_order())
    
    def build_system_prompt(self) -> str:
        """构建系统提示词"""
        parts = []
        for plugin in self.plugins:
            content = plugin.get_content()
            if content:
                parts.append(content)
        
        return "\n\n---\n\n".join(parts)

# 使用示例
modular_builder = ModularContextBuilder(Path("/workspace"))

# 注册各种插件
modular_builder.register_plugin(IdentityPlugin(Path("/workspace"), channel="discord"))
modular_builder.register_plugin(MemoryPlugin(memory_store))

# 可以轻松添加新插件
class CustomPlugin(ContextPlugin):
    def get_content(self) -> str:
        return "# Custom Section\n\nCustom content here"
    
    def get_order(self) -> int:
        return 5

modular_builder.register_plugin(CustomPlugin())

# 构建系统提示词
system_prompt = modular_builder.build_system_prompt()
```

## 总结

Nanobot ContextBuilder 模块实现了一个功能完整、设计优雅的LLM上下文构建系统。该模块通过以下核心特性提供了强大的上下文管理能力：

1. **分层架构设计**：身份、引导文件、记忆、技能等多层上下文整合
2. **灵活的消息处理**：支持文本、图片、工具调用等多种消息类型
3. **智能内容合并**：处理角色交替、消息合并等复杂情况
4. **跨平台支持**：适应不同操作系统的差异
5. **扩展性设计**：通过插件化架构支持功能扩展
6. **性能优化**：缓存、延迟加载等性能优化策略
7. **错误恢复**：完善的异常处理和错误恢复机制

该模块充分体现了Python语言的优势，结合了类型注解、面向对象、函数式编程等多种编程范式，为构建复杂的LLM应用提供了坚实的基础。

通过理解该模块的设计思路和实现细节，开发者可以更好地理解LLM上下文管理的架构设计，并为类似应用开发提供宝贵的参考。该模块不仅功能完整，而且代码质量高，是Python项目开发的优秀范例。
