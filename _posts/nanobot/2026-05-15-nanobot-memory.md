---
layout: post-wide
title:  "06 Nanobot Memory模块解析"
date:   2026-05-15 20:00:00 +0800
categories: [nanobot]
---

## 模块整体架构

Nanobot Memory System 是一个复杂而优雅的记忆管理系统，为LLM代理提供了三层分层架构的记忆处理能力。该模块通过渐进式处理、容错机制和性能优化策略，实现了从实时记录到定时深度整合的完整记忆生命周期管理。

### 架构设计理念

Memory System 采用**三层分层架构**，每一层负责不同的记忆处理维度：

1. **持久化存储层** (MemoryStore)：负责文件I/O操作和数据持久化
2. **实时整合层** (Consolidator)：基于token预算的实时历史整合
3. **定时深度处理层** (Dream)：周期性的深度记忆分析和文件编辑

**分层架构的优势**：
- **关注点分离**：每层专注于特定的记忆处理任务
- **渐进式处理**：从快速记录到深度分析的渐进式流程
- **容错机制**：多层异常处理确保系统稳定性
- **性能优化**：针对不同处理阶段的专门优化策略

### 模块组织结构

Memory System 模块是一个单文件模块，包含三个核心类和相关常量定义：

```
Memory System
├── MemoryStore (持久化存储层)
│   ├── 历史记录管理 (history.jsonl)
│   ├── 长期记忆存储 (MEMORY.md)
│   ├── 个性定义 (SOUL.md)
│   ├── 用户偏好 (USER.md)
│   └── 光标管理 (.cursor, .dream_cursor)
├── Consolidator (实时整合层)
│   ├── Token预算计算
│   ├── 整合边界选择
│   └── LLM摘要生成
└── Dream (定时深度处理层)
    ├── 两阶段处理流程
    ├── 工具注册表管理
    └── Git集成自动提交
```

### 各组件依赖关系

Memory System 模块与nanobot生态系统中的其他模块有明确的依赖关系：

```
Memory System
├── nanobot.agent.runner (AgentRunner)
├── nanobot.agent.tools.registry (ToolRegistry)
├── nanobot.providers.base (LLMProvider)
├── nanobot.session.manager (SessionManager)
├── nanobot.utils.gitstore (GitStore)
├── nanobot.utils.helpers (辅助函数)
└── tiktoken (Token计数)
```

## 各文件功能详解

### MemoryStore 类 - 持久化存储层

MemoryStore 类是整个记忆系统的基础，负责纯文件I/O操作，为上层组件提供可靠的数据存储服务。

#### 核心类属性和常量

```python
class MemoryStore:
    """纯文件I/O记忆文件存储：MEMORY.md, history.jsonl, SOUL.md, USER.md"""
    
    _DEFAULT_MAX_HISTORY = 1000  # 默认最大历史记录数
    
    # 正则表达式用于解析遗留历史格式
    _LEGACY_ENTRY_START_RE = re.compile(r"^[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*")
    _LEGACY_TIMESTAMP_RE = re.compile(r"^[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*")
    _LEGACY_RAW_MESSAGE_RE = re.compile(
        r"^[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:"
    )
```

#### 主要方法功能对比

| 方法名 | 功能描述 | 关键特性 |
|--------|----------|----------|
| `append_history()` | 追加历史记录到JSONL文件 | 自动递增cursor、内容清理、大小限制 |
| `read_memory()` / `write_memory()` | 长期记忆文件操作 | 纯文本读写 |
| `read_soul()` / `write_soul()` | 个性定义文件操作 | 纯文本读写 |
| `read_user()` / `write_user()` | 用户偏好文件操作 | 纯文本读写 |
| `compact_history()` | 压缩历史记录 | 按条目数量限制 |
| `get_last_dream_cursor()` | 获取Dream处理指针 | 用于定时任务恢复 |
| `read_unprocessed_history()` | 读取未处理的历史记录 | 基于cursor的增量读取 |
| `_maybe_migrate_legacy_history()` | 遗留格式迁移 | 一次性升级任务 |
| `_parse_legacy_history()` | 解析遗留历史格式 | 容错优先策略 |

#### 核心功能实现描述

##### 1. 原子性历史记录写入

```python
def _write_entries(self, entries: list[dict[str, Any]]) -> None:
    """原子性地覆盖history.jsonl"""
    tmp_path = self.history_file.with_suffix(self.history_file.suffix + ".tmp")
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            for entry in entries:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())  # 确保数据写入磁盘
        
        # 原子性替换
        os.replace(tmp_path, self.history_file)
        
        # fsync目录以确保重操作的持久性
        with suppress(PermissionError):  # Windows上可能失败
            fd = os.open(str(self.history_file.parent), os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
```

**设计亮点**：
- **临时文件模式**：先写入临时文件再重命名
- **强制磁盘同步**：`fsync`确保数据持久化
- **原子性操作**：`os.replace`保证要么完全成功，要么完全失败
- **异常安全**：失败时清理临时文件

##### 2. 智能历史记录追加

```python
def append_history(self, entry: str, *, max_chars: int | None = None) -> int:
    """追加*entry*到history.jsonl并返回其自动递增的cursor"""
    limit = max_chars if max_chars is not None else _HISTORY_ENTRY_HARD_CAP
    cursor = self._next_cursor()
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    raw = entry.rstrip()
    
    # 防御性限制：捕获无意的超大写入
    if len(raw) > limit:
        if not self._oversize_logged:
            self._oversize_logged = True
            logger.warning(
                "history entry exceeds {} chars ({}); truncating. "
                "Usually means a caller forgot its own cap; "
                "further occurrences suppressed.",
                limit, len(raw),
            )
        raw = truncate_text(raw, limit)
    
    # 清理模板级别的泄露（如未闭合的<think前缀、<channel|>标记）
    content = strip_think(raw)
    
    # 如果清理后的内容为空但原始条目不为空，记录为空字符串
    # 而不是回退到原始泄露——否则strip_think的保证会在下游的
    # 历史重放/整合中被撤销。
    if raw and not content:
        logger.debug(
            "history entry {} stripped to empty (likely template leak); "
            "persisting empty content to avoid re-polluting context",
            cursor,
        )
    
    record = {"cursor": cursor, "timestamp": ts, "content": content}
    with open(self.history_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    
    self._cursor_file.write_text(str(cursor), encoding="utf-8")
    return cursor
```

**设计亮点**：
- **双重大小限制**：调用者限制+硬限制的防御机制
- **模板泄露清理**：使用`strip_think`移除模板标记
- **空内容处理**：智能处理清理后的空内容
- **rate-limit日志**：避免重复日志污染

##### 3. 高效JSONL文件读取

```python
def _read_last_entry(self) -> dict[str, Any] | None:
    """高效读取JSONL文件的最后一条记录"""
    try:
        with open(self.history_file, "rb") as f:
            f.seek(0, 2)  # 移动到文件末尾
            size = f.tell()
            if size == 0:
                return None
            
            # 读取文件末尾的4KB
            read_size = min(size, 4096)
            f.seek(size - read_size)
            data = f.read().decode("utf-8")
            lines = [line for line in data.split("\n") if line.strip()]
            
            if not lines:
                return None
            return json.loads(lines[-1])
    except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
        return None
```

