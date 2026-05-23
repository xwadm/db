# Weaviate 引擎实现

## 概述

Weaviate 是一个 AI 原生的向量数据库，提供 REST 和 gRPC API。与 Qdrant 和 Meilisearch 类似，所有操作均通过 HTTP 进行。使用类/集合（classes/collections）而非传统数据库。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 使用 hostdb 二进制文件 |

## 二进制打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构
```text
weaviate/
└── bin/
    └── weaviate           # 服务端二进制文件
```

### 版本映射同步

```typescript
export const WEAVIATE_VERSION_MAP: Record<string, string> = {
  '1': '1.35.7',
}
```

## 实现细节

### 二进制文件管理器

Weaviate 使用 `BaseBinaryManager` 并自定义覆写 `verify()` 方法：

```typescript
// Weaviate 不支持 --version（截至 v1.35.x）
// 验证仅检查二进制文件是否存在
async verify(): Promise<boolean> {
  return existsSync(binaryPath)
}
```

参见：https://github.com/weaviate/weaviate/issues/6571

### 版本解析

当前版本不适用（无 `--version` 参数）。`parseVersionFromOutput` 方法已实现，以备将来添加该参数时的向前兼容：
- **解析模式**：`/(?:weaviate\s+)?v?(\d+\.\d+\.\d+)/`

### REST API 引擎

Weaviate 是一个 **REST API 引擎** — 它没有 CLI shell：
- `spindb run` **不适用**
- `spindb connect` 在浏览器中打开 Web 仪表盘
- 所有数据操作均使用 HTTP REST API

### 双端口

Weaviate 使用两个端口：
- **HTTP 端口**（默认 8080）：REST API
- **gRPC 端口**（默认 8081）：gRPC API（通常为 HTTP 端口 + 1）

### 默认配置

- **默认 HTTP 端口**：8080（冲突时自动递增）
- **gRPC 端口**：HTTP 端口 + 1
- **健康检查端点**：`/v1/.well-known/ready`
- **Schema 端点**：`/v1/schema`
- **PID 文件**：容器目录中的 `weaviate.pid`

### 环境变量配置

Weaviate 使用环境变量（不使用配置文件）：

```bash
PERSISTENCE_DATA_PATH=/path/to/data
BACKUP_FILESYSTEM_PATH=/path/to/data/backups
QUERY_DEFAULTS_LIMIT=25
AUTHENTICATION_ANONYMOUS_ACCESS_ENABLED=true
DEFAULT_VECTORIZER_MODULE=none
ENABLE_MODULES=backup-filesystem
GRPC_PORT=8081
CLUSTER_HOSTNAME=node-{port}        # 每个容器必须唯一
CLUSTER_GOSSIP_BIND_PORT={port+100}  # Memberlist 散播（默认 7946）
CLUSTER_DATA_BIND_PORT={port+101}    # Memberlist 数据（默认 7947）
RAFT_PORT={port+200}                 # Raft 共识（默认 8300）
RAFT_INTERNAL_RPC_PORT={port+201}    # Raft 内部 RPC（默认 8301）
```

### 内部集群端口

除了 HTTP 和 gRPC 之外，Weaviate 还使用 4 个内部集群端口。这些端口**每个容器必须唯一**，否则 Weaviate 将无法启动（或与其他实例静默冲突）：

| 端口 | 默认值 | SpinDB 公式 | 用途 |
|------|---------|----------------|---------|
| HTTP | 8080 | `{port}` | REST API |
| gRPC | 8081 | `{port}+1` | gRPC API |
| 散播（Gossip） | 7946 | `{port}+100` | Memberlist 散播 |
| 数据（Data） | 7947 | `{port}+101` | Memberlist 数据 |
| Raft | 8300 | `{port}+200` | Raft 共识 |
| Raft RPC | 8301 | `{port}+201` | Raft 内部 RPC |

### 连接字符串格式

```text
http://127.0.0.1:{port}
```

### Web 仪表盘

`connect` 命令在默认浏览器中打开根 URL：
```text
http://localhost:{port}/
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| snapshot | `.snapshot` | REST API | Weaviate 文件系统备份 |

### 备份 API

备份和恢复使用 Weaviate 的文件系统备份端点：
- `POST /v1/backups/filesystem` - 创建备份（含状态轮询）
- `GET /v1/backups/filesystem/{id}` - 检查备份状态
- `POST /v1/backups/filesystem/{id}/restore` - 恢复备份

### 备份流程

1. `BACKUP_FILESYSTEM_PATH` 环境变量指向 `{dataDir}/backups`
2. 必须设置 `ENABLE_MODULES=backup-filesystem`（否则备份 API 返回 404）
3. 通过 `POST /v1/backups/filesystem` 触发备份，请求体为 `{ id: "spindb-backup-{ts}" }`
4. 通过 `GET /v1/backups/filesystem/{id}` 轮询状态，直到 `SUCCESS`
5. 将备份**目录**（而非单个文件）从 `{backupsDir}/{id}/` 复制到输出路径

### 恢复流程

1. 将备份目录复制到目标容器的 `{backupsDir}/{backupId}/`
2. **目录名称必须与备份内部 `backup_config.json` 中存储的备份 ID 匹配**。Weaviate 会对此进行验证，不匹配则返回 422。
3. 启动 Weaviate
4. 通过 `POST /v1/backups/filesystem/{backupId}/restore` 触发恢复
5. 如果恢复到具有不同 `CLUSTER_HOSTNAME` 的容器，需在请求体中传递 `node_mapping`：
   ```json
   { "node_mapping": { "node-8080": "node-9090" } }
   ```
6. 轮询恢复状态直到 `SUCCESS`

## 集成测试说明

### REST API 测试

集成测试使用 `fetch()` 进行操作，而非 CLI 工具。

### 测试端口

```typescript
weaviate: { base: 8090, clone: 8092, renamed: 8091 }
```

## Docker 端到端测试说明

Weaviate Docker 端到端测试使用 `curl` 进行所有操作：

```bash
# 健康检查
curl http://localhost:8080/v1/.well-known/ready

