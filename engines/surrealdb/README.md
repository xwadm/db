# SurrealDB 引擎实现

## 概述

SurrealDB 是一款支持文档、图和关系范式的多模型数据库。它使用 SurrealQL（类 SQL 语法，支持图遍历）进行查询。

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
- **Unix (macOS/Linux)**: `tar.gz`
- **Windows**: `zip`

### 归档结构
```
surrealdb/
└── bin/
    └── surreal          # 统一二进制文件
```

### 版本映射同步

```typescript
export const SURREALDB_VERSION_MAP: Record<string, string> = {
  '2': '2.3.2',
}
```

## 实现细节

### 二进制管理器

SurrealDB 使用标准配置的 `BaseBinaryManager`。

### 版本解析

- **版本输出格式**: `surreal 2.3.2 for linux on x86_64` 或仅 `2.3.2`
- **解析模式**: `/(\d+\.\d+\.\d+)/`

### 默认配置

- **默认端口**: 8000（冲突时自动递增）
- **默认凭据**: `root` / `root`
- **存储后端**: SurrealKV (`surrealkv://路径`)
- **层级结构**: Root > Namespace > Database
- **PID 文件**: 容器目录中的 `surrealdb.pid`

### 命名空间派生

命名空间从容器名称派生：
- `my-app` -> 命名空间 `my_app`（连字符替换为下划线）
- 默认数据库: `test`

### 连接协议

- **WebSocket**: `ws://127.0.0.1:{端口}`（用于实时查询）
- **HTTP**: `http://127.0.0.1:{端口}`（REST API）

### 关键：后台进程 stdio 配置

与 CockroachDB 类似，**必须使用 `stdio: ['ignore', 'ignore', 'ignore']`**：

```typescript
const proc = spawn(surrealBinary, args, {
  stdio: ['ignore', 'ignore', 'ignore'],  // 不能使用 'pipe'
  detached: true,
  cwd: containerDir,  // 用于历史文件
  windowsHide: true,
})
proc.unref()
```

使用 `'pipe'` 会导致 Docker/CI 环境中进程挂起。

### 历史文件处理

SurrealDB 会将 `history.txt` 写入当前工作目录。引擎将 `cwd` 设置为容器目录，因此历史文件存储在 `~/.spindb/containers/surrealdb/<名称>/history.txt`，而不会污染用户的工作目录。

### 启动命令

```bash
surreal start \
  --bind 127.0.0.1:{端口} \
  --user root \
  --pass root \
  surrealkv://{数据目录}
```

### 健康检查

```bash
surreal isready --endpoint http://127.0.0.1:{端口}
```

### CLI Shell

```bash
surreal sql --endpoint ws://127.0.0.1:{端口}
```

### 脚本标志

在 `surreal sql` 命令中使用 `--hide-welcome` 可隐藏欢迎横幅，以获得适合脚本化/可解析的输出。引擎在非交互式命令中会自动使用此标志。

## 备份与恢复

### 备份方法

使用 SurrealDB 原生的导出/导入功能：
- `surreal export` - 创建 SurrealQL 脚本
- `surreal import` - 从 SurrealQL 脚本恢复

## 集成测试说明

### 测试固件

位于 `tests/fixtures/surrealdb/seeds/`：
- 用于测试的 SurrealQL 脚本

## Docker E2E 测试说明

SurrealDB Docker E2E 测试验证：
- 服务器生命周期
- SurrealQL 操作
- 多模型功能（如测试）
- 导出/导入

## 已知问题与注意事项

### 1. stdio 必须为 'ignore'

**关键**: 与 CockroachDB 相同 - 使用 `stdio: 'pipe'` 会导致挂起。始终使用 `['ignore', 'ignore', 'ignore']`。

### 2. 历史文件污染

如果不设置 `cwd`，SurrealDB 会将 `history.txt` 写入用户的工作目录。引擎会将 `cwd` 设置为容器目录。

### 3. 命名空间/数据库层级

SurrealDB 具有三级层级结构：
- Root（认证级别）
- Namespace（从容器名称派生）
- Database（默认: `test`）

这与大多数其他数据库不同。

### 4. WebSocket 与 HTTP

SurrealDB 同时支持 WebSocket (`ws://`) 和 HTTP (`http://`) 连接：
- WebSocket: 用于实时订阅
- HTTP: 用于 REST 风格请求

### 5. 多模型复杂性

SurrealDB 支持文档、图和关系模型。查询可以组合多种范式，这对新用户可能会造成困惑。

### 6. --hide-welcome 标志

在脚本中使用时，始终使用 `--hide-welcome` 来隐藏交互式欢迎横幅。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: 缓存 SurrealDB 二进制文件
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/surrealdb-*
    key: surrealdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/surrealdb/version-maps.ts') }}
```

## SurrealQL 快速参考

### 命名空间与数据库
```sql
USE NS my_namespace DB my_database;
```

### 记录操作
```sql
-- 创建
CREATE user:john SET name = 'John', age = 30;

-- 查询
SELECT * FROM user;

-- 更新
UPDATE user:john SET age = 31;

-- 删除
DELETE user:john;
```

### 图遍历
```sql
-- 创建关系
RELATE user:john->knows->user:jane;

-- 遍历
SELECT ->knows->user FROM user:john;
```

### 模式定义
```sql
DEFINE TABLE user SCHEMAFULL;
DEFINE FIELD name ON user TYPE string;
DEFINE FIELD age ON user TYPE int;
```