**性能优化策略**：
- **尾部读取**：避免读取整个大文件
- **固定缓冲区**：只读取最后4KB获取最新记录
- **异常处理**：处理多种可能的异常情况
- **二进制模式**：使用`"rb"`模式避免编码问题

##### 4. 容错的遗留格式迁移

```python
def _maybe_migrate_legacy_history(self) -> None:
    """从遗留HISTORY.md到history.jsonl的一次性升级
    
    迁移是最佳努力的，优先保留尽可能多的内容
    而非完美解析。
    """
    if not self.legacy_history_file.exists():
        return
    if self.history_file.exists() and self.history_file.stat().st_size > 0:
        return
    
    try:
        legacy_text = self.legacy_history_file.read_text(
            encoding="utf-8",
            errors="replace",  # 容错编码处理
        )
    except OSError:
        logger.exception("Failed to read legacy HISTORY.md for migration")
        return
    
    entries = self._parse_legacy_history(legacy_text)
    try:
        if entries:
            self._write_entries(entries)
            last_cursor = entries[-1]["cursor"]
            self._cursor_file.write_text(str(last_cursor), encoding="utf-8")
            # 默认为"已处理"状态，升级不会在首次启动时
            # 将用户的整个历史档案重放到Dream中。
            self._dream_cursor_file.write_text(str(last_cursor), encoding="utf-8")
        
        # 备份原始文件
        backup_path = self._next_legacy_backup_path()
        self.legacy_history_file.replace(backup_path)
        logger.info(
            "Migrated legacy HISTORY.md to history.jsonl ({} entries)",
            len(entries),
        )
    except Exception:
        logger.exception("Failed to migrate legacy HISTORY.md")
```

**迁移策略**：
- **容错优先**：优先保留内容而非完美解析
- **一次性执行**：基于文件存在性判断避免重复迁移
- **备份保留**：原始文件重命名备份
- **cursor同步**：确保Dream不会重放已处理内容

### Consolidator 类 - 实时整合器

Consolidator 类负责基于token预算的实时历史记录整合，确保对话历史始终在模型上下文窗口限制内。

#### 核心常量定义

```python
# 个历史记录写入器对各自的负载进行紧密限制；
# append_history()中的_HISTORY_ENTRY_HARD_CAP是腰带和吊带式的默认值，
# 捕获任何忘记设置自己上限的新调用者。
_RAW_ARCHIVE_MAX_CHARS = 16_000       # 降级转储（LLM失败）
_ARCHIVE_SUMMARY_MAX_CHARS = 8_000    # LLM生成的整合摘要
_HISTORY_ENTRY_HARD_CAP = 64_000      # append_history()中的应急上限
```

#### 主要方法功能对比

| 方法名 | 功能描述 | 关键特性 |
|--------|----------|----------|
| `maybe_consolidate_by_tokens()` | Token预算驱动的整合 | 多轮循环、边界选择、降级机制 |
| `estimate_session_prompt_tokens()` | 估算会话token使用 | 探测消息、精确计算 |
| `pick_consolidation_boundary()` | 选择整合边界 | 用户回合边界、token精确控制 |
| `archive()` | LLM摘要生成 | 双重降级、大小限制 |
| `get_lock()` | 获取会话专用锁 | 弱引用、自动清理 |

#### 核心功能实现描述

##### 1. Token预算精确计算

```python
def estimate_session_prompt_tokens(
    self,
    session: Session,
    *,
    session_summary: str | None = None,
) -> tuple[int, str]:
    """估算正常会话历史视图的当前prompt大小"""
    history = session.get_history(max_messages=0, include_timestamps=True)
    channel, chat_id = (session.key.split(":", 1) if ":" in session.key else (None, None))
    
    # 构建探测消息用于token估算
    probe_messages = self._build_messages(
        history=history,
        current_message="[token-probe]",  # 探测标记
        channel=channel,
        chat_id=chat_id,
        session_summary=session_summary,
        sender_id=None,
    )
    
    return estimate_prompt_tokens_chain(
        self.provider,
        self.model,
        probe_messages,
        self._get_tool_definitions(),
    )

@property
def _input_token_budget(self) -> int:
    """整合LLM的可用输入token预算"""
    return self.context_window_tokens - self.max_completion_tokens - self._SAFETY_BUFFER
```

**设计亮点**：
- **安全缓冲区**：预留1024 token应对tokenizer估算误差
- **completion预留**：为模型输出预留空间
- **探测机制**：使用固定消息估算token消耗
- **动态预算**：根据模型和上下文窗口动态计算

##### 2. 智能整合边界选择

```python
def pick_consolidation_boundary(
    self,
    session: Session,
    tokens_to_remove: int,
) -> tuple[int, int] | None:
    """选择移除足够旧prompt token的用户回合边界"""
    start = session.last_consolidated
    if start >= len(session.messages) or tokens_to_remove <= 0:
        return None
    
    removed_tokens = 0
    last_boundary: tuple[int, int] | None = None
    
    # 从上次整合位置开始扫描
    for idx in range(start, len(session.messages)):
        message = session.messages[idx]
        # 只在用户回合边界选择整合点，确保对话完整性
        if idx > start and message.get("role") == "user":
            last_boundary = (idx, removed_tokens)
            if removed_tokens >= tokens_to_remove:
                return last_boundary
            removed_tokens += estimate_message_tokens(message)
    
    return last_boundary
```

**设计亮点**：
- **对话完整性**：只在用户回合边界选择整合点
- **token精确控制**：基于实际token消耗而非消息数量
- **渐进式移除**：从旧到新逐步整合
- **边界保护**：确保不会移除当前活跃对话

##### 3. 多轮整合循环

```python
async def maybe_consolidate_by_tokens(
    self,
    session: Session,
    *,
    session_summary: str | None = None,
) -> None:
    """循环：整合旧消息直到prompt符合安全预算
    
    预算为completion tokens和安全缓冲区预留空间，
    确保LLM请求永远不会超出上下文窗口。
    """
    if not session.messages or self.context_window_tokens <= 0:
        return
    
    # 获取会话专用锁
    lock = self.get_lock(session.key)
    async with lock:
        budget = self._input_token_budget
        target = int(budget * self.consolidation_ratio)  # 默认50%整合目标
        
        try:
            estimated, source = self.estimate_session_prompt_tokens(
                session,
                session_summary=session_summary,
            )
        except Exception:
            logger.exception("Token estimation failed for {}", session.key)
            estimated, source = 0, "error"
        
        if estimated <= 0:
            return
        
        if estimated < budget:
            # 仍在预算内，无需整合
            unconsolidated_count = len(session.messages) - session.last_consolidated
            logger.debug(
                "Token consolidation idle {}: {}/{} via {}, msgs={}",
                session.key,
                estimated,
                self.context_window_tokens,
                source,
                unconsolidated_count,
            )
            return
        
        # 多轮整合循环，最多5轮
        last_summary = None
        for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
            if estimated <= target:
                break
            
            # 选择整合边界
            boundary = self.pick_consolidation_boundary(session, max(1, estimated - target))
            if boundary is None:
                logger.debug(
                    "Token consolidation: no safe boundary for {} (round {})",
                    session.key,
                    round_num,
                )
                break
            
            end_idx = boundary[0]
            chunk = session.messages[session.last_consolidated:end_idx]
            
            if not chunk:
                break
            
            logger.info(
                "Token consolidation round {} for {}: {}/{} via {}, chunk={} msgs",
                round_num,
                session.key,
                estimated,
                self.context_window_tokens,
                source,
                len(chunk),
            )
            
            # 执行整合
            summary = await self.archive(chunk)
            
            # 推进cursor：成功时chunk已被摘要；
            # 失败时archive()已经将其原始归档为面包屑。
            # 在下次调用时重新归档同一chunk只会发出重复的[RAW]条目。
            if summary:
                last_summary = summary
            session.last_consolidated = end_idx
            self.sessions.save(session)
            
            if not summary:
                # LLM降级——停止在此调用中锤击它；
                # 下次调用可以重试一个新鲜chunk。
                break
            
            try:
                estimated, source = self.estimate_session_prompt_tokens(
                    session,
                    session_summary=session_summary,
                )
            except Exception:
                logger.exception("Token estimation failed for {}", session.key)
                estimated, source = 0, "error"
            
            if estimated <= 0:
                break
        
        # 持久化最后摘要到会话元数据，以便在下一次
        # prepare_session()调用时注入到运行时上下文中，对齐摘要
        # 注入策略与AutoCompact._archive()。
        if last_summary and last_summary != "(nothing)":
            session.metadata["_last_summary"] = {
                "text": last_summary,
                "last_active": session.updated_at.isoformat(),
            }
            self.sessions.save(session)
```

