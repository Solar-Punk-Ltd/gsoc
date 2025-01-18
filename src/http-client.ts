import { makeChunk } from '@nugaon/bmt-js'
import WebSocket from 'isomorphic-ws'
import { Bytes, Data, PostageBatchId, PostageBatchOptions, PostageStamp, Reference, SignerFn } from './types'
import { makeSingleOwnerChunk, makeSOCAddress, SingleOwnerChunk } from './soc'
import {
  bytesToHex,
  isPostageBatchId,
  isPostageStamp,
  isStrictlyObject,
  serializeBytes,
  wrapBytesWithHelpers,
} from './utils'
import axios, { AxiosAdapter, AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios'

/**
 * Helper function to create and upload SOC.
 */
export async function uploadSingleOwnerChunkData(
  requestOptions: BeeRequestOptions,
  postageBatchId: PostageBatchId | PostageStamp,
  signer: SignerFn,
  identifier: Bytes<32>,
  payload: Uint8Array,
  options?: UploadOptions,
): Promise<SingleOwnerChunk> {
  const cac = makeChunk(payload)
  const soc = await makeSingleOwnerChunk(cac, identifier, signer)

  const owner = bytesToHex(soc.owner())
  const id = bytesToHex(identifier)
  const signature = bytesToHex(soc.signature())
  const data = serializeBytes(soc.span(), soc.payload)

  await uploadSoc(requestOptions, owner, id, signature, data, postageBatchId, options)

  return soc
}

export async function downloadSingleOwnerChunkData(
  requestOptions: BeeRequestOptions,
  signer: SignerFn,
  identifier: Bytes<32>,
) {
  const address = makeSOCAddress(identifier, signer.address)
  const addressHex = bytesToHex(address)

  return downloadChunk(requestOptions, addressHex)
}

/**
 * Subscribe to messages for given topic with GSOC
 *
 * @param address SOC address under which payloads
 * @param handler Message handler interface
 *
 * @returns close() function on websocket connection
 */
export function gsocSubscribe(baseUrl: string, address: string, handler: SubscriptionHandler): () => void {
  assertSubscriptionHandler(handler)

  if (typeof address !== 'string' || address.length !== 64) {
    throw new TypeError('soc address has to be an string and 32 bytes!')
  }

  const ws = webSocket(baseUrl, `gsoc/subscribe/${address}`)

  let closed = false
  const close = () => {
    if (closed === false) {
      closed = true

      // although the WebSocket API offers a `close` function, it seems that
      // with the library that we are using (isomorphic-ws) it doesn't close
      // the websocket properly, whereas `terminate` does
      if (ws.terminate) ws.terminate()
      else ws.close() // standard Websocket in browser does not have terminate function
    }
  }

  ws.onmessage = async ev => {
    const data = await prepareWebsocketData(ev.data)

    // ignore empty messages
    if (data.length > 0) {
      handler.onMessage(wrapBytesWithHelpers(data))
    }
  }
  ws.onerror = ev => {
    // ignore errors after subscription was cancelled
    if (!closed) {
      handler.onError(new BeeError(ev.message))
    }
  }

  return close
}

/**
 * Upload single owner chunk (SOC) to a Bee node
 *
 * @param requestOptions  BeeRequestOptions
 * @param owner           Owner's ethereum address in hex
 * @param identifier      Arbitrary identifier in hex
 * @param signature       Signature in hex
 * @param data            Content addressed chunk data to be uploaded
 * @param postageBatchId  Postage BatchId that will be assigned to uploaded data
 * @param options         Additional options like tag, encryption, pinning
 */
async function uploadSoc(
  requestOptions: BeeRequestOptions,
  owner: string,
  identifier: string,
  signature: string,
  data: Uint8Array,
  postage: PostageBatchId | PostageStamp,
  options?: UploadOptions,
): Promise<Reference> {
  const response = await http<ReferenceResponse>({
    ...requestOptions,
    method: 'post',
    url: `soc/${owner}/${identifier}`,
    data,
    headers: {
      'content-type': 'application/octet-stream',
      ...extractUploadHeaders(postage, options),
    },
    responseType: 'json',
    params: { sig: signature },
  })

  return response.data.reference
}

/**
 * Download chunk data as a byte array
 *
 * @param requestOptions Options for making requests
 * @param hash Bee content reference
 *
 */
export async function downloadChunk(requestOptions: BeeRequestOptions, hash: string): Promise<Uint8Array> {
  const response = await http<ArrayBuffer>({
    ...requestOptions,
    method: 'get',
    url: `chunks/${hash}`,
    responseType: 'arraybuffer',
  })

  return new Uint8Array(response.data)
}

/**
 * create postage batch
 * @returns postage batch id
 */
export async function createPostageBatch(
  requestOptions: BeeRequestOptions,
  amount: string,
  depth: number,
  options?: PostageBatchOptions,
): Promise<PostageBatchId> {
  const headers: Record<string, string> = requestOptions.headers || {}
  if (options?.gasPrice) {
    headers['gas-price'] = options.gasPrice.toString()
  }
  if (options?.immutableFlag !== undefined) {
    headers.immutable = String(options.immutableFlag)
  }

  const response = await http<{ batchID: string }>({
    ...requestOptions,
    method: 'post',
    url: `stamps/${amount}/${depth}`,
    responseType: 'json',
    params: { label: options?.label },
    headers,
  })

  if (options?.waitForUsable) {
    const timeout = 100_000
    for (let time = 0; time < timeout; time += 3_000) {
      try {
        const batch = await getPostageBatch(requestOptions, response.data.batchID as PostageBatchId)
        if (batch.usable) {
          break
        }
      } catch (e) {
        // ignore errors and try again
      }

      await new Promise(resolve => setTimeout(resolve, 3_000)) // wait 3s
    }
  }

  return response.data.batchID as PostageBatchId
}

/**
 * list postage batches
 * @returns postage batch id
 */
export async function listPostageBatches(requestOptions: BeeRequestOptions): Promise<PostageBatch[]> {
  const response = await http<{
    stamps: PostageBatch[]
  }>({
    ...requestOptions,
    method: 'get',
    url: 'stamps',
    responseType: 'json',
  })

  return response.data.stamps
}

export async function getPostageBatch(
  requestOptions: BeeRequestOptions,
  postageBatchId: PostageBatchId,
): Promise<PostageBatch> {
  const response = await http<PostageBatch>({
    ...requestOptions,
    method: 'get',
    url: `stamps/${postageBatchId}`,
    responseType: 'json',
  })

  return response.data
}

export async function getNodeAddresses(requestOptions: BeeRequestOptions): Promise<NodeAddresses> {
  const response = await http<NodeAddresses>({
    ...requestOptions,
    url: 'addresses',
    responseType: 'json',
  })

  return response.data
}

function assertSubscriptionHandler(value: unknown): asserts value is SubscriptionHandler {
  if (!isStrictlyObject(value)) {
    throw new TypeError('SubscriptionHandler has to be object!')
  }

  const handler = value as unknown as SubscriptionHandler

  if (typeof handler.onMessage !== 'function') {
    throw new TypeError('onMessage property of SubscriptionHandler has to be function!')
  }

  if (typeof handler.onError !== 'function') {
    throw new TypeError('onError property of SubscriptionHandler has to be function!')
  }
}

async function prepareWebsocketData(data: unknown): Promise<Uint8Array | never> {
  if (typeof data === 'string') return new TextEncoder().encode(data)

  if (data instanceof Buffer) return new Uint8Array(data)

  if (data instanceof ArrayBuffer) return new Uint8Array(data)

  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())

  throw new TypeError('unknown websocket data type')
}