# 创建类
curl -X POST http://localhost:8080/v1/schema \
  -H 'Content-Type: application/json' \
  -d '{"class":"TestVectors","vectorizer":"none","properties":[...]}'

# 批量插入对象
curl -X POST http://localhost:8080/v1/batch/objects \
  -H 'Content-Type: application/json' \
  -d '{"objects":[...]}'
```

## 已知问题与注意事项

### 1. 无 --version 参数

截至 v1.35.x，Weaviate 二进制文件不支持 `--version`。跟踪于 [weaviate/weaviate#6571](https://github.com/weaviate/weaviate/issues/6571)。二进制验证仅检查文件存在性。与 CouchDB 模式相同。

### 2. 无 CLI Shell

`spindb run` 对 Weaviate 无效。请使用 REST API 或 Web 仪表盘。

### 3. 向量数据库语义

Weaviate 使用"类（classes）"（或"集合 collections"）而非"数据库（databases）"。操作以向量为中心：
- 创建带属性 Schema 的类
- 插入带可选向量的对象
- 按向量相似度或过滤器搜索

### 4. 内部集群端口必须唯一

Weaviate 默认绑定 4 个内部端口（散播 7946、数据 7947、raft 8300、raft RPC 8301）。运行多个 Weaviate 容器而不使用唯一端口会导致静默冲突或启动失败。SpinDB 从 HTTP 端口推导出唯一端口（参见上文"内部集群端口"）。

### 5. 备份必须启用 ENABLE_MODULES

启动时必须设置 `ENABLE_MODULES=backup-filesystem`，否则备份/恢复 API 端点返回 404。

### 6. 备份目录名称必须与内部 ID 匹配

Weaviate 备份是目录（而非单个文件）。备份目录名称**必须与** `backup_config.json` 中的内部备份 ID 匹配。将备份复制到新位置时，`restore.ts` 会读取 `backup_config.json` 以发现真实 ID 并相应地命名目标目录。

### 7. 跨容器恢复需要节点映射

将备份恢复到具有不同 `CLUSTER_HOSTNAME` 的容器时，Weaviate 恢复 API 需要 `node_mapping` 参数。缺少此参数会导致恢复失败并返回"无法解析主机名"（422）。

### 8. Windows 备份失败（LSM 文件锁定）

Weaviate 在 Windows 上对 LSM 存储文件持有排他锁，导致服务器运行时备份期间 `fsync` 无法执行。备份 API 返回"拒绝访问"错误。集成测试在 Windows 上跳过备份/恢复克隆测试。与 Meilisearch 模式相同。

### 9. gRPC 端口

gRPC 端口与 HTTP 端口分开（HTTP 端口 + 1）。如果使用 gRPC 客户端，请确保两个端口都可用。

### 10. 快照格式

快照是 Weaviate 的原生备份格式，与其他数据库不兼容。

### 11. 健康检查端点

使用 `/v1/.well-known/ready` 进行健康检查（就绪时返回 200）。

### 12. 类/集合命名

Weaviate 类名必须以大写字母开头（PascalCase）。带连字符的容器名称会自动转换（例如 `my-app` 变为类 `My_app`）。

## CI/CD 说明

### 基于 curl 的测试

CI 测试使用 `curl` 命令而非数据库 CLI 工具。

### GitHub Actions 缓存步骤

```yaml
- name: Cache Weaviate binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/weaviate-*
    key: weaviate-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/weaviate/version-maps.ts') }}
```

## REST API 快速参考

### Schema（类）
```bash
# 列出所有类
GET /v1/schema

# 获取类信息
GET /v1/schema/{class}

# 创建类
POST /v1/schema

# 删除类
DELETE /v1/schema/{class}
```

### 对象
```bash
# 批量插入对象
POST /v1/batch/objects

# 获取对象
GET /v1/objects/{class}/{id}

# 删除对象
DELETE /v1/objects/{class}/{id}
```

### 搜索
```bash
# GraphQL 查询
POST /v1/graphql
```

### 元信息
```bash
# 服务器元信息（含版本信息）
GET /v1/meta

# 健康/就绪检查
GET /v1/.well-known/ready
```