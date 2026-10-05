import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from '../EventEmitter'

type TestMap = {
  foo: { n: number }
  bar: string
}

class Probe extends EventEmitter<TestMap> {
  fire<K extends keyof TestMap>(event: K, payload: TestMap[K]): void {
    this.emit(event, payload)
  }
}

describe('EventEmitter', () => {
  it('invokes registered handlers with the emitted payload', () => {
    const e = new Probe()
    const handler = vi.fn()
    e.on('foo', handler)

    e.fire('foo', { n: 1 })

    expect(handler).toHaveBeenCalledExactlyOnceWith({ n: 1 })
  })

  it('supports multiple handlers for the same event', () => {
    const e = new Probe()
    const a = vi.fn()
    const b = vi.fn()
    e.on('foo', a)
    e.on('foo', b)

    e.fire('foo', { n: 7 })

    expect(a).toHaveBeenCalledExactlyOnceWith({ n: 7 })
    expect(b).toHaveBeenCalledExactlyOnceWith({ n: 7 })
  })

  it('isolates handlers across events', () => {
    const e = new Probe()
    const fooH = vi.fn()
    const barH = vi.fn()
    e.on('foo', fooH)
    e.on('bar', barH)

    e.fire('foo', { n: 1 })

    expect(fooH).toHaveBeenCalledOnce()
    expect(barH).not.toHaveBeenCalled()
  })

  it('off() removes a single handler without affecting others', () => {
    const e = new Probe()
    const a = vi.fn()
    const b = vi.fn()
    e.on('foo', a)
    e.on('foo', b)

    e.off('foo', a)
    e.fire('foo', { n: 1 })

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledOnce()
  })

  it('off() with an unknown handler is a no-op', () => {
    const e = new Probe()
    const a = vi.fn()
    e.on('foo', a)

    expect(() => e.off('foo', vi.fn())).not.toThrow()

    e.fire('foo', { n: 1 })
    expect(a).toHaveBeenCalledOnce()
  })

  it('emit with no listeners does not throw', () => {
    const e = new Probe()
    expect(() => e.fire('bar', 'hi')).not.toThrow()
  })

  it('de-duplicates identical handler+event pairs (Set semantics)', () => {
    const e = new Probe()
    const h = vi.fn()
    e.on('foo', h)
    e.on('foo', h)

    e.fire('foo', { n: 0 })

    expect(h).toHaveBeenCalledOnce()
  })
})
