# FerretDB 引擎实现

## 概述

FerretDB 是一个 MongoDB 兼容代理，将数据存储在 PostgreSQL 中。它支持**两个主要版本**，使用不同的后端：

**v2（默认，仅支持 macOS/Linux）：**
1. **ferretdb**（hostdb: `ferretdb`）- 无状态 Go 代理
2. **postgresql-documentdb**（hostdb: `postgresql-documentdb`）- 带有 DocumentDB 扩展的 PostgreSQL 17

**v1（支持所有平台，包括 Windows）：**
1. **ferretdb**（hostdb: `ferretdb`）- 无状态 Go 代理（相同协议，旧版本）
2. **普通 PostgreSQL** - 通过 `postgresqlBinaryManager` 管理的标准 PostgreSQL（与独立 PG 容器共享）

这是一个**组合引擎**，具有独特的二进制文件管理需求。`version-maps.ts` 中的 `isV1(version)` 辅助函数是所有版本相关行为的唯一分支点。

## 平台支持

| 平台 | 架构 | v1 状态 | v2 状态 | 备注 |
|----------|--------------|-----------|-----------|-------|
| darwin | x64 | 支持 | 支持 | 两种后端均可用 |
| darwin | arm64 | 支持 | 支持 | 两种后端均可用（Apple Silicon） |
| linux | x64 | 支持 | 支持 | 两种后端均可用 |
| linux | arm64 | 支持 | 支持 | 两种后端均可用 |
| win32 | x64 | 支持 | **不支持** | v2: postgresql-documentdb 存在启动问题 |

### Windows 支持

FerretDB **v1 支持 Windows**。v2 在 Windows 上不可用，因为 postgresql-documentdb 无法正常初始化。`spindb create` 在 Windows 上自动选择 v1。在 Windows 上执行 `spindb engines download ferretdb 2` 会被阻止并给出提示错误，建议使用 v1。

**重要的 hostdb 说明：** hostdb 有 Windows 的 v2 代理二进制文件，但没有 Windows 的 `postgresql-documentdb`。这意味着 v2 代理可以成功下载但无法启动（没有后端）。`binary-urls.ts` 中的版本感知平台检查可以防止这种情况。

### macOS SIP / 容器限制

在 macOS 上，系统完整性保护（SIP）可以阻止在系统目录（例如 `/usr/local`）中创建符号链接。在容器化或受限环境中，即使 `sudo` 也可能不允许写入这些路径。如果在设置过程中遇到权限错误，请使用非系统安装位置或在可用时以提升的权限运行。参见 https://github.com/robertjbass/spindb#ferretdb 了解详情。这仅适用于 v2（DocumentDB 的 Homebrew 派生路径）。

## 二进制文件打包

### 压缩包格式
- **Unix（macOS/Linux）**：两个版本均使用 `tar.gz`
- **Windows**：v1 代理使用 `zip`，普通 PostgreSQL 由 `postgresqlBinaryManager` 处理

### FerretDB 压缩包结构（v1 和 v2 相同）
```
ferretdb/
└── bin/
    └── ferretdb          # Go 代理二进制文件
```

### postgresql-documentdb 压缩包结构（仅 v2）
```
postgresql-documentdb/
├── bin/
│   ├── pg_ctl           # PostgreSQL 控制工具
│   ├── initdb           # 数据库初始化
│   ├── psql             # 交互式终端
│   ├── pg_dump          # 备份工具
│   └── pg_restore       # 恢复工具
├── lib/
│   ├── libpq.so         # PostgreSQL 客户端库
│   ├── postgresql/      # 扩展模块
│   │   └── documentdb.so
│   └── *.dylib/*.so     # 其他共享库
└── share/               # 配置和数据文件
```

### v1 后端（普通 PostgreSQL）

v1 将后端管理委托给 `postgresqlBinaryManager`，该管理器从 hostdb 下载标准 PostgreSQL。PostgreSQL 二进制文件与独立 PostgreSQL 容器共享 —— 删除 FerretDB v1 安装**不会**删除共享的 PostgreSQL。

**注意：** 如果 `postgresqlBinaryManager.isInstalled()` 发现一个已有的最小化 PostgreSQL 安装（例如来自之前的 DocumentDB 提取），该安装只有服务器二进制文件（`postgres`、`pg_ctl`、`initdb`）但缺少客户端工具（`psql`），引擎会回退到使用 `postgres --single` 模式进行启动前的数据库创建。

