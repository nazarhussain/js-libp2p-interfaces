'use strict'

const { EventEmitter } = require('events')

const lp = require('it-length-prefixed')

/** @type {typeof import('it-pushable').default} */
// @ts-ignore
const pushable = require('it-pushable')
const { pipe } = require('it-pipe')
const { source: abortable } = require('abortable-iterator')
const AbortController = require('abort-controller').default
const debug = require('debug')

const log = debug('libp2p-pubsub:peer-streams')
log.error = debug('libp2p-pubsub:peer-streams:error')

/**
 * @callback Sink
 * @param {Uint8Array} source
 * @returns {Promise<Uint8Array>}
 *
 * @typedef {object} DuplexIterableStream
 * @property {Sink} sink
 * @property {AsyncIterator<Uint8Array>} source
 *
 * @typedef PeerId
 * @type import('peer-id')
 */

/**
 * Thin wrapper around a peer's inbound / outbound pubsub streams
 */
class PeerStreams extends EventEmitter {
  /**
   * @param {object} properties - properties of the PeerStreams.
   * @param {PeerId} properties.id
   * @param {string} properties.protocol
   */
  constructor ({ id, protocol }) {
    super()

    /**
     * @type {import('peer-id')}
     */
    this.id = id
    /**
     * Established protocol
     *
     * @type {string}
     */
    this.protocol = protocol
    /**
     * The raw outbound stream, as retrieved from conn.newStream
     *
     * @private
     * @type {null|DuplexIterableStream}
     */
    this._rawOutboundStream = null
    /**
     * The raw inbound stream, as retrieved from the callback from libp2p.handle
     *
     * @private
     * @type {null|DuplexIterableStream}
     */
    this._rawInboundStream = null
    /**
     * An AbortController for controlled shutdown of the inbound stream
     *
     * @private
     * @type {null|AbortController}
     */
    this._inboundAbortController = null
    /**
     * Write stream -- its preferable to use the write method
     *
     * @type {null|import('it-pushable').Pushable<Uint8Array>}
     */
    this.outboundStream = null
    /**
     * Read stream
     *
     * @type {null|DuplexIterableStream}
     */
    this.inboundStream = null
  }

  /**
   * Do we have a connection to read from?
   *
   * @type {boolean}
   */
  get isReadable () {
    return Boolean(this.inboundStream)
  }

  /**
   * Do we have a connection to write on?
   *
   * @type {boolean}
   */
  get isWritable () {
    return Boolean(this.outboundStream)
  }

  /**
   * Send a message to this peer.
   * Throws if there is no `stream` to write to available.
   *
   * @param {Uint8Array} data
   * @returns {void}
   */
  write (data) {
    if (!this.isWritable) {
      const id = this.id.toB58String()
      throw new Error('No writable connection to ' + id)
    }

    // @ts-ignore - this.outboundStream could be null
    this.outboundStream.push(data)
  }

  /**
   * Attach a raw inbound stream and setup a read stream
   *
   * @param {DuplexIterableStream} stream
   * @returns {void}
   */
  attachInboundStream (stream) {
    // Create and attach a new inbound stream
    // The inbound stream is:
    // - abortable, set to only return on abort, rather than throw
    // - transformed with length-prefix transform
    this._inboundAbortController = new AbortController()
    this._rawInboundStream = stream
    // @ts-ignore - abortable returns AsyncIterable and not a DuplexIterableStream
    this.inboundStream = abortable(
      pipe(
        this._rawInboundStream,
        lp.decode()
      ),
      // @ts-ignore - possibly null
      this._inboundAbortController.signal,
      { returnOnAbort: true }
    )

    this.emit('stream:inbound')
  }

  /**
   * Attach a raw outbound stream and setup a write stream
   *
   * @param {DuplexIterableStream} stream
   * @returns {Promise<void>}
   */
  async attachOutboundStream (stream) {
    // If an outbound stream already exists,
    // gently close it
    const _prevStream = this.outboundStream
    if (_prevStream) {
      // End the stream without emitting a close event
      // @ts-ignore - outboundStream may be null
      await this.outboundStream.end(false)
    }

    this._rawOutboundStream = stream
    this.outboundStream = pushable({
      onEnd: (shouldEmit) => {
        // close writable side of the stream
        // @ts-ignore - DuplexIterableStream does not define reset
        this._rawOutboundStream && this._rawOutboundStream.reset && this._rawOutboundStream.reset()
        this._rawOutboundStream = null
        this.outboundStream = null
        // @ts-ignore - shouldEmit is `Error | undefined` so condition is
        // always false
        if (shouldEmit !== false) {
          this.emit('close')
        }
      }
    })

    pipe(
      this.outboundStream,
      lp.encode(),
      this._rawOutboundStream
    ).catch(err => {
      log.error(err)
    })

    // Only emit if the connection is new
    if (!_prevStream) {
      this.emit('stream:outbound')
    }
  }

  /**
   * Closes the open connection to peer
   *
   * @returns {void}
   */
  close () {
    // End the outbound stream
    if (this.outboundStream) {
      this.outboundStream.end()
    }
    // End the inbound stream
    if (this.inboundStream) {
      // @ts-ignore - possibly null
      this._inboundAbortController.abort()
    }

    this._rawOutboundStream = null
    this.outboundStream = null
    this._rawInboundStream = null
    this.inboundStream = null
    this.emit('close')
  }
}

module.exports = PeerStreams