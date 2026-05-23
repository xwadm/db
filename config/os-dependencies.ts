/**
 * 数据库引擎的操作系统级依赖注册表
 *
 * 本模块定义了每个数据库引擎在不同操作系统和包管理器下所需的系统软件包。
 */

import { getPostgresHomebrewPackage } from './engine-defaults'

export type PackageManagerId =
  | 'brew'
  | 'apt'
  | 'yum'
  | 'dnf'
  | 'pacman'
  | 'choco'
  | 'winget'
  | 'scoop'

export type Platform = 'darwin' | 'linux' | 'win32'

// 特定包管理器的软件包定义
export type PackageDefinition = {
  // 要安装的软件包名称
  package: string
  // 可选的安装后命令（例如 brew link）
  postInstall?: string[]
  // 可选的安装前命令
  preInstall?: string[]
}

// 单个依赖项（例如 psql、pg_dump）
export type Dependency = {
  // 人类可读的名称
  name: string
  // 要在 PATH 中检查的二进制文件名称
  binary: string
  // 描述该工具的功能
  description: string
  // 每种包管理器的软件包定义
  packages: Partial<Record<PackageManagerId, PackageDefinition>>
  // 当没有可用的包管理器时的替代安装说明
  manualInstall: Partial<Record<Platform, string[]>>
}

// 引擎依赖配置
export type EngineDependencies = {
  // 引擎标识符
  engine: string
  // 人类可读的引擎名称
  displayName: string
  // 该引擎的依赖项列表
  dependencies: Dependency[]
}

// 包管理器配置
export type PackageManagerConfig = {
  id: PackageManagerId
  name: string
  // 用于检查此包管理器是否已安装的命令
  checkCommand: string
  // 此包管理器可用的平台
  platforms: Platform[]
  // 安装软件包的命令模板
  installTemplate: string
  // 更新/升级软件包的命令模板
  updateTemplate: string
}

// =============================================================================
// 包管理器定义
// =============================================================================

export const packageManagers: PackageManagerConfig[] = [
  {
    id: 'brew',
    name: 'Homebrew',
    checkCommand: 'brew --version',
    platforms: ['darwin'],
    installTemplate: 'brew install {package}',
    updateTemplate: 'brew upgrade {package}',
  },
  {
    id: 'apt',
    name: 'APT',
    checkCommand: 'apt --version',
    platforms: ['linux'],
    installTemplate: 'sudo apt update && sudo apt install -y {package}',
    updateTemplate: 'sudo apt update && sudo apt upgrade -y {package}',
  },
  {
    id: 'yum',
    name: 'YUM',
    checkCommand: 'yum --version',
    platforms: ['linux'],
    installTemplate: 'sudo yum install -y {package}',
    updateTemplate: 'sudo yum update -y {package}',
  },
  {
    id: 'dnf',
    name: 'DNF',
    checkCommand: 'dnf --version',
    platforms: ['linux'],
    installTemplate: 'sudo dnf install -y {package}',
    updateTemplate: 'sudo dnf upgrade -y {package}',
  },
  {
    id: 'pacman',
    name: 'Pacman',
    checkCommand: 'pacman --version',
    platforms: ['linux'],
    installTemplate: 'sudo pacman -S --noconfirm {package}',
    updateTemplate: 'sudo pacman -Syu --noconfirm {package}',
  },
  {
    id: 'choco',
    name: 'Chocolatey',
    checkCommand: 'choco --version',
    platforms: ['win32'],
    installTemplate: 'choco install -y {package}',
    updateTemplate: 'choco upgrade -y {package}',
  },
  {
    id: 'winget',
    name: 'Windows 包管理器',
    checkCommand: 'winget --version',
    platforms: ['win32'],
    installTemplate: 'winget install {package}',
    updateTemplate: 'winget upgrade {package}',
  },
  {
    id: 'scoop',
    name: 'Scoop',
    checkCommand: 'scoop --version',
    platforms: ['win32'],
    installTemplate: 'scoop install {package}',
    updateTemplate: 'scoop update {package}',
  },
]

// =============================================================================
// PostgreSQL 依赖项
// =============================================================================