/**
 * Creates websocket on the given path
 *
 * @param url Bee node URL
 * @param topic Topic name
 */
function webSocket(url: string, path: string): WebSocket {
  const wsUrl = url.replace(/^http/i, 'ws')

  return new WebSocket(`${wsUrl}/${path}`)
}

function extractUploadHeaders(
  postage: PostageBatchId | PostageStamp,
  options?: UploadOptions,
): Record<string, string> {
  const headers: Record<string, string> = {}

  if (isPostageBatchId(postage)) {
    headers['swarm-postage-batch-id'] = postage
  } else if (isPostageStamp(postage)) {
    headers['swarm-postage-stamp'] = postage
  } else {
    throw Error(
      'Postage is invalid. Define either a postage batch id or a postage stamp (coming from envelope)',
    )
  }

  if (options?.pin) {
    headers['swarm-pin'] = String(options.pin)
  }

  if (options?.encrypt) {
    headers['swarm-encrypt'] = String(options.encrypt)
  }

  if (options?.tag) {
    headers['swarm-tag'] = String(options.tag)
  }

  if (typeof options?.deferred === 'boolean') {
    headers['swarm-deferred-upload'] = options.deferred.toString()
  }

  return headers
}

/**
 * Main function to make HTTP requests.
 * @param options User defined settings
 * @param config Internal settings and/or Bee settings
 */
