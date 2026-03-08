// Message bus: event + payload + status + request context

class Bus {
  #handlers = new Map()
  #msgId = 0
  #reqId = 0

  handle(event, fn) {
    this.#handlers.set(event, fn)
  }

  /** Create a new request context. Returns reqId for correlation. */
  newRequest() {
    return `req_${++this.#reqId}`
  }

  async send(event, payload, reqId) {
    const msg = {
      id: `msg_${++this.#msgId}`, reqId: reqId || null,
      event, status: 'pending', payload, ts: Date.now()
    }
    const handler = this.#handlers.get(event)
    if (!handler) {
      msg.status = 'failed'
      msg.error = `no handler: ${event}`
      if (event !== 'log') this.send('log', msg).catch(() => {})
      throw new Error(msg.error)
    }
    msg.status = 'processing'
    try {
      const result = await handler(msg.payload, reqId)
      msg.status = 'completed'
      return result
    } catch (err) {
      msg.status = 'failed'
      msg.error = err.message
      throw err
    } finally {
      msg.duration = Date.now() - msg.ts
      if (event !== 'log') this.send('log', msg).catch(() => {})
    }
  }
}

export function createBus() { return new Bus() }