/**
 * 用于创建 PostgreSQL 客户端工具依赖项的辅助函数
 * 使用 getPostgresHomebrewPackage() 获取当前最新版本
 */
function createPostgresDependency(
  name: string,
  binary: string,
  description: string,
): Dependency {
  const pgPackage = getPostgresHomebrewPackage()
  return {
    name,
    binary,
    description,
    packages: {
      brew: {
        package: pgPackage,
        postInstall: [`brew link --overwrite ${pgPackage}`],
      },
      apt: { package: 'postgresql-client' },
      yum: { package: 'postgresql' },
      dnf: { package: 'postgresql' },
      pacman: { package: 'postgresql-libs' },
      choco: { package: 'postgresql' },
      winget: { package: 'PostgreSQL.PostgreSQL' },
      scoop: { package: 'postgresql' },
    },
    manualInstall: {
      darwin: [
        '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        `然后运行：brew install ${pgPackage} && brew link --overwrite ${pgPackage}`,
        '或安装 Postgres.app：https://postgresapp.com/downloads.html',
      ],
      linux: [
        'Ubuntu/Debian：sudo apt install postgresql-client',
        'CentOS/RHEL：sudo yum install postgresql',
        'Fedora：sudo dnf install postgresql',
        'Arch：sudo pacman -S postgresql-libs',
      ],
      win32: [
        '使用 Chocolatey：choco install postgresql',
        '使用 winget：winget install PostgreSQL.PostgreSQL',
        '使用 Scoop：scoop install postgresql',
        '或从以下地址下载：https://www.enterprisedb.com/downloads/postgres-postgresql-downloads',
      ],
    },
  }
}

const postgresqlDependencies: EngineDependencies = {
  engine: 'postgresql',
  displayName: 'PostgreSQL',
  dependencies: [
    createPostgresDependency('psql', 'psql', 'PostgreSQL 交互式终端'),
    createPostgresDependency('pg_dump', 'pg_dump', 'PostgreSQL 数据库备份工具'),
    createPostgresDependency(
      'pg_restore',
      'pg_restore',
      'PostgreSQL 数据库恢复工具',
    ),
    createPostgresDependency(
      'pg_basebackup',
      'pg_basebackup',
      'PostgreSQL 基础备份工具，用于物理备份',
    ),
  ],
}

// =============================================================================
// MySQL 依赖项（为将来预留）
// =============================================================================

