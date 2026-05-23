# QuestDB 引擎实现

## 概述

QuestDB 是一个高性能时序数据库，通过 PostgreSQL 线协议提供 SQL 支持。它是一个基于 Java 的数据库，附带捆绑的 JRE，是管理起来较为复杂的引擎之一。

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
- **Unix（macOS/Linux）**: `tar.gz`
- **Windows**: `zip`

### 归档结构 - 平台差异

**macOS:**
```
questdb/
├── questdb.sh           # 启动脚本（位于根目录，不在 bin/ 下）
├── questdb.jar          # 主应用程序
├── lib/                 # 依赖库
└── jre/                 # 捆绑的 JRE
    └── bin/
        └── java
```

**Linux:**
```
questdb/
├── bin/
│   └── questdb.sh       # 启动脚本（位于 bin/ 下）
├── lib/
│   └── jvm/             # JRE 位于不同位置
│       └── */bin/java
└── questdb.jar
```

**Windows:**
```
questdb/
├── questdb.exe          # Windows 可执行文件
├── questdb.jar
├── lib/
└── jre/
```

### 启动脚本位置因平台而异

二进制管理器会同时检查根目录和 `bin/` 子目录中的 `questdb.sh`/`questdb.exe`：

```typescript
// 检查两个位置
const shPathRoot = join(binPath, 'questdb.sh')
const shPathBin = join(binPath, 'bin', 'questdb.sh')
```

### 自定义 moveExtractedEntries

QuestDB 有自定义的 `moveExtractedEntries()` 来保留其独特的目录结构——它不会像其他引擎那样将 `questdb.sh` 移动到 `bin/`。

### 版本映射同步

```typescript
export const QUESTDB_VERSION_MAP: Record<string, string> = {
  '9': '9.2.3',
}
```

## 实现细节

### 二进制管理器

QuestDB 使用 `BaseBinaryManager` 并进行了大量自定义：
- `isInstalled()` - 同时检查根目录和 bin/ 位置
- `moveExtractedEntries()` - 保留 QuestDB 的目录结构
- `postExtract()` - 设置脚本可执行权限，创建 java 符号链接
- `verify()` - 自定义验证（没有 --version 标志）

### 基于 Java 的架构

QuestDB 是一个附带捆绑 JRE 的 Java 应用程序：
- 无需安装 Java
- JRE 包含在下载中
- 通过 shell 脚本（Unix）或 exe（Windows）启动

### 解压后设置

`postExtract()` 方法：
1. 将 `questdb.sh` 设置为可执行（`chmod 755`）
2. 创建符号链接: `java` -> `jre/bin/java`（macOS）

该符号链接是必需的，因为 `questdb.sh` 会检查 `$BASE/java` 来判断是否捆绑了 JRE。

### 多端口配置 - 关键

QuestDB 每个容器使用**四个端口**：

| 端口 | 偏移量 | 默认值 | 用途 |
|------|--------|---------|---------|
| PostgreSQL 线协议 | 基础端口 | 8812 | 通过 psql 进行 SQL 连接 |
| HTTP Web 控制台 | +188 | 9000 | REST API 和 Web UI |
| HTTP Min 服务器 | +191 | 9003 | 健康检查/指标 |
| ILP TCP | +197 | 9009 | InfluxDB 行协议 |

**多容器冲突**：运行多个 QuestDB 容器时，所有端口必须通过环境变量进行唯一配置：
- `QDB_PG_NET_BIND_TO`
- `QDB_HTTP_BIND_TO`
- `QDB_HTTP_MIN_NET_BIND_TO`
- `QDB_LINE_TCP_NET_BIND_TO`

如果未按容器配置，HTTP Min 服务器（默认 9003）会导致冲突。

### PID 处理 - Shell 脚本问题

**关键注意事项**：启动 `questdb.sh start` 时，shell 脚本会 fork Java 进程然后立即退出。`proc.pid` 获取的是 shell 的 PID，该 PID 在几毫秒内就会失效。

QuestDB 在守护进程模式下也不会创建自己的 PID 文件。

**解决方案**：启动后，通过端口查找实际的 Java 进程：

```typescript
// waitForReady() 成功后：
const pids = await platformService.findProcessByPort(port)
if (pids.length > 0) {
  await writeFile(pidFile, pids[0].toString(), 'utf-8')
}
```

停止时也优先使用端口查找，回退到 PID 文件。

### 默认配置

- **默认 PG 端口**: 8812（冲突时自动递增）
- **HTTP 端口**: PG 端口 + 188（默认 9000）
- **默认数据库**: `qdb`（单数据库模型）
- **默认凭据**: `admin` / `quest`
- **日志文件**: 容器目录中的 `questdb.log`
- **配置文件**: `conf/` 子目录中的 `server.conf`

### 连接字符串格式

```
postgresql://admin:quest@127.0.0.1:{port}/qdb
```

使用 PostgreSQL 线协议。

### 健康检查

通过 HTTP GET 访问 Web 控制台：
```bash
curl http://127.0.0.1:{httpPort}/
```

