/**
 * QuestDB 认证模块
 *
 * 加载 QuestDB 容器的本地认证凭据。
 * QuestDB 默认用户名/密码为 admin/quest。
 */

import { loadCredentials } from '../../core/credential-manager'
import { Engine } from '../../types'

export type QuestLocalAuth = {
  user: string
  password: string
}

const QUEST_DEFAULT_USERNAME = 'admin'
const QUEST_DEFAULT_PASSWORD = 'quest'
const LEGACY_DEFAULT_USERNAME = 'spindb'

/**
 * 加载 QuestDB 容器的本地认证凭据
 *
 * 优先使用 'admin' 用户凭据，回退到旧版 'spindb' 用户，
 * 最终回退到默认凭据 admin/quest。
 */
export async function loadLocalQuestAuth(
  containerName: string,
): Promise<QuestLocalAuth> {
  // 优先查找 admin 用户凭据
  const primary = await loadCredentials(
    containerName,
    Engine.QuestDB,
    QUEST_DEFAULT_USERNAME,
  )
  if (primary) {
    return {
      user: primary.username,
      password: primary.password,
    }
  }

  // 回退到旧版 spindb 用户凭据
  const legacy = await loadCredentials(
    containerName,
    Engine.QuestDB,
    LEGACY_DEFAULT_USERNAME,
  )

  if (legacy) {
    return {
      user: legacy.username,
      password: legacy.password,
    }
  }

  // 最终回退到默认凭据
  return {
    user: QUEST_DEFAULT_USERNAME,
    password: QUEST_DEFAULT_PASSWORD,
  }
}