**设计亮点**：
- **渐进式整合**：最多5轮小步整合，避免过度调用LLM
- **降级保护**：LLM失败时停止而非重试，避免无限循环
- **摘要持久化**：保存最后摘要供下次注入到运行时上下文
- **锁机制**：弱引用锁避免内存泄漏

### Dream 类 - 定时深度处理器

Dream 类实现两阶段的记忆处理：分析历史记录，然后通过AgentRunner进行目标文件编辑。

#### 核心常量定义

```python
# _annotate_with_ages和阶段1提示模板中使用的陈旧阈值
# 单一真实来源，确保代码和提示对齐——
# 如果提高此值，LLM的指令字符串会自动更新。
_STALE_THRESHOLD_DAYS = 14

class Dream:
    """两阶段记忆处理器：分析history.jsonl，然后通过AgentRunner编辑文件
    
    阶段1：生成分析摘要（纯LLM调用）
    阶段2：委托给AgentRunner，使用read_file/edit_file工具
            以便LLM可以进行有针对性的增量编辑，而不是替换整个文件。
    """
    
    # 在prompt边界输入上设置限制，以便Dream的LLM调用永远不会超出
    # 模型的上下文窗口，只是因为文件（或遗留大型历史记录条目）
    # 意外增长。每个文件在agent需要时仍通过read_file完整出现
    # 在阶段2——这些上限仅绑定阶段1/2提示预览。
    _MEMORY_FILE_MAX_CHARS = 32_000
    _SOUL_FILE_MAX_CHARS = 16_000
    _USER_FILE_MAX_CHARS = 16_000
    _HISTORY_ENTRY_PREVIEW_MAX_CHARS = 4_000
```

#### 主要方法功能对比

| 方法名 | 功能描述 | 关键特性 |
|--------|----------|----------|
| `run()` | 主执行方法 | 两阶段处理、批量处理、Git集成 |
| `_build_tools()` | 构建Dream专用工具注册表 | 工具隔离、权限控制 |
| `_annotate_with_ages()` | 基于Git的行级年龄标注 | 陈旧检测、安全检查 |
| `_list_existing_skills()` | 列出现有技能用于去重 | 优先级处理、描述提取 |

#### 核心功能实现描述

##### 1. 智能年龄标注

```python
def _annotate_with_ages(self, content: str) -> str:
    """为MEMORY.md内容添加每行年龄后缀
    
    每个年龄超过_STALE_THRESHOLD_DAYS的非空行获得如下所示的后缀：
     ← 30d（表示自上次修改以来的天数）
    
    如果git不可用、标注失败或行数不匹配年龄计数
    （可能由未提交的工作树编辑引起），则返回原始内容未更改。
    这样做比标注错误数据更好。
    SOUL.md和USER.md从不标注。
    """
    file_path = "memory/MEMORY.md"
    try:
        ages = self.store.git.line_ages(file_path)
    except Exception:
        logger.debug("line_ages failed for {}", file_path)
        return content
    
    if not ages:
        return content
    
    had_trailing = content.endswith("\n")
    lines = content.splitlines()
    
    # 如果HEAD-blob行数与收到的工作树内容不一致，
    # 年龄将被分配到错误的行——跳过标注并
    # 为LLM提供未标注的内容，而不是误导性数据。
    if len(lines) != len(ages):
        logger.debug(
            "line_ages length mismatch for {} (lines={}, ages={}); skipping annotation",
            file_path, len(lines), len(ages),
        )
        return content
    
    annotated: list[str] = []
    for line, age in zip(lines, ages):
        if not line.strip():
            annotated.append(line)
            continue
        if age.age_days > _STALE_THRESHOLD_DAYS:
            # 添加Unicode向左箭头和天数
            annotated.append(f"{line}  ← {age.age_days}d")
        else:
            annotated.append(line)
    
    result = "\n".join(annotated)
    if had_trailing:
        result += "\n"
    return result
```

**设计亮点**：
- **Git集成**：使用`git.line_ages()`获取每行的修改时间
- **安全检查**：行数不匹配时跳过标注，避免误导性数据
- **陈旧阈值**：只标注超过14天的内容
- **Unicode支持**：使用`←`等Unicode符号进行标注

##### 2. 工具注册表隔离

```python
def _build_tools(self) -> ToolRegistry:
    """为Dream agent构建最小工具注册表"""
    from nanobot.agent.skills import BUILTIN_SKILLS_DIR
    from nanobot.agent.tools.file_state import FileStates
    from nanobot.agent.tools.filesystem import EditFileTool, ReadFileTool, WriteFileTool
    
    tools = ToolRegistry()
    workspace = self.store.workspace
    
    # 允许读取builtin skills以便在技能创建期间参考
    extra_read = [BUILTIN_SKILLS_DIR] if BUILTIN_SKILLS_DIR.exists() else None
    
    # Dream获得自己的FileStates，使其缓存与主循环的会话隔离
    # （问题#3571）。
    file_states = FileStates()
    tools.register(ReadFileTool(
        workspace=workspace,
        allowed_dir=workspace,
        extra_allowed_dirs=extra_read,
        file_states=file_states,
    ))
    tools.register(EditFileTool(workspace=workspace, allowed_dir=workspace, file_states=file_states))
    
    # write_file从workspace根目录解析相对路径，但只能写入skills/
    # 以便prompt可以安全使用skills/<name>/SKILL.md。
    skills_dir = workspace / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    tools.register(WriteFileTool(workspace=workspace, allowed_dir=skills_dir, file_states=file_states))
    
    return tools
```

**设计亮点**：
- **独立FileStates**：避免与主循环的缓存冲突
- **受限写入权限**：write_file只能写入skills目录，确保安全性
- **扩展读取权限**：可以读取builtin skills作为参考
- **安全目录创建**：skills目录不存在时自动创建

##### 3. 两阶段处理流程

