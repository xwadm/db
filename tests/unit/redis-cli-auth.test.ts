import { describe, it } from 'node:test'
import { shouldPassRedisCliUsername } from '../../engines/redis/index'
import { assertEqual } from '../utils/assertions'

describe('Redis CLI auth', () => {
  it('omits the implicit default user', () => {
    assertEqual(
      shouldPassRedisCliUsername('default'),
      false,
      'default 用户不应该传递给 redis-cli',
    )
    assertEqual(
      shouldPassRedisCliUsername(' DEFAULT '),
      false,
      'default 用户匹配应该不区分大小写',
    )
  })

  it('passes explicit ACL users', () => {
    assertEqual(
      shouldPassRedisCliUsername('appuser'),
      true,
      '非 default 的 ACL 用户应该传递给 redis-cli',
    )
  })

  it('omits empty usernames', () => {
    assertEqual(
      shouldPassRedisCliUsername(undefined),
      false,
      '缺失的用户名不应该传递给 redis-cli',
    )
    assertEqual(
      shouldPassRedisCliUsername(''),
      false,
      '空用户名不应该传递给 redis-cli',
    )
  })
})
