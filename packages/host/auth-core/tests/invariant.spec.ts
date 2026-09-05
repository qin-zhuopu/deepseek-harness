import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import InvariantService from '@deepseek-ai/dsh-invariants'
import * as AuthCoreInvariant from '../src/invariant.ts'

describe('invariant companion', () => {
  it('registers the explained empty installer under its package name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantService, { enabled: true })
    await expect(ctx.plugin(AuthCoreInvariant).await()).resolves.toBeDefined()
  })
})