```python
async def run(self) -> bool:
    """处理未处理的历史记录条目。如果完成了工作则返回True"""
    from nanobot.agent.skills import BUILTIN_SKILLS_DIR
    
    # 获取未处理的历史记录条目
    last_cursor = self.store.get_last_dream_cursor()
    entries = self.store.read_unprocessed_history(since_cursor=last_cursor)
    
    if not entries:
        return False
    
    # 批量处理（最多max_batch_size条）
    batch = entries[:self.max_batch_size]
    logger.info(
        "Dream: processing {} entries (cursor {}→{}), batch={}",
        len(entries), last_cursor, batch[-1]["cursor"], len(batch),
    )
    
    # 构建历史文本用于LLM——限制每个条目，以免遗留超大记录
    # （例如预#3412的raw_archive转储）破坏prompt。
    history_text = "\n".join(
        f"[{e['timestamp']}] "
        f"{truncate_text(e['content'], self._HISTORY_ENTRY_PREVIEW_MAX_CHARS)}"
        for e in batch
    )
    
    # 当前文件内容+每行年龄标注（仅MEMORY.md）
    # 每个文件仅在*prompt预览*中限制；
    # 阶段2仍通过read_file工具看到完整文件。
    current_date = datetime.now().strftime("%Y-%m-%d")
    raw_memory = self.store.read_memory() or "(empty)"
    annotated_memory = (
        self._annotate_with_ages(raw_memory)
        if self.annotate_line_ages
        else raw_memory
    )
    current_memory = truncate_text(annotated_memory, self._MEMORY_FILE_MAX_CHARS)
    current_soul = truncate_text(
        self.store.read_soul() or "(empty)", self._SOUL_FILE_MAX_CHARS,
    )
    current_user = truncate_text(
        self.store.read_user() or "(empty)", self._USER_FILE_MAX_CHARS,
    )
    
    file_context = (
        f"## Current Date\n{current_date}\n\n"
        f"## Current MEMORY.md ({len(current_memory)} chars)\n{current_memory}\n\n"
        f"## Current SOUL.md ({len(current_soul)} chars)\n{current_soul}\n\n"
        f"## Current USER.md ({len(current_user)} chars)\n{current_user}"
    )
    
    # 阶段1：分析（无技能列表——去重是阶段2的工作）
    phase1_prompt = (
        f"## Conversation History\n{history_text}\n\n{file_context}"
    )
    
    try:
        phase1_response = await self.provider.chat_with_retry(
            model=self.model,
            messages=[
                {
                    "role": "system",
                    "content": render_template(
                        "agent/dream_phase1.md",
                        strip=True,
                        stale_threshold_days=_STALE_THRESHOLD_DAYS,
                    ),
                },
                {"role": "user", "content": phase1_prompt},
            ],
            tools=None,
            tool_choice=None,
        )
        analysis = phase1_response.content or ""
        logger.debug("Dream Phase 1 analysis ({} chars): {}", len(analysis), analysis[:500])
    except Exception:
        logger.exception("Dream Phase 1 failed")
        return False
    
    # 阶段2：委托给AgentRunner，使用read_file/edit_file
    existing_skills = self._list_existing_skills()
    skills_section = ""
    if existing_skills:
        skills_section = (
            "\n\n## Existing Skills\n"
            + "\n".join(f"- {s}" for s in existing_skills)
        )
    phase2_prompt = f"## Analysis Result\n{analysis}\n\n{file_context}{skills_section}"
    
    tools = self._tools
    skill_creator_path = BUILTIN_SKILLS_DIR / "skill-creator" / "SKILL.md"
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": render_template(
                "agent/dream_phase2.md",
                strip=True,
                skill_creator_path=str(skill_creator_path),
            ),
        },
        {"role": "user", "content": phase2_prompt},
    ]
    
    try:
        result = await self._runner.run(AgentRunSpec(
            initial_messages=messages,
            tools=tools,
            model=self.model,
            max_iterations=self.max_iterations,
            max_tool_result_chars=self.max_tool_result_chars,
            fail_on_tool_error=False,
        ))
        logger.debug(
            "Dream Phase 2 complete: stop_reason={}, tool_events={}",
            result.stop_reason, len(result.tool_events),
        )
        for ev in (result.tool_events or []):
            logger.info("Dream tool_event: name={}, status={}, detail={}", 
                       ev.get("name"), ev.get("status"), ev.get("detail", "")[:200])
    except Exception:
        logger.exception("Dream Phase 2 failed")
        result = None
    
    # 从工具事件构建changelog
    changelog: list[str] = []
    if result and result.tool_events:
        for event in result.tool_events:
            if event["status"] == "ok":
                changelog.append(f"{event['name']}: {event['detail']}")
    
    # 仅在成功完成时推进cursor，防止静默丢失
    if result and result.stop_reason == "completed":
        new_cursor = batch[-1]["cursor"]
        self.store.set_last_dream_cursor(new_cursor)
        logger.info(
            "Dream done: {} change(s), cursor advanced to {}",
            len(changelog), new_cursor,
        )
    else:
        reason = result.stop_reason if result else "exception"
        logger.warning(
            "Dream incomplete ({}): cursor NOT advanced, will retry next cron cycle",
            reason,
        )
    
    self.store.compact_history()
    
    # Git自动提交（仅当有实际变更时）
    if changelog and self.store.git.is_initialized():
        ts = batch[-1]["timestamp"]
        summary = f"dream: {ts}, {len(changelog)} change(s)"
        commit_msg = f"{summary}\n\n{analysis.strip()}"
        sha = self.store.git.auto_commit(commit_msg)
        if sha:
            logger.info("Dream commit: {}", sha)
    
    return True
```

**设计亮点**：
- **两阶段分离**：分析阶段和执行阶段分离
- **批量处理**：限制单次处理的条目数量
- **工具隔离**：Dream使用独立的工具注册表
- **Git集成**：自动提交变更到版本控制
- **错误处理**：每个阶段独立的异常处理
- **进度跟踪**：基于cursor的增量处理

## 语法知识点总结

### 1. 异步编程和并发控制

#### 概念说明

Python的异步编程允许程序在等待I/O操作时执行其他任务，显著提高并发性能。在记忆系统中，异步编程用于LLM调用、文件操作等耗时操作。

#### 代码示例

```python
import asyncio
from weakref import WeakValueDictionary

class Consolidator:
    def __init__(self, ...):
        # 弱引用字典：当键的值不再被引用时自动清理
        self._locks: weakref.WeakValueDictionary[str, asyncio.Lock] = (
            weakref.WeakValueDictionary()
        )
    
    def get_lock(self, session_key: str) -> asyncio.Lock:
        """返回一个会话的共享整合锁"""
        return self._locks.setdefault(session_key, asyncio.Lock())
    
    async def maybe_consolidate_by_tokens(self, session: Session, ...) -> None:
        """循环：整合旧消息直到prompt符合安全预算"""
        # 获取会话专用锁
        lock = self.get_lock(session.key)
        async with lock:  # 异步上下文管理器
            budget = self._input_token_budget
            target = int(budget * self.consolidation_ratio)
            
            # 多轮整合循环
            for round_num in range(self._MAX_CONSOLIDATION_ROUNDS):
                # 异步LLM调用
                summary = await self.archive(chunk)
                # 处理结果
                if summary:
                    last_summary = summary
                session.last_consolidated = end_idx
                self.sessions.save(session)
                
                if not summary:
                    # LLM降级——停止继续调用
                    break
                
                # 重新估算token使用
                estimated, source = self.estimate_session_prompt_tokens(
                    session, session_summary=session_summary
                )
                if estimated <= 0:
                    break
```

