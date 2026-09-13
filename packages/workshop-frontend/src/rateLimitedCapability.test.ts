import { describe, expect, it, vi } from 'vitest'
import { createRateLimitedCapability } from './rateLimitedCapability'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve })
  return { promise, resolve }
}

describe('rate-limited capability disposal', () => {
  it.each(['throttle', 'reject'] as const)('R6-LIMITER-001 closes queued and future %s calls', async (onRateLimit) => {
    const active = Array.from({ length: 8 }, () => deferred<number>())
    const write = vi.fn<(index: number) => Promise<number>>((index) => index < 8 ? active[index].promise : Promise.resolve(index))
    const { capability, dispose } = createRateLimitedCapability({ write }, {
      maxConcurrency: 8, maxCallsPerMinute: 1_000, maxPendingCalls: 128, onRateLimit, label: 'Fixture capability',
    }) as { capability: { write(index: number): Promise<number> }; dispose(): void }
    const outcome = (promise: Promise<number>) => promise.then(
      (value) => ({ value }),
      (error: Error) => ({ error: error.message }),
    )
    const calls = Array.from({ length: 16 }, (_, index) => outcome(capability.write(index)))
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(8))
    dispose()
    dispose()
    const future = outcome(capability.write(16))
    active.forEach((pending, index) => pending.resolve(index))
    await expect(Promise.all([...calls, future])).resolves.toEqual([
      ...Array.from({ length: 8 }, (_, value) => ({ value })),
      ...Array.from({ length: 9 }, () => ({ error: 'Fixture capability is no longer available.' })),
    ])
    expect(write.mock.calls.map(([index]) => index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it.each(['throttle', 'reject'] as const)('R6-LIMITER-002 closes admitted but uninvoked %s calls', async (onRateLimit) => {
    const write = vi.fn<() => string>(() => 'committed')
    const { capability, dispose } = createRateLimitedCapability({ write }, {
      maxConcurrency: 1, maxCallsPerMinute: 10, maxPendingCalls: 10, onRateLimit, label: 'Fixture capability',
    }) as { capability: { write(): Promise<string> }; dispose(): void }
    const result = capability.write()
    const outcome = result.then(() => 'fulfilled', (error: Error) => error.message)
    dispose()
    await expect(outcome).resolves.toBe('Fixture capability is no longer available.')
    expect(write).not.toHaveBeenCalled()
  })
})
