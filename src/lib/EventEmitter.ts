type Handler<T> = (payload: T) => void

export class EventEmitter<EventMap extends Record<string, unknown>> {
  private listeners = new Map<string, Set<Handler<unknown>>>()

  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
    const key = event as string
    if (!this.listeners.has(key)) this.listeners.set(key, new Set())
    this.listeners.get(key)!.add(handler as Handler<unknown>)
  }

  off<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void {
    this.listeners.get(event as string)?.delete(handler as Handler<unknown>)
  }

  protected emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.listeners.get(event as string)?.forEach(h => h(payload as unknown))
  }
}
