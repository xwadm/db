# PostgreSQL 引擎实现

## 概述

PostgreSQL 是一种传统的 SQL 数据库，具有完整的服务器生命周期管理功能。SpinDB 从 hostdb 下载 PostgreSQL 二进制文件并在本地管理。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 使用 EDB 二进制文件（已上传至 hostdb） |

### Windows 二进制文件来源

Windows 上的 PostgreSQL 使用 [EnterpriseDB (EDB)](https://www.enterprisedb.com/download-postgresql-binaries) 二进制文件。这些文件从 EDB 的 CDN 下载并上传到 hostdb 以保持一致性。文件 ID 维护在 `edb-binary-urls.ts` 中。

## 二进制文件打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构
```
postgresql/
├── bin/
│   ├── postgres         # 主服务器二进制文件
│   ├── pg_ctl           # 服务器控制工具
│   ├── initdb           # 数据库集群初始化
│   ├── psql             # 交互式终端
│   ├── pg_dump          # 备份工具
│   ├── pg_restore       # 恢复工具
│   └── pg_basebackup    # 流式备份
└── lib/                 # 共享库
```

### 版本映射同步

`version-maps.ts` 文件必须与 hostdb 的 `releases.json` 保持同步：

```typescript
export const POSTGRESQL_VERSION_MAP: Record<string, string> = {
  '15': '15.x.x',
  '16': '16.x.x',
  '17': '17.x.x',
  '18': '18.x.x',
}
```

## 实现细节

### 二进制文件管理器

PostgreSQL 使用 `BaseServerBinaryManager` 并自定义 `verify()` 覆写用于版本解析。这是必要的，因为：

1. PostgreSQL 的版本输出在 EDB 和标准构建之间有所不同
2. 版本格式：`postgres (PostgreSQL) X.Y` 或 `postgres (PostgreSQL) X.Y - Percona Server for PostgreSQL X.Y.Z`

### 版本解析注意事项

- **去除末尾 .0**：如 `17.0` 等版本会被规范化以匹配 `17`
- **接受主版本号.次版本号匹配**：`18.1.0` 匹配请求的版本 `18.1`
- **EDB 格式处理**：EDB 二进制文件的版本输出可能包含额外的品牌信息

### 默认配置

- **默认端口**：5432（冲突时自动递增）
- **默认数据库**：名称由容器名称派生
- **PID 文件**：容器目录中的 `postmaster.pid`

### initdb 和 pg_ctl

PostgreSQL 使用两步初始化：
1. `initdb` 创建数据目录结构
2. `pg_ctl start` 以后台模式启动服务器

### 连接字符串格式

```
postgresql://127.0.0.1:{port}/{database}
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 备注 |
|--------|-----------|------|-------|
| sql | `.sql` | pg_dump | 纯文本 SQL，可移植 |
| custom | `.dump` | pg_dump -Fc | 二进制格式，支持并行恢复 |

### 恢复方式

- **SQL 格式**：通过 `psql -f` 恢复
- **自定义格式**：通过 `pg_restore` 恢复

## 集成测试说明

### 保留端口

集成测试使用保留端口以避免冲突：
- **测试端口**：5454-5456（非 5432）

### 测试数据

位于 `tests/fixtures/postgresql/seeds/`：
- `sample-db.sql`：包含 5 条 test_user 记录

## Docker 端到端测试说明

PostgreSQL 在 Docker 端到端测试中经过完整生命周期验证：
- 使用 `initdb` 创建容器
- 服务器启动/停止
- 数据库操作
- 备份和恢复
- 多数据库支持

## 已知问题与注意事项

### 1. Windows 二进制文件差异

Windows 使用 EDB 二进制文件，行为略有不同：
- 文件路径在内部使用 Windows 约定
- 某些环境变量有所不同

### 2. 端口冲突

当默认端口被占用时，SpinDB 会自动递增（5432 -> 5433 -> 以此类推）。

### 3. 连接终止

在删除数据库之前，必须终止活动连接。引擎使用：
```sql
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'dbname';
```

在不同平台上对 shell 命令中的单引号有特殊处理。

### 4. 孤立容器支持

如果 PostgreSQL 二进制文件在容器存在时被删除，启动这些容器将提示用户重新下载二进制文件。

## CI/CD 说明

### GitHub Actions 缓存步骤

PostgreSQL 二进制文件在 CI 中缓存以加速测试运行：
```yaml
- name: 缓存 PostgreSQL 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/postgresql-*
    key: postgresql-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/postgresql/version-maps.ts') }}
```