### 为什么需要自定义 PostgreSQL 构建？（v2）

postgresql-documentdb 打包是一个**自定义的 PostgreSQL 17 构建**，包含：
- DocumentDB 扩展（MongoDB 兼容存储）
- PostGIS 扩展（从源码构建）
- pgvector 扩展
- 所有需要的 dylib，路径已重写

**为什么不使用 Homebrew PostgreSQL？**

Homebrew PostgreSQL 有硬编码的路径（`/opt/homebrew/lib/...`），在其他机器上会失效。hostdb 构建：
1. 使用相对路径从源码构建 PostgreSQL
2. 针对该 PostgreSQL 从源码构建 PostGIS
3. 打包所有依赖项（OpenSSL、ICU、GEOS、PROJ 等）
4. 将 dylib 路径重写为 macOS 使用的 `@loader_path`
5. 重新签名所有二进制文件（macOS 在修改后需要代码签名）

### 版本映射同步

```typescript
// FerretDB 版本
export const FERRETDB_VERSION_MAP: Record<string, string> = {
  '1': '1.24.2',   // v1: 普通 PostgreSQL 后端
  '2': '2.7.0',    // v2: postgresql-documentdb 后端
}

// v2 后端版本格式: {pg_major}-{documentdb_version}
export const DEFAULT_DOCUMENTDB_VERSION = '17-0.107.0'

// v1 后端: 标准 PostgreSQL 主版本号
export const DEFAULT_V1_POSTGRESQL_VERSION = '17'
```

## 实现细节

### 组合二进制文件管理器

FerretDB 使用自定义的 `FerretDBCompositeBinaryManager`：
- 原子性下载两个二进制文件（如果任一失败则回滚）—— 仅 v2
- 对于 v1，下载 FerretDB 代理然后委托 `postgresqlBinaryManager` 处理 PostgreSQL
- `isV1(version)` 分支所有版本相关行为
- `getBackendBinaryPath()` / `getBackendSpawnEnv()` 抽象 v1/v2 后端解析

### 架构

```
MongoDB 客户端 (:27017) -> FerretDB 代理 -> PostgreSQL 后端 (:54320+)
                                              v1: 普通 PostgreSQL
                                              v2: PostgreSQL + DocumentDB
```

### 每个容器使用三个端口

FerretDB 容器使用**三个端口**：
- **MongoDB 端口**（默认 27017）：MongoDB wire 协议，用于客户端连接
- **PostgreSQL 后端端口**（默认 54320+）：内部 PostgreSQL 连接
- **调试 HTTP 端口**（默认 37017+）：FerretDB 调试/指标处理器

### FerretDB 特定的启动标志

```bash
# v2:
ferretdb \
  --no-auth \                              # 禁用 SCRAM 认证（仅 v2）
  --debug-addr=127.0.0.1:${port + 10000} \ # 每个容器的唯一调试端口
  --listen-addr=127.0.0.1:${port} \        # MongoDB wire 协议端口
  --postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb

# v1（差异）:
ferretdb \
  # 无 --no-auth（v1 默认禁用认证）
  --debug-addr=127.0.0.1:${port + 10000} \
  --listen-addr=127.0.0.1:${port} \
  --postgresql-url=postgres://postgres@127.0.0.1:${backendPort}/ferretdb?sslmode=disable
```

### Linux LD_LIBRARY_PATH

在 Linux 上，打包的二进制文件需要设置 `LD_LIBRARY_PATH` 来查找共享库：

```typescript
getBackendSpawnEnv(): { LD_LIBRARY_PATH: '/path/to/lib:$LD_LIBRARY_PATH' }
```

macOS 使用 `@loader_path`，不需要环境变量。v1 和 v2 均适用。

### macOS 代码签名

下载的二进制文件使用临时签名（`codesign -s -`）重新签名，因为 Gatekeeper 隔离会使原始签名失效。

### 连接字符串格式

```
mongodb://127.0.0.1:{port}/{database}
```

当 `authEnabled` 为 false（默认）时，FerretDB v2 使用 `--no-auth` 运行，
不需要凭据。当 `authEnabled` 为 true 时，本地工具会加载
保存的 `.env.spindb` 凭据文件，并使用包含 `authSource` 的 MongoDB URI 连接。

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| bson | 目录 | mongodump | 每个集合的 BSON 文件 |
| archive | `.archive` | mongodump --archive --gzip | 单个压缩文件 |