**使用场景和注意事项**：

**使用场景**：
- **I/O密集型操作**：网络请求、文件读写、数据库操作
- **并发任务处理**：同时处理多个独立会话的整合
- **定时任务**：周期性执行的后台处理任务
- **资源限制**：需要精确控制资源使用的场景

**注意事项**：
1. **异步上下文管理器**：使用`async with`确保资源正确释放
2. **弱引用锁**：`WeakValueDictionary`避免内存泄漏，自动清理无引用的锁
3. **锁粒度**：选择合适的锁粒度（会话级别vs全局锁）
4. **异常处理**：异步代码中的异常需要特殊处理，避免被静默吞噬
5. **事件循环**：确保异步代码在正确的事件循环中执行

### 2. 类型注解和函数式编程

#### 概念说明

类型注解提供静态类型检查，提高代码可读性和IDE支持。函数式编程特性如高阶函数和Lambda表达式，使代码更加简洁和 expressive。

#### 代码示例

```python
from typing import TYPE_CHECKING, Any, Callable, Iterator

# TYPE_CHECKING用于避免循环导入
if TYPE_CHECKING:
    from nanobot.providers.base import LLMProvider
    from nanobot.session.manager import Session, SessionManager

class Consolidator:
    def __init__(
        self,
        store: MemoryStore,
        provider: LLMProvider,  # 前向引用，实际类型在TYPE_CHECKING块中
        model: str,
        sessions: SessionManager,
        context_window_tokens: int,
        build_messages: Callable[..., list[dict[str, Any]]],  # 高阶函数类型
        get_tool_definitions: Callable[[], list[dict[str, Any]]],  # 可调用对象
        max_completion_tokens: int = 4096,
        consolidation_ratio: float = 0.5,
    ):
        self.store = store
        self.provider = provider
        self._build_messages = build_messages  # 高阶函数赋值
        self._get_tool_definitions = get_tool_definitions
    
    def _iter_valid_entries(self) -> Iterator[tuple[dict[str, Any], int]]:
        """为具有有效int游标的条目生成(entry, cursor)；对腐败进行一次警告"""
        poisoned: Any = None
        for entry in self._read_entries():
            raw = entry.get("cursor")
            if raw is None:
                continue
            cursor = self._valid_cursor(raw)
            if cursor is None:
                poisoned = raw
                continue
            yield entry, cursor  # 生成器：惰性求值
        
        if poisoned is not None and not self._corruption_logged:
            self._corruption_logged = True
            logger.warning(
                "history.jsonl contains a non-int cursor ({!r}); dropping it. "
                "Usually caused by an external writer; further occurrences suppressed.",
                poisoned,
            )
```

**使用场景和注意事项**：

**使用场景**：
- **复杂函数签名**：可调用对象、高阶函数的类型注解
- **生成器**：处理大数据集时节省内存
- **循环导入**：避免模块间的循环依赖
- **类型检查**：支持mypy等静态类型检查工具

**注意事项**：
1. **TYPE_CHECKING模式**：只在类型检查时导入，避免运行时循环依赖
2. **生成器惰性求值**：按需生成数据，节省内存
3. **可调用对象类型**：`Callable[..., ReturnType]`表示任意参数的可调用对象
4. **Union类型**：使用`|`操作符表示多种可能的类型
5. **Optional类型**：`Type | None`表示可选类型

### 3. 正则表达式和字符串处理

#### 概念说明

正则表达式提供强大的字符串模式匹配和处理能力。在记忆系统中，正则表达式用于解析遗留历史格式、提取时间戳、识别特殊标记等。

#### 代码示例

```python
import re
from datetime import datetime

class MemoryStore:
    """纯文件I/O记忆文件存储：MEMORY.md, history.jsonl, SOUL.md, USER.md"""
    
    # 正则表达式用于解析遗留历史格式
    _LEGACY_ENTRY_START_RE = re.compile(r"^[(\d{4}-\d{2}-\d{2}[^\]]*)\]\s*")
    _LEGACY_TIMESTAMP_RE = re.compile(r"^[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*")
    _LEGACY_RAW_MESSAGE_RE = re.compile(
        r"^[\d{4}-\d{2}-\d{2}[^\]]*\]\s+[A-Z][A-Z0-9_]*(?:\s+\[tools:\s*[^\]]+\])?:"
    )
    
    def _parse_legacy_history(self, text: str) -> list[dict[str, Any]]:
        """解析遗留历史格式，容错优先策略"""
        # 标准化换行符
        normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        if not normalized:
            return []
        
        # 提供回退时间戳
        fallback_timestamp = self._legacy_fallback_timestamp()
        entries: list[dict[str, Any]] = []
        chunks = self._split_legacy_history_chunks(normalized)
        
        for cursor, chunk in enumerate(chunks, start=1):
            timestamp = fallback_timestamp  # 默认回退到文件修改时间
            content = chunk
            
            # 尝试解析时间戳
            match = self._LEGACY_TIMESTAMP_RE.match(chunk)
            if match:
                timestamp = match.group(1)  # 使用解析的时间戳
                remainder = chunk[match.end():].lstrip()
                if remainder:
                    content = remainder
            
            entries.append({
                "cursor": cursor,
                "timestamp": timestamp,
                "content": content,
            })
        
        return entries
    
    def _legacy_fallback_timestamp(self) -> str:
        """提供回退时间戳，解析失败时使用文件修改时间"""
        try:
            return datetime.fromtimestamp(
                self.legacy_history_file.stat().st_mtime,
            ).strftime("%Y-%m-%d %H:%M")
        except OSError:
            return datetime.now().strftime("%Y-%m-%d %H:%M")
```

**使用场景和注意事项**：

**使用场景**：
- **格式解析**：解析非标准或遗留格式的数据
- **模式匹配**：识别特定模式的字符串内容
- **数据提取**：从复杂字符串中提取结构化信息
- **验证和清理**：验证数据格式并清理无效内容

**注意事项**：
1. **编译正则表达式**：使用`re.compile()`提高重复使用的性能
2. **容错设计**：提供回退机制处理解析失败
3. **原始字符串**：正则表达式使用原始字符串避免转义问题
4. **性能考虑**：复杂的正则表达式可能影响性能，考虑缓存编译结果
5. **编码处理**：注意不同编码的字符处理差异

### 4. 文件I/O和原子操作

#### 概念说明

原子操作确保文件操作要么完全成功，要么完全失败，避免部分写入导致的数据损坏。在记忆系统中，原子操作用于确保数据一致性和可靠性。

#### 代码示例

```python
import os
from pathlib import Path

class MemoryStore:
    def _write_entries(self, entries: list[dict[str, Any]]) -> None:
        """原子性地覆盖history.jsonl"""
        # 创建临时文件
        tmp_path = self.history_file.with_suffix(self.history_file.suffix + ".tmp")
        try:
            with open(tmp_path, "w", encoding="utf-8") as f:
                for entry in entries:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()  # 确保数据写入缓冲区
                os.fsync(f.fileno())  # 强制写入磁盘
            
            # 原子性替换：要么完全成功，要么完全失败
            os.replace(tmp_path, self.history_file)
            
            # fsync目录以确保重操作的持久性
            # 在Windows上，用O_RDONLY打开目录会引发PermissionError
            # ——跳过那里的目录同步（NTFS同步记录元数据）。
            with suppress(PermissionError):
                fd = os.open(str(self.history_file.parent), os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        except BaseException:
            # 异常安全：确保临时文件被清理
            tmp_path.unlink(missing_ok=True)
            raise
    
    def _next_legacy_backup_path(self) -> Path:
        """生成下一个可用的备份文件路径"""
        candidate = self.memory_dir / "HISTORY.md.bak"
        suffix = 2
        while candidate.exists():
            candidate = self.memory_dir / f"HISTORY.md.bak.{suffix}"
            suffix += 1
        return candidate
```

