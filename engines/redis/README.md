# Redis 引擎实现

## 概述

Redis 是一个支持持久化的内存键值存储。SpinDB 从 hostdb 下载 Redis 二进制文件，并通过 `redis-server` 和 `redis-cli` 对其进行管理。

## 平台支持

| 平台 | 架构 | 状态 | 说明 |
|----------|--------------|--------|-------|
| darwin | x64 | 已支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 已支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 已支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 已支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 已支持 | 使用 hostdb 二进制文件 |

## 二进制文件打包

### 归档格式
- **Unix（macOS/Linux）**: `tar.gz`
- **Windows**: `zip`

### 归档结构
```text
redis/
└── bin/
    ├── redis-server     # 服务器二进制文件
    ├── redis-cli        # 客户端 CLI
    ├── redis-benchmark  # 基准测试工具
    └── redis-check-*    # 诊断工具
```

### 版本映射表同步

```typescript
export const REDIS_VERSION_MAP: Record<string, string> = {
  '7': '7.4.7',
  '8': '8.4.0',
}
```

## 实现细节

### 二进制文件管理器

Redis 使用 `BaseBinaryManager` 配合标准的键值存储配置。

### 版本解析

- **版本输出格式**: `Redis server v=7.4.7 sha=00000000:0 malloc=jemalloc-5.3.0...`
- **解析模式**: `/v=(\d+\.\d+\.\d+)/` 然后回退到 `/(\d+\.\d+\.\d+)/`

### 默认配置

- **默认端口**: 6379（端口冲突时自动递增）
- **数据库数量**: 16 个编号数据库（0-15）
- **PID 文件**: 容器目录中的 `redis.pid`
- **持久化**: 默认启用 RDB 快照

### 生成的配置

SpinDB 生成包含以下内容的 `redis.conf`：
```
port {port}
bind 127.0.0.1
dir {dataDir}
daemonize yes     # Unix：使用原生守护进程化
logfile {logFile}
pidfile {pidFile}

# 持久化 — RDB 快照
save 900 1
save 300 10
save 60 10000
dbfilename dump.rdb

# 本地开发环境下禁用 AOF
appendonly no
```

### Windows 守护进程化替代方案

Windows 上的 Redis 不支持 `daemonize yes`。SpinDB 使用以下方案：
- `detached: true` spawn 选项
- `windowsHide: true` 隐藏控制台窗口
- 手动管理 PID 文件

### 连接字符串格式

```text
redis://127.0.0.1:{port}/{database}
```

其中 `{database}` 为 0-15。

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 工具 | 说明 |
|--------|-----------|------|-------|
| text | `.redis` | 自定义 RESP | 人类可读的命令 |
| rdb | `.rdb` | 原生 RDB | 二进制快照 |

### 文本格式（合并 vs 替换）

文本备份格式支持两种恢复模式：
- **合并（Merge）**: 添加键而不清除已有数据
- **替换（Flush）**: 恢复前先清空数据库

### RDB 格式

RDB 备份是原生的 Redis 快照。恢复时需要停止 Redis，替换 `dump.rdb`，然后重新启动。

## 数据库模型

Redis 使用编号数据库（0-15），而非命名数据库：
- `createDatabase()` 实际上是空操作（数据库始终存在）
- `dropDatabase()` 使用 `FLUSHDB` 清空该数据库中的所有键

## 集成测试说明

### 保留端口

集成测试使用保留端口：
- **测试端口**: 6399-6401（而非 6379）

### 测试夹具

位于 `tests/fixtures/redis/seeds/`：
- 用于测试的键值对

## Docker E2E 测试说明

Redis Docker E2E 测试验证：
- 服务器生命周期
- 键值操作
- RDB 和文本格式的备份/恢复
- 数据库切换（SELECT）

## 已知问题与注意事项

### 1. Windows 守护进程化

Redis 在 Windows 上不原生支持 `daemonize yes`。SpinDB 改用 detached spawn，并手动管理 PID 文件。

### 2. 数据库编号

Redis 数据库始终为 0-15。尝试使用超出此范围的编号将抛出错误。

### 3. 内存优先存储

Redis 主要是内存存储。大型数据集可能会消耗大量 RAM。RDB 快照会持久化到磁盘。

### 4. AOF 已禁用

在 SpinDB 中，仅追加文件（AOF）默认禁用，以简化本地开发。如需持久性保证，请在 `redis.conf` 中手动启用。

### 5. 优雅关闭

Redis 使用 `SHUTDOWN SAVE` 命令实现带数据持久化的优雅关闭。如果 CLI 失败，则会回退到 SIGTERM。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 Redis 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/redis-*
    key: redis-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/redis/version-maps.ts') }}
```