或通过 psql（如果可用）：
```bash
psql -h 127.0.0.1 -p {port} -U admin -d qdb -c "SELECT 1;"
```

### 关键：后台进程标准输入输出

与 CockroachDB 和 SurrealDB 一样，**必须使用 `stdio: ['ignore', 'ignore', 'ignore']`**：

```typescript
const proc = spawn(questdbBinary, args, {
  stdio: ['ignore', 'ignore', 'ignore'],
  detached: true,
  cwd: containerDir,
  env: {
    QDB_HTTP_BIND_TO: `0.0.0.0:${httpPort}`,
    QDB_HTTP_MIN_NET_BIND_TO: `0.0.0.0:${port + 191}`,
    QDB_PG_NET_BIND_TO: `0.0.0.0:${port}`,
    QDB_LINE_TCP_NET_BIND_TO: `0.0.0.0:${port + 197}`,
  },
  windowsHide: true,
})
proc.unref()
```

### 启动命令

**Unix:**
```bash
questdb.sh start -d {dataDir} -t {name} -n
```

**Windows:**
```bash
questdb.exe -d {dataDir} -t {name}
```

注意：Windows 不支持可靠的 'start' 子命令。

`-t {name}` 标志是进程标签——允许通过唯一标识符运行多个实例。

## 备份与恢复

### 跨引擎依赖

**关键**：QuestDB 的备份/恢复需要 PostgreSQL 的 `psql` 二进制文件通过线协议进行连接。

```typescript
// 从 SpinDB 的 PostgreSQL 引擎查找 psql
let psqlPath = await configManager.getBinaryPath('psql')
```

**警告**：删除 PostgreSQL 会导致 QuestDB 的备份/恢复功能失效！

这与 FerretDB 的 postgresql-documentdb 依赖不同，后者会随 FerretDB 一起删除。PostgreSQL 是独立引擎，因此会保留。

### 时间戳列

QuestDB 表有一个指定的时间戳列，可以有任何名称。不要假设为 `timestamp`——应查询 `tables()` 获取 `designatedTimestamp` 列名。

## Web 控制台

QuestDB 内置 Web 控制台，地址为：
```
http://localhost:{httpPort}/
```

其中 `httpPort = pgPort + 188`（默认 9000）。

## 集成测试说明

### psql 依赖

集成测试需要 `psql` 可用（来自 PostgreSQL 引擎）。

### 测试数据

位于 `tests/fixtures/questdb/seeds/`：
- 用于时序测试的 SQL 数据

## Docker 端到端测试说明

QuestDB Docker 端到端测试验证：
- 多端口启动
- PostgreSQL 线协议
- HTTP Web 控制台
- 时序操作

### Windows 扩展超时

Windows 需要更多时间让 Java 启动并释放文件锁：
- 启动超时: 90000ms（Unix 上为 60000ms）
- 优雅关闭等待: 5000ms（Unix 上为 2000ms）

## 已知问题与注意事项

### 1. Shell 脚本 PID 无效

`questdb.sh` 会 fork 后退出。必须通过端口查找 Java 进程。

### 2. 需要四个端口

每个容器需要四个唯一端口。HTTP Min 服务器（端口 +191）经常被遗忘。

### 3. psql 依赖

备份/恢复需要 PostgreSQL 的 psql 二进制文件。请告知用户此跨引擎依赖。

### 4. stdio 必须设为 'ignore'

与 CockroachDB/SurrealDB 相同——防止 Node.js 挂起。

### 5. 归档结构因平台而异

macOS 的 `questdb.sh` 在根目录，Linux 的在 `bin/`。二进制管理器会处理两种情况。

### 6. 没有 --version 标志

QuestDB 基于 Java。验证检查脚本/jar 是否存在，而非版本输出。

### 7. 单数据库模型

QuestDB 使用单个数据库（`qdb`）。"createDatabase" 实际上是空操作。

### 8. Java 符号链接（macOS）

根目录下的 `java` 符号链接是 `questdb.sh` 找到捆绑 JRE 所必需的。

## CI/CD 说明

### GitHub Actions 缓存步骤

```yaml
- name: Cache QuestDB binaries
  uses: actions/cache@v4
  with:
    path: ~/.spindb/bin/questdb-*
    key: questdb-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('engines/questdb/version-maps.ts') }}
```

### Windows CI 注意事项

由于 Java 启动时间较长，Windows 测试使用扩展超时。

## 时序 SQL 示例

### 创建表
```sql
CREATE TABLE sensors (
  timestamp TIMESTAMP,
  sensor_id SYMBOL,
  value DOUBLE
) TIMESTAMP(timestamp) PARTITION BY DAY;
```

### 插入数据
```sql
INSERT INTO sensors VALUES (now(), 'sensor1', 23.5);
```

### 基于时间的查询
```sql
-- 最近一小时
SELECT * FROM sensors WHERE timestamp > now() - 1h;

-- 按 1 分钟采样
SELECT timestamp, avg(value) FROM sensors SAMPLE BY 1m;

-- 每个传感器的最新值
SELECT * FROM sensors LATEST ON timestamp PARTITION BY sensor_id;
```
