# TigerBeetle 引擎实现

## 概述

TigerBeetle 是一个用 Zig 编写的高性能金融账本数据库，使用自定义二进制协议（非 REST，非 SQL）。

## 平台支持

| 平台   | 架构   | 状态   | 说明                     |
| ------ | ------ | ------ | ------------------------ |
| darwin | x64    | 支持   | 使用 hostdb 二进制文件   |
| darwin | arm64  | 支持   | 使用 hostdb 二进制文件（Apple Silicon） |
| linux  | x64    | 支持   | 使用 hostdb 二进制文件   |
| linux  | arm64  | 支持   | 使用 hostdb 二进制文件   |
| win32  | x64    | 支持   | 使用 hostdb 二进制文件   |

## 二进制打包

### 归档格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 归档结构
```
tigerbeetle/
└── bin/
    └── tigerbeetle      # 统一二进制文件
```

### 版本映射同步

```typescript
export const TIGERBEETLE_VERSION_MAP: Record<string, string> = {
  '0.16': '0.16.70',
}
```

## 实现细节

### 二进制管理器

TigerBeetle 使用 `BaseBinaryManager`，并进行了以下定制：
- `verify()` — 使用 `tigerbeetle version` 子命令（非 `--version`）

### 版本解析

- **版本输出格式**：`TigerBeetle v0.16.70` 或仅 `0.16.70`
- **解析模式**：`/(?:TigerBeetle\s+)?v?(\d+\.\d+\.\d+)/`

### 默认配置

- **默认端口**：3000（冲突时自动递增）
- **无认证**：TigerBeetle 没有用户/密码概念
- **无多数据库**：每个容器是单个账本实例
- **存储**：单个数据文件 `0_0.tigerbeetle`
- **PID 文件**：容器目录中的 `tigerbeetle.pid`

### 两步初始化

TigerBeetle 需要显式格式化步骤：

```bash
# 1. 格式化数据文件（预分配 ~1GB）
tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development data/0_0.tigerbeetle

# 2. 启动服务器
tigerbeetle start --addresses=127.0.0.1:3000 --development data/0_0.tigerbeetle
```

### 开发模式

始终使用 `--development` 标志进行本地开发：
- 减小缓存/批处理大小
- 禁用生产级断言
- **注意**：仍然预分配 ~1GB 数据文件

### 集群 ID

使用集群 ID `0` 进行单节点开发：
```typescript
const DEFAULT_CLUSTER_ID = 0
```

### 健康检查

TigerBeetle 没有 HTTP 健康端点。使用以下方式：
- **PID 文件检查**：验证进程是否正在运行
- **端口检查**：TCP 连接测试
- **无 HTTP**：无法使用 HTTP 健康检查

### 关键：日志文件重定向

TigerBeetle 在前台运行并记录到 stdout/stderr。引擎将输出重定向到日志文件：

```typescript
const logFd = openSync(logFile, 'a')
const proc = spawn(tigerbeetleBinary, args, {
  stdio: ['ignore', logFd, logFd],
  detached: true,
})
```

### 启动命令

```bash
tigerbeetle start \
  --addresses=127.0.0.1:3000 \
  --development \
  data/0_0.tigerbeetle
```

### 停止行为

SIGTERM 是安全的 —— TigerBeetle 通过设计优雅地处理突然关闭。

## 备份与恢复

### 备份方法

**停机复制**：TigerBeetle 必须在备份前停止：
1. 停止服务器
2. 复制 `0_0.tigerbeetle` 数据文件
3. 启动服务器

### 恢复方法

**停机恢复**：TigerBeetle 必须在恢复前停止：
1. 停止服务器
2. 用备份替换 `0_0.tigerbeetle`
3. 启动服务器

### 数据文件大小

TigerBeetle 数据文件预分配约 1GB，即使使用 `--development` 标志也是如此。

## 集成测试说明

### 测试装置

位于 `tests/fixtures/tigerbeetle/seeds/`：
- 二进制数据文件用于测试

### 超时考虑

- **格式化**：在慢速 CI 运行器上可能需要 >30 秒
- **启动**：由于数据文件分配，冷启动较慢

## Docker E2E 测试说明

TigerBeetle Docker E2E 测试验证：
- 服务器生命周期
- 数据文件格式化
- 停机备份/恢复
- REPL 连接

### Docker 权限

TigerBeetle 需要 io_uring 系统调用。如果被 Docker 的 seccomp 配置文件阻止：

```bash
docker run --security-opt seccomp=unconfined ...
```

## 已知问题与注意事项

### 1. 无 HTTP 端点

TigerBeetle 使用自定义二进制协议。没有 HTTP 健康检查或 REST API。

### 2. 无 SQL 支持

TigerBeetle 不是 SQL 数据库。使用 `tigerbeetle repl` 进行交互操作。

### 3. 停机备份

必须在备份或恢复前停止服务器。无法对运行中的实例进行热备份。

### 4. 大数据文件

数据文件预分配约 1GB。备份很大，恢复需要时间。

### 5. 无认证

TigerBeetle 没有用户/密码概念。访问在网络级别控制。

### 6. 单数据库

每个容器是一个独立的账本实例。不支持多数据库。

### 7. io_uring 要求

TigerBeetle 需要 io_uring 系统调用。某些 Docker 配置可能会阻止这些调用。

### 8. 开发模式标志

始终使用 `--development` 进行本地开发。生产模式有不同的性能特征。

### 9. 集群 ID 要求

所有命令（format、start、repl）都需要 `--cluster` 标志。

### 10. 版本子命令

TigerBeetle 使用 `tigerbeetle version`（子命令），而非 `--version` 标志。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 TigerBeetle 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/tigerbeetle-*
    key: tigerbeetle-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/tigerbeetle/version-maps.ts') }}
```

### Docker 安全配置

如果 CI 在 Docker 中运行，可能需要：
```yaml
--security-opt seccomp=unconfined
```

## TigerBeetle REPL 快速参考

### 启动 REPL
```bash
tigerbeetle repl --cluster=0 --addresses=3000
```

### 创建账户
```
> create_accounts id=1 code=10 ledger=700 flags=0;
```

### 创建转账
```
> create_transfers id=1 debit_account_id=1 credit_account_id=2 amount=100 ledger=700 code=10;
```

### 查询账户
```
> lookup_accounts id=1;
```

### 查询转账
```
> lookup_transfers id=1;
```

## 架构说明

### 自定义协议

TigerBeetle 使用自定义二进制协议：
- **非 REST**：无 HTTP 端点
- **非 SQL**：无 SQL 查询
- **二进制**：高效的网络协议

### 账本模型

TigerBeetle 使用双条目会计模型：
- **账户**：有余额的实体
- **转账**：账户之间的资金流动
- **账本**：隔离的会计边界

### 复制

TigerBeetle 支持 Raft 复制：
- **集群**：复制组
- **副本**：集群中的单个节点
- **开发模式**：单副本（`--replica-count=1`）
