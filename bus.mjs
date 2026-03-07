// Message bus: event + payload + status

class Bus {
  #handlers = new Map()
  #msgId = 0

  handle(event, fn) {
    this.#handlers.set(event, fn)
  }

  async send(event, payload) {
    const msg = {
      id: `msg_${++this.#msgId}`,
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
      const result = await handler(msg.payload)
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
