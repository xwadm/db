# SpinDB
[![npm 版本](https://img.shields.io/npm/v/spindb.svg)](https://www.npmjs.com/package/spindb)
[![npm 下载量](https://img.shields.io/npm/dm/spindb.svg)](https://www.npmjs.com/package/spindb)
[![许可证：非商业PolyForm协议](https://img.shields.io/badge/License-PolyForm%20Noncommercial-blue.svg)](LICENSE)
[![支持平台：macOS | Linux | Windows](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#支持数据库引擎与平台)

**一站式命令行，管理所有本地数据库**

SpinDB 是通用型数据库管理工具，集成包管理器、统一调用接口与原生客户端工具，可管控21类数据库引擎，全程仅使用一套命令行操作。无需容器虚拟机、无需平台专属安装程序，数据库直接以原生进程运行在本机。

```bash
npm install -g spindb

# 为接口项目创建 PostgreSQL 数据库
spindb create api-db

# 数据分析使用 MongoDB
spindb create analytics --engine mongodb

# 缓存服务选用 Redis
spindb create cache --engine redis

# 多数据库并行运行，统一方式管控
```

---

## 支持数据库引擎与平台
适配21种数据库、5种系统架构，所有引擎共用一套操作指令

| 数据库引擎 | 类型 | 苹果ARM | 苹果Intel | Linux 64位 | Linux ARM | Windows |
|--------|------|:---------:|:-----------:|:---------:|:---------:|:-------:|
| 🐘 PostgreSQL | 关系型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐬 MySQL | 关系型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦭 MariaDB | 关系型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪶 SQLite | 嵌入式数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦆 DuckDB | 嵌入式分析数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🍃 MongoDB | 文档型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🦔 FerretDB | 文档型数据库 | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| 🔴 Redis | 键值数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔷 Valkey | 键值数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🏠 ClickHouse | 列式分析数据库 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 🧭 Qdrant | 向量检索数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔍 Meilisearch | 全文检索数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🛋️ CouchDB | 文档型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🪳 CockroachDB | 分布式数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🌀 SurrealDB | 多模型数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| ⏱️ QuestDB | 时序数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🤖 TypeDB | 知识图谱数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 📈 InfluxDB | 时序数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🔮 Weaviate | 向量数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 🐯 TigerBeetle | 金融记账数据库 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 📚 LibSQL | 嵌入式服务数据库 | ✅ | ✅ | ✅ | ✅ | ❌ |

**总计101种运行组合，单命令行即可管控，无需额外配置**

> Windows系统可通过WSL子系统使用ClickHouse、LibSQL；FerretDB 1版本可在Windows原生运行，2版本仅支持macOS与Linux

---

## 快速上手
```bash
# 全局安装
npm install -g spindb
# pnpm 安装方式（10及以上版本需先初始化）
# pnpm setup && pnpm add -g spindb

# 创建并启动PostgreSQL数据库，自动连接终端
spindb create myapp --start --connect
```

部署完成后，数据库默认监听 `localhost:5432`，数据持久化存放路径：`~/.spindb/containers/postgresql/myapp/`

---

## 基础使用示例
### PostgreSQL 操作
```bash
spindb create myapp                              # 创建数据库实例
spindb start myapp                               # 启动服务
spindb connect myapp                             # 进入数据库交互终端
spindb run myapp -c "SELECT version()"           # 执行单行SQL语句
spindb run myapp ./schema.sql                    # 运行本地SQL脚本
spindb backup myapp --format sql                 # 备份数据库
spindb url myapp --copy                          # 复制数据库连接地址
```

### MongoDB 操作
```bash
spindb create logs --engine mongodb --start
spindb run logs -c "db.users.insertOne({name: 'Alice'})"
spindb run logs -c "db.users.find().pretty()"
spindb connect logs                              # 进入Mongo交互命令行
spindb backup logs --format archive             # 归档格式备份
```

### Redis 操作
```bash
spindb create cache --engine redis --start
spindb run cache -c "SET mykey myvalue"
spindb run cache -c "GET mykey"
spindb connect cache                            # 进入Redis命令行
spindb connect cache --iredis                    # 增强版交互终端
```

### InfluxDB 时序数据库
```bash
spindb create tsdata --engine influxdb --start
spindb run tsdata ./seed.lp                      # 行协议格式导入数据
spindb run tsdata -c "SHOW TABLES"               # 执行查询语句
spindb run tsdata ./queries.sql                   # 批量执行SQL文件
spindb connect tsdata                             # 交互式查询控制台
```
> 支持两类文件：`.lp` 用于写入时序数据，`.sql` 用于数据查询

### Weaviate 向量数据库
```bash
spindb create vectors --engine weaviate --start
spindb query vectors "GET /v1/schema"             # 调用接口查询
spindb connect vectors                            # 打开网页管理面板
```
> AI专用向量数据库，默认8080端口提供REST接口，端口+1为gRPC接口，以集合类管理数据

### TigerBeetle 金融数据库
```bash
spindb create ledger --engine tigerbeetle --start
spindb connect ledger                            # 进入交互命令行
```
> 高性能账务数据库，采用私有二进制通信协议，仅支持命令行交互

### LibSQL 数据库
```bash
spindb create mydata --engine libsql --start
curl http://127.0.0.1:8080/health                 # 服务健康检测
spindb connect mydata                              # 查看接口访问地址
```
> 基于SQLite衍生的服务型数据库，通过HTTP协议提供数据访问

### 增强终端与可视化工具
```bash
spindb connect myapp --pgcli                     # PostgreSQL增强终端
spindb connect myapp --dblab                     # 终端可视化数据浏览
spindb connect mydb --mycli                      # MySQL增强命令行
spindb connect mydb --ui                         # DuckDB内置网页控制台
```

### 通用数据库指令
```bash
# 创建任意类型数据库
spindb create mydb --engine [数据库类型]
spindb start mydb
spindb connect mydb
spindb backup mydb
spindb restore mydb backup.dump
spindb clone mydb mydb-copy
spindb delete mydb -f

# 实例内数据库管理
spindb databases create mydb analytics          # 新建子数据库
spindb databases rename mydb 旧名 新名           # 数据库重命名
spindb databases drop mydb analytics --force    # 删除指定数据库
```

所有数据库操作逻辑统一，掌握一套命令即可适配全部引擎
完整命令速查表、连接格式、备份规范可参考：[CHEATSHEET.md](CHEATSHEET.md)

---

## 工具优势
### 现有方案痛点
- **Docker容器**：占用资源高，后台常驻进程，虚拟机模式运行，简易本地数据库场景冗余复杂
- **图形化工具**：仅适配单一系统，无法脚本自动化操作，不同数据库操作逻辑割裂
- **系统包管理器**：极易产生版本冲突，手动配置繁琐，多数据库无统一管理方式

### SpinDB 实现方案
数据库以**原生进程**运行，数据目录相互隔离
- 无容器虚拟机开销，直接本地进程调度
- 版本独立存放，不会干扰系统原有程序
- 开箱即用，默认配置满足开发需求
- 跨平台指令完全一致，多系统无缝切换
- 多版本共存，可同时运行新旧数据库版本
- 统一操作语法，各类数据库管理方式通用

### 图形数据库工具对比
| 功能 | SpinDB | DBngin | Postgres.app | Laragon |
|---------|--------|--------|--------------|---------|
| 支持引擎数量 | 21种 | 3种 | 1种 | 4种 |
| 命令行主导 | ✅ | ❌仅图形界面 | ❌仅图形界面 | ⚠️简易命令 |
| 多版本运行 | ✅ | ✅ | ✅ | ✅ |
| 自带备份还原 | ✅ | ✅ | ❌ | ⚠️手动操作 |
| 数据库克隆 | ✅ | ✅ | ❌ | ❌ |
| macOS适配 | ✅ | ✅ | ✅ | ❌ |
| Linux适配 | ✅ | ❌ | ❌ | ❌ |
| Windows适配 | ✅ | ❌ | ❌ | ✅ |
| 商业免费使用 | ❌ | ✅ | ✅ | ✅ |

### 容器虚拟化工具对比
| 功能 | SpinDB | Docker桌面版 | Podman | OrbStack |
|---------|--------|----------------|--------|----------|
| 支持引擎 | 21种统一管控 | 自定义搭建 | 自定义搭建 | 自定义搭建 |
| 依赖后台服务 | ❌ | ✅ | ❌无根模式 | ✅ |
| 资源占用 | 原生级别 | 虚拟机+容器 | 虚拟机+容器 | 虚拟机+容器 |
| 内置备份功能 | ✅ | ❌手动配置 | ❌手动配置 | ❌手动配置 |
| 自动生成连接地址 | ✅ | ❌手动填写 | ❌手动填写 | ❌手动填写 |
| 快速切换版本 | ✅即时切换 | ⚠️拉取镜像 | ⚠️拉取镜像 | ⚠️拉取镜像 |
| 自带专属客户端 | ✅内置 | ❌进入容器调用 | ❌进入容器调用 | ❌进入容器调用 |
| 生产环境一致性 | ⚠️原生程序 | ✅镜像完全一致 | ✅镜像完全一致 | ✅镜像完全一致 |
| 商业免费使用 | ❌ | ⚠️企业付费 | ✅ | ⚠️分级收费 |

### 系统包管理器对比
| 功能 | SpinDB | Homebrew | apt/winget | asdf版本管理器 |
|---------|--------|----------|------------|---------|
| 支持引擎 | 21种统一管理 | 分类单独安装 | 分类单独安装 | 插件扩展支持 |
| 多版本并行 | ✅ | ⚠️配置复杂 | ❌ | ✅ |
| 数据目录隔离 | ✅ | ❌全局共用 | ❌全局共用 | ❌全局共用 |
| 内置备份工具 | ✅ | ❌ | ❌ | ❌ |
| 跨引擎统一命令 | ✅ | ❌ | ❌ | ❌ |
| 无需管理员权限 | ✅ | ✅ | ❌ | ✅ |
| macOS适配 | ✅ | ✅ | ❌ | ✅ |
| Linux适配 | ✅ | ✅ | ✅ | ✅ |
| Windows适配 | ✅ | ❌ | ✅ | ⚠️子系统运行 |
| 商业免费使用 | ❌ | ✅ | ✅ | ✅ |

> 许可说明：商业项目使用需单独授权；个人项目、教育学习、科研、非营利组织、政府机构可免费使用

---

## 运行原理
工具借用容器概念，实际不依赖Docker技术，创建数据库实例流程：
1. **版本匹配**：依托内置`hostdb`包解析数据库版本，本地离线判定版本号，固定版本不会随意变更
2. **程序下载**：从镜像服务器获取对应系统架构的数据库可执行文件
3. **目录隔离**：在独立文件夹存放对应数据库的数据与配置
4. **进程启动**：以本机原生进程方式运行数据库服务

实例会锁定具体小版本号，升级工具不会自动变更数据库程序，保障数据稳定；可执行检测命令查看版本差异，一键修复版本适配问题。

### 目录结构
```bash
~/.spindb/
├── bin/                                    # 已下载的数据库程序
├── containers/                             # 数据库实例数据
│   ├── postgresql/
│   ├── mysql/
│   └── mongodb/
├── logs/                                   # 程序运行日志
└── config.json                             # 全局配置文件

# SQLite、DuckDB 文件型数据库存放于项目目录
./myproject/
└── app.sqlite
```

### 数据持久化
数据库进程重启后数据不会丢失，仅手动执行删除命令才会清空数据。

### 导出为Docker镜像
本地开发无需容器，可一键打包数据库用于线上部署
```bash
spindb export docker mydb -o ./deploy
cd ./deploy && docker compose build --no-cache && docker compose up -d
```
详细部署文档参考：[DEPLOY.md](DEPLOY.md)

---

## 使用限制
- 默认仅本地访问，绑定127.0.0.1地址，可指令关联远程数据库
- ClickHouse、LibSQL 暂无Windows原生程序，可借助WSL运行
- FerretDB 2版本不支持Windows系统
- Qdrant、检索类数据库仅支持接口访问，无本地命令行终端
- TigerBeetle仅私有协议交互，不支持SQL语句与接口调用

---

## 问题排查
### 端口占用
```bash
spindb create mydb --port 5433
```

### 查看启动报错
```bash
spindb logs mydb
```

### 修复依赖组件
```bash
spindb deps install
spindb deps check
```

### 全局健康检测
```bash
spindb doctor          # 交互式检测
spindb doctor --fix    # 自动修复异常
```

### 重置全部数据
```bash
rm -rf ~/.spindb
```
该操作清空所有数据库与配置，谨慎执行

---

## 开发规划
详情查阅 [TODO.md](TODO.md)

---

## 适用场景
### 数据迁移跨平台
云端数据库迁移、多设备数据同步、MongoDB适配FerretDB改造测试

### 日常开发调试
多版本数据库兼容性测试、代码分支对应独立数据库、线上数据本地复刻、快速搭建项目原型

### 自动化测试
临时测试数据库、数据库迁移校验、多维度数据统计验证

### 补齐平台短板
获取Windows官方未发布的Redis程序、简化macOS部署ClickHouse流程

### 程序集成嵌入
AI大模型对接数据库、向量检索与数据分析组合开发、桌面软件内嵌数据库服务

### 项目部署上线
本地打包发布镜像、生产数据脱敏开发、灾备恢复演练

### 基础设施搭建
无差别数据库后端平台、跨平台可视化管理软件、团队统一开发环境

---

## 参与开发
技术栈：Node.js18+、TypeScript、tsx、pnpm、Commander命令框架
开发环境、提审规范、新增引擎标准可查阅项目内说明文档

---

## 致谢
项目基于开源库 [hostdb](https://github.com/robertjbass/hostdb) 开发，提供全平台预编译数据库程序，实现无容器多版本数据库运行

---

## 开源许可
遵循 **PolyForm Noncommercial 1.0.0** 协议
个人爱好、教学科研、公益机构均可免费使用；企业商业用途必须申请商用授权

---

## 相关链接
- GitHub仓库：[github.com/robertjbass/spindb](https://github.com/robertjbass/spindb)
- npm包地址：[npmjs.com/package/spindb](https://www.npmjs.com/package/spindb)
- 依赖库：[hostdb](https://github.com/robertjbass/hostdb)
- 问题反馈：[github.com/robertjbass/spindb/issues](https://github.com/robertjbass/spindb/issues)

有疑问、漏洞反馈或功能建议，均可提交项目Issue