import { describe, expect, it } from 'vitest'
import { buildChildEnv, toWorkspaceRelative } from '../src/subprocess/environment.ts'

describe('buildChildEnv', () => {
  it('drops credential-shaped and NEEV_ names and undefined tombstones', () => {
    const env = buildChildEnv({
      FOO: 'bar',
      SAFE: 'ok',
      NEEV_API_KEY: 'secret',
      MY_TOKEN: 't',
      AWS_SECRET: 's',
      DB_PASSWORD: 'p',
      GONE: undefined,
    })
    expect(env).toEqual({ FOO: 'bar', SAFE: 'ok' })
  })
})

describe('toWorkspaceRelative', () => {
  it('maps the root to "." and subpaths to relative', () => {
    expect(toWorkspaceRelative('/workspace', '/workspace')).toBe('.')
    expect(toWorkspaceRelative('/workspace/app', '/workspace')).toBe('app')
  })
})
