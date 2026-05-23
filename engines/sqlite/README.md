# SQLite 引擎实现

## 概述

SQLite 是一个嵌入式/基于文件的 SQL 数据库。与基于服务端的引擎不同，SQLite 数据库是存储在用户项目目录中的单一文件，而非 `~/.spindb/containers/` 目录下。

## 平台支持

| 平台     | 架构  | 状态     | 备注                                      |
|----------|-------|----------|-------------------------------------------|
| darwin   | x64   | 已支持   | 使用 hostdb 二进制文件                    |
| darwin   | arm64 | 已支持   | 使用 hostdb 二进制文件（Apple Silicon）   |
| linux    | x64   | 已支持   | 使用 hostdb 二进制文件                    |
| linux    | arm64 | 已支持   | 使用 hostdb 二进制文件                    |
| win32    | x64   | 已支持   | 使用 hostdb 二进制文件                    |

## 二进制打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构 - 扁平结构（无 bin/ 子目录）

**重要提示**：SQLite 归档文件采用**扁平结构**——二进制文件位于根目录，而非 `bin/` 子目录中：

```
sqlite3              # 主命令行工具
sqldiff              # 数据库差异比对工具
sqlite3_analyzer     # 数据库分析工具
sqlite3_rsync        # 远程同步工具（如可用）
```

`BaseEmbeddedBinaryManager` 通过同时检查根目录和 `bin/` 位置来处理此情况，标准解压流程会将文件移至 `bin/` 以确保一致性。

### 版本映射同步

```typescript
export const SQLITE_VERSION_MAP: Record<string, string> = {
  '3': '3.51.2',
}
```

## 实现细节

### 二进制管理器

SQLite 使用专为基于文件的数据库设计的 `BaseEmbeddedBinaryManager`：
- 无服务端进程管理
- 扁平归档结构处理
- 简单的版本验证

### 版本解析

- **版本输出格式**：`3.51.2 2025-01-08 12:00:00 ...`
- **解析模式**：`/^(\d+\.\d+\.\d+)/`（首行）

### 基于文件的模型

SQLite 与基于服务端的引擎有本质区别：
- **无启动/停止**：`start()` 和 `stop()` 均为空操作
- **无端口**：端口始终为 0
- **无容器目录**：数据存储在用户项目目录（当前工作目录）中
- **注册表追踪**：`~/.spindb/config.json` 按名称追踪已注册的文件

### 状态检测

状态由文件是否存在决定，而非进程状态：
```typescript
async status(): Promise<StatusResult> {
  const exists = existsSync(this.filePath)
  return { running: exists, message: exists ? '文件存在' : '文件未找到' }
}
```

### 附加/分离命令

SQLite 使用特殊命令来替代创建/删除：
- `spindb attach <path>` - 将现有 SQLite 文件注册到 SpinDB
- `spindb detach <name>` - 从 SpinDB 取消注册（文件保留在磁盘上）

### 连接字符串格式

```
file:/path/to/database.sqlite
```

或直接使用文件路径。

## 备份与还原

### 备份格式

| 格式   | 扩展名   | 工具           | 备注               |
|--------|----------|----------------|--------------------|
| sql    | `.sql`   | sqlite3 .dump  | 纯文本 SQL         |
| binary | `.sqlite`| 文件复制       | 直接文件复制       |

### 二进制备份

二进制备份是简单的文件复制——SQLite 数据库是单一文件。

### SQL 备份

使用 SQLite 的 `.dump` 命令导出可移植的 SQL。

## 集成测试注意事项

### 测试夹具

位于 `tests/fixtures/sqlite/seeds/`：
- `sample-db.sql`：包含 5 条 test_user 记录

### 无需端口分配

SQLite 测试不需要端口管理，因为没有服务端进程。

## Docker E2E 测试注意事项

SQLite Docker E2E 测试验证：
- 文件创建
- 通过命令行执行 SQL 操作
- 备份/还原（两种格式）
- 附加/分离工作流

## 已知问题与注意点

### 1. 扁平归档结构

SQLite 归档文件没有 `bin/` 子目录。二进制管理器会处理此情况，但在调试解压问题时请注意这一差异。

### 2. 无服务端生命周期

对 SQLite 调用 `start()` 或 `stop()` 不会有任何效果。这是有意为之的设计。

### 3. 文件位置

SQLite 文件存储在用户的工作目录中，而非 `~/.spindb/containers/`。`config.json` 中的注册表仅追踪元数据。

### 4. WAL 模式注意事项

SQLite 在 WAL 模式下会创建额外文件（`*.wal`、`*.shm`）。二进制备份应包含这些文件，或者先确保执行干净检查点。

### 5. 数据库锁定

SQLite 使用文件锁。同一时间只允许一个写连接。允许多个读取者。

### 6. 跨平台文件路径

连接字符串中的文件路径应使用正斜杠或进行正确转义。

## CI/CD 注意事项

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 SQLite 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/sqlite-*
    key: sqlite-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/sqlite/version-maps.ts') }}
```