import crypto from 'node:crypto'
import { IncomingMessage, isTransactionOrigin, MessageReceiver, MessageType, OutgoingMessage } from '@hocuspocus/server'
import RedisClient from 'ioredis'
import { messageYjsSyncStep2, messageYjsUpdate } from 'y-protocols/sync'

/**
 * Clean-room MIT-compatible Redis pub/sub extension for Hocuspocus v4.9.0.
 *
 * Syncs document updates, awareness states, and stateless broadcasts across hub instances
 * over ioredis pub/sub without distributed locking (hub persistence uses protocol 2's
 * append-only ledger, never onStoreDocument).
 */
export class Redis {
  priority = 1000

  configuration = {
    port: 6379,
    host: '127.0.0.1',
    prefix: 'hocuspocus',
    identifier: `host-${crypto.randomUUID()}`,
    disconnectDelay: 1000,
    awaitInitialSyncTimeout: 1000,
  }

  redisTransactionOrigin = Object.freeze({ source: 'redis' })

  pub
  sub
  instance
  messagePrefix

  #replySubscription
  #documents = new Map()
  #pendingInitialSyncResolves = new Map()
  #pendingPublishes = new Map()
  #resyncGeneration = 0
  #cancelResyncRetry = null
  #unloadTimers = new Set()

  constructor(configuration = {}) {
    this.configuration = {
      ...this.configuration,
      ...configuration,
    }

    const { port, host, options, nodes, redis, createClient } = this.configuration

    if (typeof createClient === 'function') {
      this.pub = createClient()
      this.sub = createClient()
    } else if (redis) {
      this.pub = redis.duplicate()
      this.sub = redis.duplicate()
    } else if (nodes && nodes.length > 0) {
      this.pub = new RedisClient.Cluster(nodes, options)
      this.sub = new RedisClient.Cluster(nodes, options)
    } else {
      this.pub = new RedisClient(port, host, options ?? {})
      this.sub = new RedisClient(port, host, options ?? {})
    }

    const identifierBuffer = Buffer.from(this.configuration.identifier, 'utf-8')
    if (identifierBuffer.length > 255) {
      throw new RangeError('Redis extension identifier must be at most 255 UTF-8 bytes')
    }
    this.messagePrefix = Buffer.concat([Buffer.from([identifierBuffer.length]), identifierBuffer])

    this.sub.on('messageBuffer', this.handleIncomingMessage)
    this.#resyncOnReconnect(this.pub)
    this.#resyncOnReconnect(this.sub)
    this.#replySubscription = this.#subscribeToReplyChannel()
  }

  async onConfigure({ instance }) {
    this.instance = instance
  }