**使用场景和注意事项**：

**使用场景**：
- **数据持久化**：确保关键数据不会因程序崩溃或异常而损坏
- **配置文件更新**：原子更新配置避免部分写入
- **日志文件管理**：日志轮转和备份
- **数据迁移**：格式升级时的安全转换

**注意事项**：
1. **临时文件策略**：先写入临时文件再重命名
2. **文件系统同步**：`fsync`确保数据真正写入磁盘
3. **异常处理**：确保临时文件在异常时被清理
4. **跨平台考虑**：不同文件系统的行为差异
5. **权限处理**：Windows上可能缺少某些文件系统操作

### 5. 上下文管理器和异常处理

#### 概念说明

上下文管理器提供资源获取和释放的标准化方式，异常处理机制确保程序在错误情况下能够优雅恢复。记忆系统中大量使用这些机制提高代码健壮性。

#### 代码示例

```python
from contextlib import suppress

class MemoryStore:
    def _maybe_migrate_legacy_history(self) -> None:
        """从遗留HISTORY.md到history.jsonl的一次性升级"""
        if not self.legacy_history_file.exists():
            return
        if self.history_file.exists() and self.history_file.stat().st_size > 0:
            return
        
        try:
            # 容错编码处理：使用errors="replace"
            legacy_text = self.legacy_history_file.read_text(
                encoding="utf-8",
                errors="replace",  # 替换无法解码的字符
            )
        except OSError:
            logger.exception("Failed to read legacy HISTORY.md for migration")
            return
        
        entries = self._parse_legacy_history(legacy_text)
        try:
            if entries:
                self._write_entries(entries)
                # ... 处理逻辑
                
                # 备份原始文件
                backup_path = self._next_legacy_backup_path()
                self.legacy_history_file.replace(backup_path)
                logger.info(
                    "Migrated legacy HISTORY.md to history.jsonl ({} entries)",
                    len(entries),
                )
        except Exception:
            logger.exception("Failed to migrate legacy HISTORY.md")
    
    def _next_cursor(self) -> int:
        """读取当前cursor计数并返回下一个值"""
        if self._cursor_file.exists():
            # 抑制特定异常：ValueError和OSError
            with suppress(ValueError, OSError):
                return int(self._cursor_file.read_text(encoding="utf-8").strip()) + 1
        
        # 快速路径：如果尾部完整则信任尾部。否则扫描整个文件
        # 并取max——即使单调不变量被外部写入破坏，
        # 这仍然保持正确。
        last = self._read_last_entry() or {}
        cursor = self._valid_cursor(last.get("cursor"))
        if cursor is not None:
            return cursor + 1
        
        # 最终回退：扫描所有有效条目
        return max((c for _, c in self._iter_valid_entries()), default=0) + 1
    
    @staticmethod
    def _valid_cursor(value: Any) -> int | None:
        """仅接受整型游标——拒绝bool（isinstance(True, int)为True）"""
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value
```

**使用场景和注意事项**：

**使用场景**：
- **资源管理**：文件、网络连接、锁等资源的自动清理
- **异常抑制**：忽略预期的异常，简化错误处理
- **类型验证**：确保数据类型正确性
- **容错处理**：提供回退机制处理异常情况

**注意事项**：
1. **精确异常捕获**：只捕获特定的预期异常
2. **上下文管理器嵌套**：可以嵌套使用多个上下文管理器
3. **异常传播**：重要异常应该传播，不应被不当抑制
4. **资源泄漏**：确保异常时资源被正确释放
5. **日志记录**：重要的异常和错误情况应该记录日志

### 6. 属性装饰器和类方法

#### 概念说明

属性装饰器提供对属性的访问控制，类方法定义与类本身相关的方法而非实例。记忆系统中使用这些特性提高代码的组织性和可读性。

#### 代码示例

```python
class MemoryStore:
    def __init__(self, workspace: Path, max_history_entries: int = _DEFAULT_MAX_HISTORY):
        self.workspace = workspace
        self.max_history_entries = max_history_entries
        self.memory_dir = ensure_dir(workspace / "memory")
        self.memory_file = self.memory_dir / "MEMORY.md"
        self.history_file = self.memory_dir / "history.jsonl"
        self._git = GitStore(workspace, tracked_files=[
            "SOUL.md", "USER.md", "memory/MEMORY.md", "memory/.dream_cursor",
        ])
        self._maybe_migrate_legacy_history()
    
    @property
    def git(self) -> GitStore:
        """提供GitStore实例的属性访问"""
        return self._git
    
    @staticmethod
    def read_file(path: Path) -> str:
        """静态方法：读取文件内容，不存在时返回空字符串"""
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""
    
    @staticmethod
    def _valid_cursor(value: Any) -> int | None:
        """静态方法：验证游标值的类型"""
        if isinstance(value, bool) or not isinstance(value, int):
            return None
        return value
    
    @staticmethod
    def _format_messages(messages: list[dict]) -> str:
        """静态方法：格式化消息列表为字符串"""
        lines = []
        for message in messages:
            if not message.get("content"):
                continue
            tools = f" [tools: {', '.join(message['tools_used'])}]" if message.get("tools_used") else ""
            lines.append(
                f"[{message.get('timestamp', '?')[:16]}] {message['role'].upper()}{tools}: {message['content']}"
            )
        return "\n".join(lines)
```

**使用场景和注意事项**：

**使用场景**：
- **计算属性**：需要动态计算的属性访问
- **工具方法**：与类相关但不依赖实例状态的方法
- **数据验证**：静态验证方法，可在任何地方调用
- **代码复用**：静态方法作为独立的工具函数

**注意事项**：
1. **@property vs @staticmethod**：根据是否需要访问实例状态选择合适的装饰器
2. **属性缓存**：复杂计算属性可能需要缓存机制
3. **静态方法限制**：无法访问实例属性或调用实例方法
4. **属性可写性**：@property默认只读，可写需要setter
5. **命名约定**：内部属性和方法使用下划线前缀表示私有

## 实际应用示例

### 基本使用方法

#### 创建记忆存储实例

```python
from pathlib import Path
from nanobot.agent.memory import MemoryStore

# 创建记忆存储实例
memory_store = MemoryStore(
    workspace=Path("/workspace/directory"),
    max_history_entries=1000  # 可选：设置最大历史记录数
)

# 读取长期记忆
memory_content = memory_store.read_memory()
print(f"当前记忆内容: {memory_content}")

# 写入长期记忆
memory_store.write_memory("重要信息：用户偏好深色主题")
print("记忆已更新")

# 读取个性定义
soul_content = memory_store.read_soul()
print(f"当前个性定义: {soul_content}")

# 追加历史记录
cursor = memory_store.append_history("用户询问了关于Python的问题")
print(f"历史记录已追加，cursor: {cursor}")

# 读取未处理的历史记录
last_dream_cursor = memory_store.get_last_dream_cursor()
unprocessed = memory_store.read_unprocessed_history(since_cursor=last_dream_cursor)
print(f"未处理的历史记录数: {len(unprocessed)}")
```