### 恢复行为

当前 SpinDB FerretDB 的备份和恢复通过 FerretDB 代理使用 MongoDB wire 协议
（`mongodump` / `mongorestore`）。这避免了旧的基于 DocumentDB 元数据冲突的
`pg_dump` / `pg_restore`，并且在 `.env.spindb` 存在时支持启用认证的本地容器。

旧的基于 PostgreSQL 的 `.dump` 和 `.sql` 备份仍然可以恢复，
以保证向后兼容性，但新备份应使用上述 MongoDB 兼容格式。

## 引擎依赖管理

### 卸载行为

**v2：** 同时删除 FerretDB 代理和 postgresql-documentdb。postgresql-documentdb 二进制文件是专用依赖，不与其他引擎共享。

**v1：** 仅删除 FerretDB 代理。普通 PostgreSQL 二进制文件**不会被删除**，因为它们与独立 PostgreSQL 容器共享。

这与 QuestDB 的 PostgreSQL 依赖不同（参见 QuestDB README）。

## 已知问题与注意事项

### 1. 认证注意事项

FerretDB 2.x 默认启用 SCRAM 认证。`--setup-username` 和 `--setup-password` 标志**不存在**，尽管文档中有建议。请改用 `--no-auth`。FerretDB 1.x 默认禁用认证（不需要标志）。

### 2. 调试端口冲突

如果所有容器都使用默认调试端口 8088，运行多个 FerretDB 容器会失败。解决方案：`--debug-addr=127.0.0.1:${port + 10000}`

### 3. 数据库可见性

与 MongoDB 类似，数据库在写入数据之前不会出现。引擎使用临时集合技巧（`_spindb_init`）。

### 4. 命名空间派生

命名空间从容器名称派生：`my-app` -> `my_app`（连字符替换为下划线）。

### 5. Windows：v2 不支持，v1 支持

经过广泛测试确认，postgresql-documentdb（v2 后端）在 Windows 上无法正常启动。FerretDB v1 使用普通 PostgreSQL，在所有平台上均可工作，包括 Windows。**注意：** hostdb 有 Windows 的 v2 代理二进制文件，但没有后端 —— 下载命令会阻止 Windows 上的 v2 以防止安装损坏。

### 6. v1 二进制文件验证

FerretDB v1 hostdb 构建在运行 `--version` 时会 panic，因为源码期望 `build/version/version.txt`（通过 `//go:embed`）。hostdb 构建脚本必须创建此文件。SpinDB 对 v1 跳过 `--version` 验证（仅检查二进制文件是否存在）。

### 7. v1 在没有 psql 的情况下创建数据库

如果 PostgreSQL 后端是最小化安装且缺少 `psql`，引擎会在服务器启动前使用 `postgres --single` 模式创建 `ferretdb` 数据库。这需要独占数据目录访问，因此必须在 `pg_ctl start` 之前运行。

## Docker E2E 测试说明

FerretDB Docker E2E 测试验证：
- 组合二进制文件下载
- 双进程启动（PostgreSQL 后端 + FerretDB 代理）
- MongoDB 协议操作
- 通过 PostgreSQL 工具进行备份/恢复

## CI/CD 说明

### Windows CI

FerretDB v2 CI 测试在 Windows runner 上跳过。v1 测试应在所有平台上运行。

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 FerretDB 二进制文件
  uses: actions/cache@v4
  with:
    path: |
      ~/.spindb/bin/ferretdb-*
      ~/.spindb/bin/postgresql-documentdb-*
      ~/.spindb/bin/postgresql-*
    key: ferretdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/ferretdb/version-maps.ts') }}
```

## 相关文档

- [plans/FERRETDB.md](../../plans/FERRETDB.md) - 原始实现计划（可能已过时）
- hostdb 发布: [ferretdb-2.7.0](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-2.7.0)（v2 代理）
- hostdb 发布: [ferretdb-1.24.2](https://github.com/robertjbass/hostdb/releases/tag/ferretdb-1.24.2)（v1 代理）
- hostdb 发布: [postgresql-documentdb-17-0.107.0](https://github.com/robertjbass/hostdb/releases/tag/postgresql-documentdb-17-0.107.0)（v2 后端）