  #getKey(documentName) {
    return `${this.configuration.prefix}:${documentName}`
  }

  #replyKey(identifier) {
    return `${this.configuration.prefix}#reply:${identifier}`
  }

  #subscribeToReplyChannel() {
    const subscription = new Promise((resolve, reject) => {
      this.sub.subscribe(this.#replyKey(this.configuration.identifier), (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
    subscription.catch(() => {})
    return subscription
  }

  async #awaitReplySubscription() {
    const current = this.#replySubscription
    try {
      await current
    } catch {
      if (this.#replySubscription === current) {
        this.#replySubscription = this.#subscribeToReplyChannel()
      }
      await this.#replySubscription
    }
  }

  #subscribeToDocument(documentName) {
    return new Promise((resolve, reject) => {
      this.sub.subscribe(this.#getKey(documentName), (error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }

  #resyncOnReconnect(client) {
    let connectedBefore = client.status === 'ready'
    client.on('ready', () => {
      if (connectedBefore) {
        void this.#resyncAfterReconnect()
      }
      connectedBefore = true
    })
  }

  async #resyncAfterReconnect() {
    const generation = ++this.#resyncGeneration
    this.#cancelResyncRetry?.()

    const shouldRetry = () => generation === this.#resyncGeneration
      && this.pub.status === 'ready'
      && this.sub.status === 'ready'

    let replySubscribed = false
    let pending = new Set(this.#documents.keys())

    for (let attempt = 0; ; attempt++) {
      let errors
      try {
        if (!replySubscribed) {
          this.#replySubscription = this.#subscribeToReplyChannel()
          await this.#replySubscription
          replySubscribed = true
        }
        const failed = await this.#resyncDocuments(generation, pending)
        if (failed.size === 0) {
          return
        }
        pending = new Set(failed.keys())
        errors = Array.from(failed.values())
      } catch (error) {
        errors = [error]
      }

      if (!shouldRetry()) {
        return
      }

      for (const error of errors) {
        console.error(error)
      }

      await new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(100 * (2 ** attempt), 5000))
        this.#cancelResyncRetry = () => {
          clearTimeout(timer)
          resolve()
        }
      })

      if (!shouldRetry()) {
        return
      }
    }
  }

  async #resyncDocuments(generation, documentNames) {
    const failed = new Map()
    await Promise.all(Array.from(documentNames, async (documentName) => {
      try {
        if (!this.#documents.has(documentName)) {
          return
        }
        await this.#subscribeToDocument(documentName)
        const document = this.#documents.get(documentName)
        if (!document) {
          this.sub.unsubscribe(this.#getKey(documentName), () => {})
          return
        }
        if (generation !== this.#resyncGeneration) {
          return
        }

        const messages = [
          this.#publishFirstSyncStep(documentName, document),
          this.#requestAwarenessFromOtherInstances(documentName),
        ]

        if (document.awareness.getStates().size > 0) {
          const message = new OutgoingMessage(documentName).createAwarenessUpdateMessage(document.awareness)
          messages.push(this.pub.publish(this.#getKey(documentName), this.#encodeMessage(message.toUint8Array())))
        }

        await Promise.all(messages)
      } catch (error) {
        failed.set(documentName, error)
      }
    }))
    return failed
  }

  #encodeMessage(message) {
    return Buffer.concat([this.messagePrefix, Buffer.from(message)])
  }

  #decodeMessage(buffer) {
    const identifierLength = buffer[0]
    const identifier = buffer.toString('utf-8', 1, identifierLength + 1)
    return [identifier, buffer.subarray(identifierLength + 1)]
  }

  async afterLoadDocument({ documentName, document }) {
    this.#documents.set(documentName, document)
    try {
      await this.#awaitReplySubscription()
      await this.#subscribeToDocument(documentName)
      await this.#syncInitialStateFromPeers(documentName, document)
    } catch (error) {
      this.#documents.delete(documentName)
      this.#pendingInitialSyncResolves.delete(documentName)
      this.sub.unsubscribe(this.#getKey(documentName), () => {})
      throw error
    }
  }

  async #syncInitialStateFromPeers(documentName, document) {
    const timeout = this.configuration.awaitInitialSyncTimeout
    const waitForPeers = timeout > 0 && await this.#hasOtherSubscribers(documentName)

    await Promise.all([
      this.#publishFirstSyncStep(documentName, document),
      this.#requestAwarenessFromOtherInstances(documentName),
    ])

    if (!waitForPeers) {
      return
    }

    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingInitialSyncResolves.delete(documentName)
        resolve()
      }, timeout)

      this.#pendingInitialSyncResolves.set(documentName, () => {
        clearTimeout(timer)
        this.#pendingInitialSyncResolves.delete(documentName)
        resolve()
      })
    })
  }

  async #hasOtherSubscribers(documentName) {
    try {
      const result = await this.pub.pubsub('NUMSUB', this.#getKey(documentName))
      return Number(result?.[1] ?? 0) > 1
    } catch {
      return true
    }
  }

  #resolveInitialSync(documentName) {
    this.#pendingInitialSyncResolves.get(documentName)?.()
  }

  #messageCarriesPeerState(message) {
    const { pos } = message.decoder
    try {
      const type = message.readVarUint()
      if (type !== MessageType.Sync && type !== MessageType.SyncReply) {
        return false
      }
      const syncType = message.readVarUint()
      return syncType === messageYjsSyncStep2 || syncType === messageYjsUpdate
    } catch {
      return false
    } finally {
      message.decoder.pos = pos
    }
  }

  #schedulePublish(documentName, document) {
    const existing = this.#pendingPublishes.get(documentName)
    if (existing) {
      if (existing.document === document) {
        return existing
      }
      existing.cancel()
      this.#pendingPublishes.delete(documentName)
    }

    const handle = setImmediate(() => {
      this.#flushPublish(documentName).catch((error) => {
        console.error(`Redis: failed to publish for document "${documentName}"`, error)
      })
    })

    const pending = {
      document,
      syncStepPending: false,
      awarenessClients: new Set(),
      awareness: undefined,
      cancel: () => clearImmediate(handle),
    }

    this.#pendingPublishes.set(documentName, pending)
    return pending
  }

  #cancelPendingPublish(documentName) {
    const pending = this.#pendingPublishes.get(documentName)
    if (pending) {
      pending.cancel()
      this.#pendingPublishes.delete(documentName)
    }
  }

  async #flushPublish(documentName) {
    const pending = this.#pendingPublishes.get(documentName)
    if (!pending) {
      return
    }
    this.#pendingPublishes.delete(documentName)

    const publishes = []
    if (pending.syncStepPending) {
      publishes.push(this.#publishFirstSyncStep(documentName, pending.document))
    }

    if (pending.awarenessClients.size > 0 && pending.awareness && !pending.document.isDestroyed) {
      const message = new OutgoingMessage(documentName).createAwarenessUpdateMessage(
        pending.awareness,
        Array.from(pending.awarenessClients),
      )
      publishes.push(this.pub.publish(this.#getKey(documentName), this.#encodeMessage(message.toUint8Array())))
    }

    await Promise.all(publishes)
  }

  #publishFirstSyncStep(documentName, document) {
    const syncMessage = new OutgoingMessage(documentName)
      .createSyncMessage()
      .writeFirstSyncStepFor(document)

    return this.pub.publish(this.#getKey(documentName), this.#encodeMessage(syncMessage.toUint8Array()))
  }

  #requestAwarenessFromOtherInstances(documentName) {
    const awarenessMessage = new OutgoingMessage(documentName).writeQueryAwareness()
    return this.pub.publish(this.#getKey(documentName), this.#encodeMessage(awarenessMessage.toUint8Array()))
  }

  async onAwarenessUpdate({ documentName, awareness, added, updated, removed, document }) {
    if (!document || document.isDestroyed) {
      return
    }
    const pending = this.#schedulePublish(documentName, document)
    pending.awareness = awareness
    for (const clientId of added.concat(updated, removed)) {
      pending.awarenessClients.add(clientId)
    }
  }

  handleIncomingMessage = async (channel, data) => {
    const [identifier, messageBuffer] = this.#decodeMessage(data)
    if (identifier === this.configuration.identifier) {
      return
    }

    const message = new IncomingMessage(messageBuffer)
    const documentName = message.readVarString()
    message.writeVarString(documentName)

    const document = this.#documents.get(documentName) ?? this.instance?.documents?.get(documentName)
    if (!document) {
      return
    }

    const carriesPeerState = this.#messageCarriesPeerState(message)
    const addressedToUs = channel.toString('utf-8') === this.#replyKey(this.configuration.identifier)

    const receiver = new MessageReceiver(message, this.redisTransactionOrigin)
    await receiver.apply(document, undefined, (reply) => this.pub.publish(
      this.#replyKey(identifier),
      this.#encodeMessage(reply),
    ))

    if (carriesPeerState && addressedToUs) {
      this.#resolveInitialSync(documentName)
    }
  }

  async onChange(data) {
    if (isTransactionOrigin(data.transactionOrigin) && data.transactionOrigin.source === 'redis') {
      return
    }
    this.#schedulePublish(data.documentName, data.document).syncStepPending = true
  }

  async beforeUnloadDocument() {
    if (this.configuration.disconnectDelay <= 0) {
      return
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#unloadTimers.delete(timer)
        resolve()
      }, this.configuration.disconnectDelay)
      this.#unloadTimers.add(timer)
    })
  }

  async afterUnloadDocument(data) {
    if (data.instance.documents.has(data.documentName)) {
      return
    }
    this.#resolveInitialSync(data.documentName)
    this.#documents.delete(data.documentName)
    this.#cancelPendingPublish(data.documentName)
    this.sub.unsubscribe(this.#getKey(data.documentName), (error) => {
      if (error) {
        console.error(error)
      }
    })
  }

  async beforeBroadcastStateless(data) {
    const message = new OutgoingMessage(data.documentName).writeBroadcastStateless(data.payload)
    return this.pub.publish(this.#getKey(data.documentName), this.#encodeMessage(message.toUint8Array()))
  }

  async onDestroy() {
    this.#resyncGeneration++
    this.#cancelResyncRetry?.()
    for (const documentName of Array.from(this.#pendingPublishes.keys())) {
      this.#cancelPendingPublish(documentName)
    }
    for (const timer of this.#unloadTimers) {
      clearTimeout(timer)
    }
    this.#unloadTimers.clear()
    for (const resolve of Array.from(this.#pendingInitialSyncResolves.values())) {
      resolve()
    }
    this.#pendingInitialSyncResolves.clear()
    this.pub.disconnect(false)
    this.sub.disconnect(false)
  }
}
