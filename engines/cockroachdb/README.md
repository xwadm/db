# CockroachDB 引擎

CockroachDB 引擎通过 SpinDB CLI 提供分布式 SQL 数据库功能。

## 平台支持

| 平台 | 支持情况 | 备注 |
|----------|---------|--------|
| macOS (arm64) | 支持 |  |
| macOS (x64) | 不支持 | 上游未提供 macOS x64 的二进制文件。 |
| Windows (x64) | 支持 | 支持独立服务器。 |
| Linux (arm64) | 不支持 | 上游未提供 Linux arm64 的二进制文件。 |
| Linux (x64) | 支持 |  |

## 协议

该模块当前使用 `hostdb` 消费 CockroachDB 二进制文件。

`hostdb` 是一个由 Robert Bass（SpinDB 的创建者）维护的 npm 包。它为 `spindb` 支持的每个数据库引擎发布独立打包的二进制文件。CockroachDB 二进制文件托管在 GitHub 上，版本号遵循 CockroachDB 官方的语义化版本格式（major.minor.patch，例如 `25.4.2`）。

#### 支持的 CockroachDB 版本

* 25.4.x（稳定版 — 当前推荐版本）
* 25.1.x（旧版 — 不推荐使用）

有关详细信息，请参阅 [hostdb README](https://github.com/robertjbass/hostdb#readme)。

### 二进制文件缓存

下载的二进制文件会缓存到 `~/.spindb/binary-cache/`（Windows 上为 `%USERPROFILE%/.spindb/binary-cache/`），并在引擎间共享。二进制文件解压到版本和平台特定的目录中，例如：

```
~/.spindb/binary-cache/
├── cockroachdb/
│   └── 25.4.2/
│       ├── darwin-arm64/
│       │   └── bin/
│       │       └── cockroach
│       ├── linux-x64/
│       │   └── bin/
│       │       └── cockroach
│       └── win32-x64/
│           └── bin/
│               └── cockroach.exe
...
```

### 版本解析

通过 `version-maps.ts` 中的 `COCKROACHDB_VERSION_MAP` 将简写版本（如 `25`）映射为完整的补丁版本。

## 配置

运行 `spindb start cockroachdb` 时，默认配置如下：

### 默认设置

| 参数 | 默认值 | 备注 |
|-----------|---------|-------|
| 端口 | 26257 | PostgreSQL 通信协议端口 |
| HTTP 端口 | 26258 | Web 管理界面（端口 + 1） |
| 数据库 | defaultdb | 初始数据库 |
| 用户 | root | 通过生成的客户端证书认证的管理员用户 |
| SSL/TLS | 已启用 | 为每个容器自动生成的证书 |
| 存储 | ~/.spindb/containers/<名称>/data | 每个容器独立的 RocksDB 存储 |

### 启动

```bash
spindb start cockroachdb
spindb start cockroachdb --port 30000
```

### 停止

```bash
spindb stop cockroachdb
```

### 连接

```bash
spindb connect cockroachdb
spindb connect cockroachdb --database testdb
```

与 CockroachDB 默认行为不同，本地 spindb 容器以安全模式启动。

## 备份与恢复

CockroachDB 引擎使用基于 SQL 的备份，将 DDL 和 INSERT 语句导出到 `.sql` 文件。这些文件可移植、人类可读，并且兼容标准 PostgreSQL 和 CockroachDB SQL 客户端。

### 创建备份

```bash
spindb backup cockroachdb --output ./backups/2024-01-15.sql
```

### 从备份恢复

```bash
spindb restore cockroachdb ./backups/2024-01-15.sql
spindb restore cockroachdb ./backups/2024-01-15.sql --clean  # 恢复前先删除已有表
```

### 自定义备份脚本

导出的 `.sql` 文件可以使用标准 `cockroach sql` 进行恢复：

```bash
cockroach sql --certs-dir ~/.spindb/containers/<名称>/certs --host 127.0.0.1:26257 --database defaultdb -f backup.sql
```

数据库也可通过以下方式恢复：

```bash
psql 'postgresql://root@127.0.0.1:26257?sslmode=verify-full&sslrootcert=~/.spindb/containers/<名称>/certs/ca.crt' -f backup.sql
```

## 已知问题

### 启动失败（"This Server ID does not exist"）

如果在未彻底停止的 CockroachDB 实例后启动失败，重启计算机或手动清理数据目录能可靠地解决此问题。

## 另见

* [CLI 工具类](../cli-utils.ts) — 连接字符串构建和标识符转义
* [备份模块](../backup.ts) — 基于 SQL 的备份实现
* [恢复模块](../restore.ts) — 基于 SQL 的恢复实现（含干净模式）
* [二进制文件管理器](../binary-manager.ts) — 二进制文件的下载和缓存
* [发行版](../hostdb-releases.ts) — hostdb 发行版获取
* [版本映射](../version-maps.ts) — 版本别名解析
* [二进制文件 URL](../binary-urls.ts) — hostdb URL 构建