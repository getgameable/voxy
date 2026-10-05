/**
 * Minimal Web Worker double used by the VadEngine tests.
 *
 * The real code imports the worker via Vite's `?worker` suffix:
 *
 *   import VadWorkerClass from './workers/vad-worker?worker'
 *
 * Tests `vi.mock()` that specifier and point its default export at this class,
 * which records postMessage calls and lets tests drive the inverse channel
 * (worker → main) via `emit()`.
 */

import { vi } from 'vitest'

export class MockWorker {
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror:   ((e: ErrorEvent) => void) | null = null
  readonly posted: unknown[] = []

  static instances: MockWorker[] = []
  /** When non-null, the next constructor call throws this error (cleared after use). */
  static throwOnNextConstruction: unknown = null

  constructor() {
    if (MockWorker.throwOnNextConstruction !== null) {
      const err = MockWorker.throwOnNextConstruction
      MockWorker.throwOnNextConstruction = null
      throw err
    }
    MockWorker.instances.push(this)
  }

  postMessage = vi.fn((data: unknown, _transfer?: Transferable[]): void => {
    this.posted.push(data)
  })

  terminate = vi.fn()

  /** Simulate a message from the worker to the main thread. */
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  /** Simulate an uncaught worker error. */
  error(message: string): void {
    this.onerror?.({ message } as ErrorEvent)
  }

  /** Reset between tests. */
  static reset(): void {
    MockWorker.instances = []
    MockWorker.throwOnNextConstruction = null
  }
}