#### 配置整合器

```python
from nanobot.agent.memory import Consolidator
from nanobot.providers.openai import OpenAIProvider
from nanobot.session.manager import SessionManager

# 创建LLM提供商
provider = OpenAIProvider(api_key="your-api-key")

# 创建会话管理器
session_manager = SessionManager(workspace=Path("/workspace"))

# 创建整合器实例
consolidator = Consolidator(
    store=memory_store,
    provider=provider,
    model="gpt-4",
    sessions=session_manager,
    context_window_tokens=128000,  # 根据模型设置
    build_messages=build_messages_function,  # 消息构建函数
    get_tool_definitions=tool_definitions_function,  # 工具定义函数
    max_completion_tokens=4096,
    consolidation_ratio=0.5,  # 50%整合目标
)

# 处理会话整合
async def process_consolidation(session_key: str):
    session = session_manager.get_session(session_key)
    if session:
        await consolidator.maybe_consolidate_by_tokens(
            session,
            session_summary="继续之前关于编程的讨论"
        )
        print(f"会话 {session_key} 整合完成")

# 运行整合处理
import asyncio
asyncio.run(process_consolidation("discord:12345"))
```

#### 配置Dream处理器

```python
from nanobot.agent.memory import Dream

# 创建Dream处理器实例
dream_processor = Dream(
    store=memory_store,
    provider=provider,
    model="gpt-4",
    max_batch_size=20,  # 每次处理最多20条历史记录
    max_iterations=10,  # 最大迭代次数
    max_tool_result_chars=16000,  # 工具结果最大字符数
    annotate_line_ages=True,  # 启用行级年龄标注
)

# 运行Dream处理
async def run_dream():
    work_done = await dream_processor.run()
    if work_done:
        print("Dream处理完成，有新的记忆整合")
    else:
        print("Dream处理完成，没有新的历史记录需要处理")

# 定时执行Dream处理
import asyncio

async def scheduled_dream():
    while True:
        await run_dream()
        # 每小时执行一次
        await asyncio.sleep(3600)

# 启动定时任务
asyncio.run(scheduled_dream())
```

### 高级应用场景

#### 自定义整合策略

```python
class CustomConsolidator(Consolidator):
    """自定义整合器，实现更灵活的整合策略"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.custom_strategies = {
            "aggressive": 0.7,    # 激进整合：70%目标
            "conservative": 0.3,  # 保守整合：30%目标
            "balanced": 0.5,          # 平衡整合：50%目标
        }
        self.current_strategy = "balanced"
    
    def set_strategy(self, strategy: str) -> None:
        """设置整合策略"""
        if strategy in self.custom_strategies:
            self.current_strategy = strategy
            self.consolidation_ratio = self.custom_strategies[strategy]
    
    async def custom_consolidate(self, session: Session) -> dict:
        """自定义整合逻辑，返回详细的整合信息"""
        original_count = len(session.messages)
        original_tokens, _ = self.estimate_session_prompt_tokens(session)
        
        # 执行标准整合
        await self.maybe_consolidate_by_tokens(session)
        
        # 计算整合效果
        final_count = len(session.messages)
        final_tokens, _ = self.estimate_session_prompt_tokens(session)
        
        return {
            "strategy": self.current_strategy,
            "original_messages": original_count,
            "final_messages": final_count,
            "removed_messages": original_count - final_count,
            "original_tokens": original_tokens,
            "final_tokens": final_tokens,
            "saved_tokens": original_tokens - final_tokens,
            "compression_ratio": (original_count - final_count) / original_count if original_count > 0 else 0,
        }

# 使用自定义整合器
custom_consolidator = CustomConsolidator(
    store=memory_store,
    provider=provider,
    model="gpt-4",
    sessions=session_manager,
    context_window_tokens=128000,
    build_messages=build_messages_function,
    get_tool_definitions=tool_definitions_function,
)

# 切换到激进策略
custom_consolidator.set_strategy("aggressive")

# 执行自定义整合
async def run_custom_consolidation(session_key: str):
    session = session_manager.get_session(session_key)
    if session:
        result = await custom_consolidator.custom_consolidate(session)
        print(f"整合结果: {result}")
```

#### 增强的Dream处理

```python
import logging
from typing import Optional

class EnhancedDream(Dream):
    """增强的Dream处理器，提供更详细的监控和错误处理"""
    
    def __init__(self, *args, logger: Optional[logging.Logger] = None, **kwargs):
        super().__init__(*args, **kwargs)
        self.logger = logger or logging.getLogger(__name__)
        self.stats = {
            "total_processed": 0,
            "successful_runs": 0,
            "failed_runs": 0,
            "total_changes": 0,
        }
    
    async def run(self) -> bool:
        """增强的Dream运行方法，包含详细统计"""
        start_time = asyncio.get_event_loop().time()
        
        try:
            # 执行标准Dream处理
            work_done = await super().run()
            
            if work_done:
                self.stats["successful_runs"] += 1
            else:
                self.stats["failed_runs"] += 1
            
            self.stats["total_processed"] += 1
            
            # 记录性能指标
            end_time = asyncio.get_event_loop().time()
            duration = end_time - start_time
            
            self.logger.info(
                "Dream run completed in {:.2f}s - work_done={}, stats={}",
                duration, work_done, self.stats
            )
            
            return work_done
            
        except Exception as e:
            self.stats["failed_runs"] += 1
            self.logger.error(
                "Dream run failed with exception: {}",
                str(e),
                exc_info=True
            )
            return False
    
    def get_statistics(self) -> dict:
        """获取处理统计信息"""
        return self.stats.copy()
    
    def reset_statistics(self) -> None:
        """重置统计信息"""
        self.stats = {
            "total_processed": 0,
            "successful_runs": 0,
            "failed_runs": 0,
            "total_changes": 0,
        }

# 使用增强的Dream处理器
import logging
logger = logging.getLogger(__name__)

enhanced_dream = EnhancedDream(
    store=memory_store,
    provider=provider,
    model="gpt-4",
    logger=logger,
    max_batch_size=15,  # 较小的批次以提高稳定性
    max_iterations=8,   # 减少迭代次数避免超时
)

# 定时运行并监控
async def monitored_dream():
    while True:
        await enhanced_dream.run()
        
        # 每次运行后报告统计
        stats = enhanced_dream.get_statistics()
        logger.info(f"Dream统计: 成功率={stats['successful_runs']}/{stats['total_processed']}")
        
        # 每小时执行一次
        await asyncio.sleep(3600)

asyncio.run(monitored_dream())
```

### 最佳实践建议

#### 1. 记忆存储最佳实践

