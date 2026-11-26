import { expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ handle: vi.fn(), openExternal: vi.fn(async (_url: string) => {}) }))

vi.mock('electron', () => ({
  app: { whenReady: () => new Promise(() => {}), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: mocks.handle },
  shell: { openExternal: mocks.openExternal }
}))

import '../electron/main'

it('opens only discovered IPv4 node addresses and propagates browser failures', async () => {
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'rdm:open-node-web')?.[1] as (event: unknown, ip: unknown) => Promise<void>
  expect(handler).toBeTypeOf('function')
  await handler(null, '10.0.0.21')
  expect(mocks.openExternal).toHaveBeenCalledWith('http://10.0.0.21/')
  for (const ip of ['https://example.com', '10.0.0.21@evil.com', '10.0.0.99', '127.0.0.1', '::1', 42]) {
    expect(() => handler(null, ip)).toThrow('Invalid or unknown node IP address')
  }
  expect(mocks.openExternal).toHaveBeenCalledTimes(1)
  mocks.openExternal.mockRejectedValueOnce(new Error('Browser unavailable'))
  await expect(handler(null, '10.0.0.21')).rejects.toThrow('Browser unavailable')
})

it('exposes an immediate polling command through IPC', async () => {
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'rdm:poll-now')?.[1] as () => Promise<void>
  expect(handler).toBeTypeOf('function')
  await expect(handler()).resolves.toBeUndefined()
})