const mysqlDependencies: EngineDependencies = {
  engine: 'mysql',
  displayName: 'MySQL/MariaDB',
  dependencies: [
    {
      name: 'mysqld',
      binary: 'mysqld',
      description: 'MySQL/MariaDB 服务器守护进程',
      packages: {
        brew: { package: 'mysql' },
        // 现代 Debian/Ubuntu 使用 mariadb-server（兼容 MySQL）
        apt: { package: 'mariadb-server' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
        yum: { package: 'mariadb-server' },
        dnf: { package: 'mariadb-server' },
        pacman: { package: 'mariadb' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install mariadb-server',
          'CentOS/RHEL：sudo yum install mariadb-server',
          'Fedora：sudo dnf install mariadb-server',
          'Arch：sudo pacman -S mariadb',
        ],
        win32: [
          '使用 Chocolatey：choco install mysql',
          '使用 winget：winget install Oracle.MySQL',
          '使用 Scoop：scoop install mysql',
          '或从以下地址下载：https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysql',
      binary: 'mysql',
      description: 'MySQL/MariaDB 命令行客户端',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install mariadb-client',
          'CentOS/RHEL：sudo yum install mariadb',
          'Fedora：sudo dnf install mariadb',
          'Arch：sudo pacman -S mariadb-clients',
        ],
        win32: [
          '使用 Chocolatey：choco install mysql',
          '使用 winget：winget install Oracle.MySQL',
          '使用 Scoop：scoop install mysql',
          '或从以下地址下载：https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysqldump',
      binary: 'mysqldump',
      description: 'MySQL/MariaDB 数据库备份工具',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install mariadb-client',
          'CentOS/RHEL：sudo yum install mariadb',
          'Fedora：sudo dnf install mariadb',
          'Arch：sudo pacman -S mariadb-clients',
        ],
        win32: [
          '使用 Chocolatey：choco install mysql',
          '使用 winget：winget install Oracle.MySQL',
          '使用 Scoop：scoop install mysql',
          '或从以下地址下载：https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
    {
      name: 'mysqladmin',
      binary: 'mysqladmin',
      description: 'MySQL/MariaDB 服务器管理工具',
      packages: {
        brew: { package: 'mysql' },
        apt: { package: 'mariadb-client' },
        yum: { package: 'mariadb' },
        dnf: { package: 'mariadb' },
        pacman: { package: 'mariadb-clients' },
        choco: { package: 'mysql' },
        winget: { package: 'Oracle.MySQL' },
        scoop: { package: 'mysql' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install mysql',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install mariadb-client',
          'CentOS/RHEL：sudo yum install mariadb',
          'Fedora：sudo dnf install mariadb',
          'Arch：sudo pacman -S mariadb-clients',
        ],
        win32: [
          '使用 Chocolatey：choco install mysql',
          '使用 winget：winget install Oracle.MySQL',
          '使用 Scoop：scoop install mysql',
          '或从以下地址下载：https://dev.mysql.com/downloads/mysql/',
        ],
      },
    },
  ],
}

// =============================================================================
// SQLite 依赖项
// =============================================================================

const sqliteDependencies: EngineDependencies = {
  engine: 'sqlite',
  displayName: 'SQLite',
  dependencies: [
    {
      name: 'sqlite3',
      binary: 'sqlite3',
      description: 'SQLite 命令行界面',
      packages: {
        brew: { package: 'sqlite' },
        apt: { package: 'sqlite3' },
        yum: { package: 'sqlite' },
        dnf: { package: 'sqlite' },
        pacman: { package: 'sqlite' },
        choco: { package: 'sqlite' },
        winget: { package: 'SQLite.SQLite' },
        scoop: { package: 'sqlite' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install sqlite',
          '注意：macOS 默认在 /usr/bin/sqlite3 中包含 sqlite3',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install sqlite3',
          'CentOS/RHEL：sudo yum install sqlite',
          'Fedora：sudo dnf install sqlite',
          'Arch：sudo pacman -S sqlite',
        ],
        win32: [
          '使用 Chocolatey：choco install sqlite',
          '使用 winget：winget install SQLite.SQLite',
          '使用 Scoop：scoop install sqlite',
          '或从以下地址下载：https://www.sqlite.org/download.html',
        ],
      },
    },
  ],
}

// =============================================================================
// MongoDB 依赖项
// =============================================================================

const mongodbDependencies: EngineDependencies = {
  engine: 'mongodb',
  displayName: 'MongoDB',
  dependencies: [
    {
      name: 'mongod',
      binary: 'mongod',
      description: 'MongoDB 服务器守护进程',
      packages: {
        brew: {
          package: 'mongodb/brew/mongodb-community',
          preInstall: ['brew tap mongodb/brew'],
        },
        // MongoDB 需要其自身的 apt 仓库，默认仓库中不可用
        choco: { package: 'mongodb' },
        winget: { package: 'MongoDB.Server' },
        scoop: { package: 'mongodb' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '添加 MongoDB tap：brew tap mongodb/brew',
          '然后运行：brew install mongodb-community',
          '安装特定版本：brew install mongodb-community@7.0',
        ],
        linux: [
          'MongoDB 需要添加其官方仓库。',
          'Ubuntu/Debian：请遵循 https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/',
          'RHEL/CentOS：请遵循 https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-red-hat/',
        ],
        win32: [
          '使用 Chocolatey：choco install mongodb',
          '使用 winget：winget install MongoDB.Server',
          '或从以下地址下载：https://www.mongodb.com/try/download/community',
        ],
      },
    },
    {
      name: 'mongosh',
      binary: 'mongosh',
      description: 'MongoDB Shell（现代交互式 Shell）',
      packages: {
        brew: { package: 'mongosh' },
        choco: { package: 'mongodb-shell' },
        winget: { package: 'MongoDB.Shell' },
        scoop: { package: 'mongosh' },
      },
      manualInstall: {
        darwin: [
          '使用 Homebrew 安装：brew install mongosh',
          '或从以下地址下载：https://www.mongodb.com/try/download/shell',
        ],
        linux: [
          '从以下地址下载：https://www.mongodb.com/try/download/shell',
          '或通过 npm 安装：npm install -g mongosh',
        ],
        win32: [
          '使用 Chocolatey：choco install mongodb-shell',
          '使用 winget：winget install MongoDB.Shell',
          '或从以下地址下载：https://www.mongodb.com/try/download/shell',
        ],
      },
    },
    {
      name: 'mongodump',
      binary: 'mongodump',
      description: 'MongoDB 数据库备份工具',
      packages: {
        brew: { package: 'mongodb-database-tools' },
        choco: { package: 'mongodb-database-tools' },
      },
      manualInstall: {
        darwin: [
          '使用 Homebrew 安装：brew install mongodb-database-tools',
          '或从以下地址下载：https://www.mongodb.com/try/download/database-tools',
        ],
        linux: [
          '从以下地址下载：https://www.mongodb.com/try/download/database-tools',
          '解压并添加到 PATH',
        ],
        win32: [
          '使用 Chocolatey：choco install mongodb-database-tools',
          '或从以下地址下载：https://www.mongodb.com/try/download/database-tools',
        ],
      },
    },
    {
      name: 'mongorestore',
      binary: 'mongorestore',
      description: 'MongoDB 数据库恢复工具',
      packages: {
        brew: { package: 'mongodb-database-tools' },
        choco: { package: 'mongodb-database-tools' },
      },
      manualInstall: {
        darwin: [
          '使用 Homebrew 安装：brew install mongodb-database-tools',
          '或从以下地址下载：https://www.mongodb.com/try/download/database-tools',
        ],
        linux: [
          '从以下地址下载：https://www.mongodb.com/try/download/database-tools',
          '解压并添加到 PATH',
        ],
        win32: [
          '使用 Chocolatey：choco install mongodb-database-tools',
          '或从以下地址下载：https://www.mongodb.com/try/download/database-tools',
        ],
      },
    },
  ],
}

// =============================================================================
// Redis 依赖项
// =============================================================================

const redisDependencies: EngineDependencies = {
  engine: 'redis',
  displayName: 'Redis',
  dependencies: [
    {
      name: 'redis-server',
      binary: 'redis-server',
      description: 'Redis 内存数据存储服务器',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-server' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        winget: { package: 'Redis.Redis' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install redis',
          '作为服务启动：brew services start redis',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install redis-server',
          'CentOS/RHEL：sudo yum install redis',
          'Fedora：sudo dnf install redis',
          'Arch：sudo pacman -S redis',
        ],
        win32: [
          '使用 winget（推荐）：winget install Redis.Redis',
          '或从以下地址下载：https://github.com/redis-windows/redis-windows/releases',
        ],
      },
    },
    {
      name: 'redis-cli',
      binary: 'redis-cli',
      description: 'Redis 命令行界面客户端',
      packages: {
        brew: { package: 'redis' },
        apt: { package: 'redis-tools' },
        yum: { package: 'redis' },
        dnf: { package: 'redis' },
        pacman: { package: 'redis' },
        winget: { package: 'Redis.Redis' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install redis',
        ],
        linux: [
          'Debian/Ubuntu：sudo apt install redis-tools',
          'CentOS/RHEL：sudo yum install redis',
          'Fedora：sudo dnf install redis',
          'Arch：sudo pacman -S redis',
        ],
        win32: [
          '使用 winget（推荐）：winget install Redis.Redis',
          '或从以下地址下载：https://github.com/redis-windows/redis-windows/releases',
        ],
      },
    },
  ],
}

// =============================================================================
// Valkey 依赖项
// =============================================================================

const valkeyDependencies: EngineDependencies = {
  engine: 'valkey',
  displayName: 'Valkey',
  dependencies: [
    {
      name: 'valkey-server',
      binary: 'valkey-server',
      description: 'Valkey 内存数据存储服务器（Redis 分支）',
      packages: {
        // Valkey 较新 — 尚未被大多数包管理器收录
        // 主要分发渠道是 GitHub releases（hostdb）
        brew: { package: 'valkey' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install valkey',
          '或使用 SpinDB：spindb engines download valkey 9',
        ],
        linux: [
          'Valkey 尚未被大多数 Linux 包仓库收录。',
          '使用 SpinDB 下载二进制文件：spindb engines download valkey 9',
          '或从源码构建：https://github.com/valkey-io/valkey',
        ],
        win32: [
          '使用 SpinDB 下载二进制文件：spindb engines download valkey 9',
          '或从源码构建：https://github.com/valkey-io/valkey',
        ],
      },
    },
    {
      name: 'valkey-cli',
      binary: 'valkey-cli',
      description: 'Valkey 命令行界面客户端',
      packages: {
        brew: { package: 'valkey' },
      },
      manualInstall: {
        darwin: [
          '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          '然后运行：brew install valkey',
          '或使用 SpinDB：spindb engines download valkey 9',
        ],
        linux: [
          'Valkey 尚未被大多数 Linux 包仓库收录。',
          '使用 SpinDB 下载二进制文件：spindb engines download valkey 9',
          '或从源码构建：https://github.com/valkey-io/valkey',
        ],
        win32: [
          '使用 SpinDB 下载二进制文件：spindb engines download valkey 9',
          '或从源码构建：https://github.com/valkey-io/valkey',
        ],
      },
    },
  ],
}

// =============================================================================
// ClickHouse 依赖项
// =============================================================================

const clickhouseDependencies: EngineDependencies = {
  engine: 'clickhouse',
  displayName: 'ClickHouse',
  dependencies: [
    {
      name: 'clickhouse',
      binary: 'clickhouse',
      description:
        'ClickHouse 数据库二进制文件（clickhouse-server、clickhouse-client、clickhouse-local、clickhouse-benchmark）。Homebrew 安装统一的 clickhouse 二进制文件，通过子命令使用。',
      packages: {
        brew: { package: 'clickhouse' },
        // ClickHouse 需要其自身的 apt 仓库
      },
      manualInstall: {
        darwin: [
          '使用 Homebrew 安装：brew install clickhouse',
          '或使用 SpinDB：spindb engines download clickhouse 25.12',
        ],
        linux: [
          'ClickHouse 提供官方软件包。',
          '添加其 apt 仓库：https://clickhouse.com/docs/en/install#install-from-deb-packages',
          '或使用 SpinDB：spindb engines download clickhouse 25.12',
        ],
        win32: [
          'ClickHouse 官方不支持 Windows。',
          '请使用 WSL2 并参考 Linux 安装说明。',
        ],
      },
    },
  ],
}

// =============================================================================
// 可选工具（与引擎无关）
// =============================================================================

/**
 * usql - 通用 SQL 客户端
 * 支持 PostgreSQL、MySQL、SQLite 及其他 20 多种数据库
 * https://github.com/xo/usql
 */
export const usqlDependency: Dependency = {
  name: 'usql',
  binary: 'usql',
  description: '通用 SQL 客户端，具有自动补全、语法高亮和多数据库支持',
  packages: {
    brew: {
      package: 'xo/xo/usql',
      preInstall: ['brew tap xo/xo'],
    },
    // 注意：usql 不在标准的 Linux 包仓库中，必须使用手动安装
  },
  manualInstall: {
    darwin: [
      '安装 Homebrew：/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      '然后运行：brew tap xo/xo && brew install xo/xo/usql',
    ],
    linux: [
      '从 GitHub Releases 下载：https://github.com/xo/usql/releases',
      '解压并移动到 PATH：sudo mv usql /usr/local/bin/',
      '或通过 Go 安装：go install github.com/xo/usql@latest',
    ],
  },
}

/**
 * pgcli - 具有自动补全和语法高亮的 PostgreSQL CLI
 * https://github.com/dbcli/pgcli
 */
export const pgcliDependency: Dependency = {
  name: 'pgcli',
  binary: 'pgcli',
  description: '具有智能自动补全和语法高亮的 PostgreSQL CLI',
  packages: {
    brew: { package: 'pgcli' },
    apt: { package: 'pgcli' },
    dnf: { package: 'pgcli' },
    yum: { package: 'pgcli' },
    pacman: { package: 'pgcli' },
  },
  manualInstall: {
    darwin: [
      '使用 Homebrew 安装：brew install pgcli',
      '或使用 pip 安装：pip install pgcli',
    ],
    linux: [
      'Debian/Ubuntu：sudo apt install pgcli',
      'Fedora：sudo dnf install pgcli',
      '或使用 pip 安装：pip install pgcli',
    ],
  },
}

/**
 * mycli - 具有自动补全和语法高亮的 MySQL CLI
 * https://github.com/dbcli/mycli
 */
export const mycliDependency: Dependency = {
  name: 'mycli',
  binary: 'mycli',
  description: '具有智能自动补全和语法高亮的 MySQL/MariaDB CLI',
  packages: {
    brew: { package: 'mycli' },
    apt: { package: 'mycli' },
    dnf: { package: 'mycli' },
    yum: { package: 'mycli' },
    pacman: { package: 'mycli' },
  },
  manualInstall: {
    darwin: [
      '使用 Homebrew 安装：brew install mycli',
      '或使用 pip 安装：pip install mycli',
    ],
    linux: [
      'Debian/Ubuntu：sudo apt install mycli',
      'Fedora：sudo dnf install mycli',
      '或使用 pip 安装：pip install mycli',
    ],
  },
}

/**
 * litecli - 具有自动补全和语法高亮的 SQLite CLI
 * https://github.com/dbcli/litecli
 */
export const litecliDependency: Dependency = {
  name: 'litecli',
  binary: 'litecli',
  description: '具有智能自动补全和语法高亮的 SQLite CLI',
  packages: {
    brew: { package: 'litecli' },
    apt: { package: 'litecli' },
    dnf: { package: 'litecli' },
    yum: { package: 'litecli' },
    pacman: { package: 'litecli' },
  },
  manualInstall: {
    darwin: [
      '使用 Homebrew 安装：brew install litecli',
      '或使用 pip 安装：pip install litecli',
    ],
    linux: [
      'Debian/Ubuntu：sudo apt install litecli',
      'Fedora：sudo dnf install litecli',
      '或使用 pip 安装：pip install litecli',
    ],
  },
}

/**
 * iredis - 具有自动补全和语法高亮的 Redis CLI
 * https://github.com/laixintao/iredis
 */
export const iredisDependency: Dependency = {
  name: 'iredis',
  binary: 'iredis',
  description: '具有智能自动补全和语法高亮的 Redis CLI',
  packages: {
    brew: { package: 'iredis' },
    // 大多数平台使用 pip install
  },
  manualInstall: {
    darwin: [
      '使用 Homebrew 安装：brew install iredis',
      '或使用 pip 安装：pip install iredis',
    ],
    linux: ['使用 pip 安装：pip install iredis'],
    win32: ['使用 pip 安装：pip install iredis'],
  },
}

// =============================================================================
// 注册表
// =============================================================================

// 所有引擎的依赖项注册表
export const engineDependencies: EngineDependencies[] = [
  postgresqlDependencies,
  mysqlDependencies,
  sqliteDependencies,
  mongodbDependencies,
  redisDependencies,
  valkeyDependencies,
  clickhouseDependencies,
]

// 获取特定引擎的依赖项
export function getEngineDependencies(
  engine: string,
): EngineDependencies | undefined {
  return engineDependencies.find((e) => e.engine === engine)
}

// 获取所有引擎的所有依赖项
export function getAllDependencies(): Dependency[] {
  return engineDependencies.flatMap((e) => e.dependencies)
}

// 获取去重后的唯一依赖项（按二进制文件名称去重）
export function getUniqueDependencies(): Dependency[] {
  const seen = new Set<string>()
  const unique: Dependency[] = []

  for (const dep of getAllDependencies()) {
    if (!seen.has(dep.binary)) {
      seen.add(dep.binary)
      unique.push(dep)
    }
  }

  return unique
}

// 根据 ID 获取包管理器配置
export function getPackageManager(
  id: PackageManagerId,
): PackageManagerConfig | undefined {
  return packageManagers.find((pm) => pm.id === id)
}

// 获取适用于某个平台的所有包管理器
export function getPackageManagersForPlatform(
  platform: Platform,
): PackageManagerConfig[] {
  return packageManagers.filter((pm) => pm.platforms.includes(platform))
}