```python
class OptimizedMemoryStore(MemoryStore):
    """优化的记忆存储，提供更好的性能和可靠性"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._write_cache = {}  # 写入缓存
        self._read_cache = {}   # 读取缓存
    
    def write_memory(self, content: str) -> None:
        """带缓存的记忆写入"""
        cache_key = "memory"
        
        # 检查缓存，避免重复写入
        if cache_key in self._write_cache:
            cached_content, cached_hash = self._write_cache[cache_key]
            current_hash = hash(content)
            
            if cached_hash == current_hash:
                self.logger.debug("记忆内容未变化，跳过写入")
                return
        
        # 写入文件
        super().write_memory(content)
        
        # 更新缓存
        import hashlib
        self._write_cache[cache_key] = (content, hash(content))
    
    def read_memory(self) -> str:
        """带缓存的记忆读取"""
        cache_key = "memory"
        
        # 检查缓存
        if cache_key in self._read_cache:
            cached_content, mtime = self._read_cache[cache_key]
            current_mtime = self.memory_file.stat().st_mtime if self.memory_file.exists() else 0
            
            if mtime >= current_mtime:
                return cached_content
        
        # 读取文件
        content = super().read_memory()
        
        # 更新缓存
        mtime = self.memory_file.stat().st_mtime if self.memory_file.exists() else 0
        self._read_cache[cache_key] = (content, mtime)
        
        return content
```

#### 2. 整合策略优化

```python
class SmartConsolidator(Consolidator):
    """智能整合器，基于对话特征动态调整策略"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.conversation_patterns = {}
    
    def _analyze_conversation_pattern(self, session: Session) -> str:
        """分析对话模式，返回特征描述"""
        messages = session.messages
        
        if not messages:
            return "empty"
        
        # 分析消息长度分布
        lengths = [len(str(msg.get("content", ""))) for msg in messages]
        avg_length = sum(lengths) / len(lengths)
        
        # 分析消息频率
        user_messages = [msg for msg in messages if msg.get("role") == "user"]
        assistant_messages = [msg for msg in messages if msg.get("role") == "assistant"]
        
        # 基于分析结果选择策略
        if avg_length > 1000:
            return "long_messages"  # 长消息：更激进整合
        elif len(user_messages) > len(assistant_messages) * 2:
            return "user_heavy"  # 用户主导：保留更多用户消息
        elif len(assistant_messages) > len(user_messages) * 2:
            return "assistant_heavy"  # 助手主导：可以更激进整合
        else:
            return "balanced"  # 平衡对话：标准整合
    
    async def smart_consolidate(self, session: Session) -> None:
        """基于对话模式的智能整合"""
        pattern = self._analyze_conversation_pattern(session)
        
        # 根据对话模式调整整合策略
        if pattern == "long_messages":
            self.consolidation_ratio = 0.6  # 更激进整合
        elif pattern == "user_heavy":
            self.consolidation_ratio = 0.4  # 保留用户消息
        elif pattern == "assistant_heavy":
            self.consolidation_ratio = 0.7  # 可以更激进整合助手消息
        else:
            self.consolidation_ratio = 0.5  # 标准整合
        
        self.logger.info(f"对话模式: {pattern}, 整合比率: {self.consolidation_ratio}")
        
        # 执行整合
        await self.maybe_consolidate_by_tokens(session)
```

#### 3. 错误监控和恢复

```python
class RobustDream(Dream):
    """健壮的Dream处理器，完善的错误监控和自动恢复"""
    
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.error_history = []
        self.max_retries = 3
        self.retry_delay = 60  # 秒
    
    async def run_with_recovery(self) -> bool:
        """带自动恢复的Dream运行"""
        for attempt in range(self.max_retries):
            try:
                work_done = await self.run()
                
                if work_done:
                    self.error_history.clear()  # 成功时清除错误历史
                    return True
                
            except Exception as e:
                error_info = {
                    "attempt": attempt + 1,
                    "error": str(e),
                    "timestamp": datetime.now().isoformat(),
                    "error_type": type(e).__name__,
                }
                self.error_history.append(error_info)
                
                self.logger.error(
                    f"Dream运行失败 (尝试 {attempt + 1}/{self.max_retries}): {error_info}",
                    exc_info=True
                )
                
                # 最后一次尝试失败，不等待重试
                if attempt < self.max_retries - 1:
                    self.logger.info(f"等待 {self.retry_delay} 秒后重试...")
                    await asyncio.sleep(self.retry_delay)
        
        # 所有尝试都失败，尝试紧急恢复
        self.logger.error("所有重试尝试都失败，执行紧急恢复")
        return await self.emergency_recovery()
    
    async def emergency_recovery(self) -> bool:
        """紧急恢复程序"""
        try:
            # 1. 备份当前状态
            self._emergency_backup()
            
            # 2. 重置到已知良好状态
            self._reset_to_known_good_state()
            
            # 3. 清理可能损坏的数据
            self._cleanup_corrupted_data()
            
            self.logger.info("紧急恢复完成")
            return True
            
        except Exception as e:
            self.logger.critical(f"紧急恢复失败: {str(e)}", exc_info=True)
            return False
    
    def _emergency_backup(self) -> None:
        """创建紧急备份"""
        backup_dir = self.store.workspace / "emergency_backup"
        backup_dir.mkdir(exist_ok=True)
        
        import shutil
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # 备份关键文件
        for filename in ["MEMORY.md", "SOUL.md", "USER.md"]:
            src = self.store.workspace / filename
            if src.exists():
                dst = backup_dir / f"{filename}.{timestamp}"
                shutil.copy2(src, dst)
                self.logger.info(f"已备份 {filename} 到 {dst}")
    
    def _reset_to_known_good_state(self) -> None:
        """重置到已知良好状态"""
        # 检查是否有Git历史
        if self.store.git.is_initialized():
            # 回退到最后一次已知良好的提交
            try:
                self.store.git.reset_to_last_good_commit()
                self.logger.info("已重置到最后一次已知良好的Git提交")
            except Exception as e:
                self.logger.warning(f"Git重置失败: {str(e)}")
```

## 总结

Nanobot Memory System 实现了一个功能完整、设计优雅的三层记忆管理架构。该系统通过以下核心特性提供了强大的记忆处理能力：

1. **分层架构**：持久化存储、实时整合、定时深度处理三层分离
2. **数据安全**：原子写入、Git版本控制、多重备份机制
3. **智能整合**：基于token预算的精确整合和对话模式分析
4. **并发安全**：弱引用锁、会话隔离、异常处理
5. **性能优化**：文件I/O优化、缓存机制、批量处理
6. **容错机制**：多层降级策略、自动恢复、rate-limit日志
7. **可扩展性**：模块化设计、插件化工具、自定义策略支持

该记忆系统充分体现了现代软件工程的最佳实践，结合了异步编程、原子操作、智能算法等多种技术，为LLM应用的长期记忆管理提供了可靠的解决方案。通过三层架构、渐进式处理和完善的容错机制，系统能够在保证数据安全的同时，提供高效的记忆处理和整合能力。

### 设计亮点

- **渐进式记忆**：从快速记录到深度分析的完整生命周期
- **Token预算管理**：精确控制上下文窗口使用，避免超限
- **Git集成**：自动版本控制和变更追踪
- **智能年龄标注**：基于Git的陈旧内容识别和标注
- **两阶段处理**：分析阶段和执行阶段分离，提高效率
- **工具隔离**：Dream的独立工具注册表，避免缓存冲突
- **原子操作**：确保数据一致性和可靠性

通过理解该记忆系统的设计思路和实现细节，开发者可以更好地理解LLM应用的记忆管理架构，并为类似应用开发提供宝贵的参考。该系统不仅功能完整，而且代码质量高，是复杂系统设计的优秀范例。
