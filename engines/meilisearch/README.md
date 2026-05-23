# Meilisearch 引擎实现

## 概述

Meilisearch 是一个带有 REST API 的快速全文搜索引擎。与 Qdrant 类似，所有操作均通过 HTTP 进行，而非 CLI shell。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 备份/恢复存在问题（见下文） |

### Windows 备份/恢复限制

Windows 上的备份/恢复由于 Meilisearch 上游 bug 而**失败**：
- 快照创建因页面大小对齐错误而失败
- 这是 Meilisearch 的问题，非 SpinDB 问题

服务器操作（启动、停止、索引）在 Windows 上正常工作。

## 二进制文件打包

### 归档格式
- **Unix（macOS/Linux）**: `tar.gz`
- **Windows**: `zip`

### 归档结构
```
meilisearch/
└── bin/
    └── meilisearch      # 服务器二进制文件
```

### 版本映射同步

```typescript
export const MEILISEARCH_VERSION_MAP: Record<string, string> = {
  '1': '1.33.1',
}
```

## 实现细节

### 二进制管理器

Meilisearch 使用带有标准配置的 `BaseBinaryManager`。

### 版本解析

- **版本输出格式**: `meilisearch 1.33.1` 或 `v1.33.1`
- **解析模式**: `/(?:meilisearch\s+)?v?(\d+\.\d+\.\d+)/`

### REST API 引擎

Meilisearch 是一个 **REST API 引擎**：
- `spindb run` **不适用**
- `spindb connect` 在浏览器中打开 Web 仪表盘
- 所有操作均使用 HTTP REST API

### 单端口

与 Qdrant（双端口）不同，Meilisearch 仅使用 HTTP：
- **HTTP 端口**（默认 7700）：REST API 和仪表盘

### 默认配置

- **默认端口**: 7700（冲突时自动递增）
- **健康检查端点**: `/health`（返回 `{"status":"available"}`）
- **仪表盘**: `/`（根路径，而非 `/dashboard`）
- **PID 文件**: 容器目录中的 `meilisearch.pid`

### 索引命名

Meilisearch 使用 "indexes"（索引）而非 "databases"（数据库）：
- 索引 UID 仅允许**字母数字字符和下划线**
- 带连字符的容器名称会自动转换：`my-app` -> 索引 `my_app`

### 连接字符串格式

```
http://127.0.0.1:{port}
```

### Web 仪表盘

Meilisearch 仪表盘位于根路径：
```
http://localhost:{port}/
```

（而非像 Qdrant 那样的 `/dashboard`）

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| snapshot（快照） | `.snapshot` | REST API | Meilisearch 原生快照 |

### 快照目录放置 — 关键

**必须与数据目录平级，而非位于其内部。**

```
container/
├── data/           # Meilisearch 数据（--db-path）
└── snapshots/      # 快照目录（--snapshot-dir）
```

**错误示例：**
```
container/
└── data/
    └── snapshots/  # 错误 — 会导致 "failed to infer version" 错误
```

如果 `--snapshot-dir` 指向 `--db-path` 内部，Meilisearch 将失败并提示：
> "failed to infer the version of the database"

### Windows 备份失败

在 Windows 上，快照创建因页面大小对齐错误而失败。这是 Meilisearch 上游 bug。

## 集成测试说明

### REST API 测试

集成测试使用 `fetch()` 或 `curl`。

### 测试夹具

位于 `tests/fixtures/meilisearch/seeds/`：
- `README.md` 记录了基于 API 的方法

## Docker E2E 测试说明

Meilisearch Docker E2E 使用 `curl`：

```bash
# 健康检查
curl http://localhost:7700/health

# 创建索引
curl -X POST http://localhost:7700/indexes \
  -H 'Content-Type: application/json' \
  -d '{"uid":"movies","primaryKey":"id"}'

# 添加文档
curl -X POST http://localhost:7700/indexes/movies/documents \
  -H 'Content-Type: application/json' \
  -d '[{"id":1,"title":"蝙蝠侠"}]'
```

### Docker E2E 中跳过备份/恢复

Meilisearch 备份/恢复测试在 Docker E2E 中被跳过（由集成测试覆盖）。

## 已知问题与陷阱

### 1. 无 CLI Shell

`spindb run` 对 Meilisearch 无效。请使用 REST API 或 Web 仪表盘。

### 2. 仪表盘位于根路径

仪表盘位于 `/`（根路径），而非 `/dashboard`。与 Qdrant 不同。

### 3. 快照目录位置

快照目录**必须与数据目录平级**。这是最常见的 Meilisearch 配置问题。

### 4. 索引 UID 约束

索引 UID 仅允许 `[a-zA-Z0-9_]`。连字符会导致 API 错误：
```
# 无效: my-movies
# 有效: my_movies
```

### 5. Windows 备份已损坏

由于页面大小对齐 bug，快照创建在 Windows 上失败。这是 Meilisearch 上游问题。

### 6. 健康检查端点

使用 `/health`（而非像 Qdrant 那样的 `/healthz`）进行健康检查。

## CI/CD 说明

### 基于 curl 的测试

CI 测试使用 `curl` 命令。

### Windows 备份测试已跳过

由于上游 bug，备份/恢复测试在 Windows 上被跳过。

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 Meilisearch 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/meilisearch-*
    key: meilisearch-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/meilisearch/version-maps.ts') }}
```

## REST API 快速参考

### 索引
```bash
# 列出索引
GET /indexes

# 创建索引
POST /indexes
{"uid": "movies", "primaryKey": "id"}

# 获取索引
GET /indexes/{uid}

# 删除索引
DELETE /indexes/{uid}
```

### 文档
```bash
# 添加文档
POST /indexes/{uid}/documents

# 获取文档
GET /indexes/{uid}/documents/{id}

# 搜索
POST /indexes/{uid}/search
{"q": "搜索查询"}
```

### 快照
```bash
# 创建快照
POST /snapshots
```

### 健康检查
```bash
# 健康检查
GET /health
# 返回: {"status": "available"}
```