async function http<T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  try {
    config.headers ||= {}
    config.headers = { ...DEFAULT_HTTP_CONFIG.headers, ...config.headers }

    const response = await axios(config)

    return response as AxiosResponse<T>
  } catch (e: unknown) {
    if (e instanceof AxiosError) {
      throw new BeeResponseError(e.message, e.code, e.status, e.response?.status, e.config, e.response)
    }
    throw e
  }
}

const DEFAULT_HTTP_CONFIG: AxiosRequestConfig = {
  headers: {
    accept: 'application/json, text/plain, */*',
  },
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
}

interface ReferenceResponse {
  reference: Reference
}

export interface SubscriptionHandler<T = Data> {
  onMessage: (message: T) => void
  onError: (error: Error) => void
}

export type BeeRequestOptions = {
  baseURL?: string
  timeout?: number
  retry?: number | false
  headers?: Record<string, string>
  adapter?: AxiosAdapter
}

interface UploadOptions {
  /**
   * Will pin the data locally in the Bee node as well.
   *
   * Locally pinned data is possible to reupload to network if it disappear.
   *
   * @see [Bee docs - Pinning](https://docs.ethswarm.org/docs/access-the-swarm/pinning)
   * @see [Bee API reference - `POST /bzz`](https://docs.ethswarm.org/api/#tag/Collection/paths/~1bzz/post)
   */
  pin?: boolean

  /**
   * Will encrypt the uploaded data and return longer hash which also includes the decryption key.
   *
   * @see [Bee docs - Store with Encryption](https://docs.ethswarm.org/docs/access-the-swarm/store-with-encryption)
   * @see [Bee API reference - `POST /bzz`](https://docs.ethswarm.org/api/#tag/Collection/paths/~1bzz/post)
   * @see Reference
   */
  encrypt?: boolean

  /**
   * Tags keep track of syncing the data with network. This option allows attach existing Tag UUID to the uploaded data.
   *
   * @see [Bee API reference - `POST /bzz`](https://docs.ethswarm.org/api/#tag/Collection/paths/~1bzz/post)
   * @see [Bee docs - Syncing / Tags](https://docs.ethswarm.org/docs/access-the-swarm/syncing)
   * @link Tag
   */
  tag?: number

  /**
   * Determines if the uploaded data should be sent to the network immediately (eq. deferred=false) or in a deferred fashion (eq. deferred=true).
   *
   * With deferred style client uploads all the data to Bee node first and only then Bee node starts push the data to network itself. The progress of this upload can be tracked with tags.
   * With non-deferred style client uploads the data to Bee which immediately starts pushing the data to network. The request is only finished once all the data was pushed through the Bee node to the network.
   *
   * In future there will be move to the non-deferred style and even the support for deferred upload will be removed from Bee itself.
   *
   * @default true
   */
  deferred?: boolean
}

/** ERRORS */

class BeeError extends Error {
  public constructor(message: string) {
    super(message)
  }
}

class BeeResponseError extends BeeError {
  public constructor(
    message: string,
    public code?: string,
    public axiosStatus?: number,
    public status?: number,
    public config?: AxiosRequestConfig,
    public response?: AxiosResponse,
  ) {
    super(message)
  }
}

/**
 * Interface representing Postage stamp batch.
 */
interface PostageBatch {
  batchID: PostageBatchId
  utilization: number
  usable: boolean
  label: '' | string
  depth: number
  amount: string
  bucketDepth: number
  blockNumber: number
  immutableFlag: boolean
  /**
   * The time (in seconds) remaining until the batch expires; -1 signals that the batch never expires; 0 signals that the batch has already expired.
   */
  batchTTL: number

  exists: boolean
}

interface NodeAddresses {
  overlay: string
  underlay: string[]
  ethereum: string // 40 length hex string
  publicKey: string // 66 length hex string
  pssPublicKey: string // 66 length hex string
}
