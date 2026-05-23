# InfluxDB 引擎实现

## 概述

InfluxDB 3.x 是一个用 Rust 重写的时间序列数据库。它使用 REST API 进行所有操作（无 CLI 客户端）。与早期版本使用 InfluxQL/Flux 不同，InfluxDB 3.x 通过其 HTTP API 支持 SQL 查询。

## 平台支持

| 平台 | 架构 | 状态 | 备注 |
|----------|--------------|--------|-------|
| darwin | x64 | 支持 | 使用 hostdb 二进制文件 |
| darwin | arm64 | 支持 | 使用 hostdb 二进制文件（Apple Silicon） |
| linux | x64 | 支持 | 使用 hostdb 二进制文件 |
| linux | arm64 | 支持 | 使用 hostdb 二进制文件 |
| win32 | x64 | 支持 | 使用 hostdb 二进制文件 |

## 二进制文件打包

### 压缩包格式
- **Unix（macOS/Linux）**：`tar.gz`
- **Windows**：`zip`

### 压缩包结构
```text
influxdb/
├── influxdb3           # 服务端二进制文件
├── python/             # 捆绑的 Python 运行时
│   └── lib/
│       └── libpython3.13.dylib
├── LICENSE-APACHE
└── LICENSE-MIT
```

### 二进制文件 + Python 运行时
InfluxDB 3.x 以单个 `influxdb3` 二进制文件形式发布，作为服务端运行，并捆绑了 Python 运行时。该二进制文件使用 `@executable_path/python/lib/libpython3.13.dylib`，因此 `python/` 目录必须与二进制文件位于同一目录。自定义的 `moveExtractedEntries` 重写确保两者都放置在 `bin/` 中。没有独立的 CLI 客户端 —— 所有交互都使用 REST API。

### 版本映射同步

```typescript
export const INFLUXDB_VERSION_MAP: Record<string, string> = {
  '3': '3.8.0',
}
```

## 实现细节

### 二进制文件管理器

InfluxDB 使用 `BaseBinaryManager`，因为它是基于服务端的引擎，使用单位数主版本号：

```typescript
class InfluxDBBinaryManager extends BaseBinaryManager {
  protected readonly config = {
    engine: Engine.InfluxDB,
    engineName: 'influxdb',
    displayName: 'InfluxDB',
    serverBinary: 'influxdb3',
  }
}
```

### REST API 引擎

InfluxDB 是一个 **REST API 引擎**：
- `spindb run` **不适用**（scriptFileLabel 为 `null`）
- `spindb connect` 在终端中打开健康端点信息
- 所有操作使用 HTTP REST API

### 默认配置

- **默认端口**：8086
- **健康检查端点**：`GET /health`
- **SQL 查询端点**：`POST /api/v3/query_sql`
- **写入端点**：`POST /api/v3/write_lp`
- **无认证**：InfluxDB 3.x 本地开发默认无认证
- **PID 文件**：容器目录中的 `influxdb.pid`

### 数据库创建

InfluxDB 3.x 在**首次写入时隐式创建数据库**。没有显式的 `CREATE DATABASE` 命令。当您使用数据库名称写入数据时，数据库会自动创建。

### 连接字符串格式

```text
http://127.0.0.1:{port}
```

## 备份与恢复

### 备份格式

| 格式 | 扩展名 | 方法 | 备注 |
|--------|-----------|--------|-------|
| sql | `.sql` | REST API | 包含 CREATE TABLE + INSERT 语句的 SQL 转储 |

### 备份方法

使用 InfluxDB 的 SQL 查询 API 导出数据：
1. `SHOW TABLES` — 列出所有表/度量
2. `SELECT * FROM {table}` — 按表导出所有数据
3. 生成 SQL INSERT 语句用于恢复

### 恢复方法

解析 SQL 转储文件并通过 `POST /api/v3/query_sql` 执行语句。

## 集成测试说明

### REST API 测试

集成测试使用 `fetch()` 与 InfluxDB REST API 交互。

### 测试固件

位于 `tests/fixtures/influxdb/seeds/`：
- `README.md` 记录了基于 API 的方法

## 已知问题与注意事项

### 1. 无 CLI 客户端

InfluxDB 3.x 没有捆绑的 CLI 客户端。所有操作使用 HTTP REST API。engine-defaults 中的 `clientTools` 数组为空。

### 2. 隐式数据库创建

数据库在首次写入时创建，而非通过显式命令。`createDatabase()` 验证服务器健康状态但不创建任何内容。

### 3. SQL 查询支持

InfluxDB 3.x 支持 SQL 查询（非 v1/v2 的 InfluxQL 或 Flux）。查询方式：
```bash
curl -X POST http://localhost:8086/api/v3/query_sql \
  -H "Content-Type: application/json" \
  -d '{"db":"mydb","q":"SELECT * FROM measurement","format":"json"}'
```

### 4. 通过行协议写入

数据写入使用 InfluxDB 行协议格式：
```bash
curl -X POST "http://localhost:8086/api/v3/write_lp?db=mydb" \
  -H "Content-Type: text/plain" \
  -d 'measurement,tag=value field=123'
```

### 5. Windows PID 处理

在 Windows 上，启动后使用 `platformService.findProcessByPort(port)` 查找真实 PID，与 QuestDB/TypeDB 模式类似。

## REST API 快速参考

### 健康检查
```bash
GET /health
```

### 查询（SQL）
```bash
POST /api/v3/query_sql
Content-Type: application/json
{"db":"mydb","q":"SELECT 1","format":"json"}
```

### 写入（行协议）
```bash
POST /api/v3/write_lp?db=mydb
Content-Type: text/plain
measurement,tag=value field=123
```

### 显示表
```bash
POST /api/v3/query_sql
{"db":"mydb","q":"SHOW TABLES","format":"json"}
```

### 列出数据库
```bash
GET /api/v3/configure/database?format=json
```
