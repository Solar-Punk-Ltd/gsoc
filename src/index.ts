import { MAX_PAYLOAD_SIZE, MIN_PAYLOAD_SIZE, SOC_PAYLOAD_OFFSET } from './contants'
import {
  BeeRequestOptions,
  downloadSingleOwnerChunkData,
  gsocSubscribe,
  SubscriptionHandler,
  uploadSingleOwnerChunkData,
} from './http-client'
import { makeSOCAddress, SingleOwnerChunk } from './soc'
import { Bytes, Data, HexString, PostageBatchId, PostageStamp, SignerFn } from './types'
import {
  bytesToHex,
  flexBytesAtOffset,
  getConsensualPrivateKey,
  hexToBytes,
  inProximity,
  isHexString,
  keccak256Hash,
  makeSigner,
  serializePayload,
  wrapBytesWithHelpers,
} from './utils'

export const DEFAULT_RESOURCE_ID = 'any'
const DEFAULT_POSTAGE_BATCH_ID =
  '0000000000000000000000000000000000000000000000000000000000000000' as PostageBatchId
const DEFAULT_CONSENSUS_ID = 'SimpleGraffiti:v1' // used at information signaling

/**
 * InformationSignal is for reading and writing a GSOC topic
 */
export class InformationSignal<UserPayload = InformationSignalRecord> {
  public postage: PostageBatchId | PostageStamp
  private beeApiUrl: string
  /** Graffiti Identifier */
  private consensusHash: Bytes<32>
  private assertGraffitiRecord: (unknown: unknown) => asserts unknown is UserPayload

  constructor(beeApiUrl: string, options?: BaseConstructorOptions<UserPayload>) {
    assertBeeUrl(beeApiUrl)
    this.beeApiUrl = beeApiUrl
    this.postage = (options?.postage ?? DEFAULT_POSTAGE_BATCH_ID) as PostageBatchId
    this.assertGraffitiRecord = options?.consensus?.assertRecord ?? assertInformationSignalRecord
    this.consensusHash = keccak256Hash(options?.consensus?.id ?? DEFAULT_CONSENSUS_ID)

    if (!isHexString(this.postage)) {
      throw new Error('Postage batch id or postage stamp has to be a hex string!')
    }
  }

  /**
   * Subscribe to messages for given topic with GSOC
   *
   * **Warning! If connected Bee node is a light node, then it will never receive any message!**
   * This is because light nodes does not fully participate in the data exchange in Swarm network and hence the message won't arrive to them.
   *
   * @param messageHandler hook function on newly received messages
   * @param resourceID the common topic for the GSOC records. It can be a hex string without 0x prefix to have it without conversation.
   * @returns close() function on websocket connection and GSOC address
   */
  subscribe(
    messageHandler: SubscriptionHandler<UserPayload>,
    resourceId: string | Uint8Array = DEFAULT_RESOURCE_ID,
  ): {
    close: () => void
    gsocAddress: Bytes<32>
  } {
    const graffitiKey = getConsensualPrivateKey(resourceId)
    const graffitiSigner = makeSigner(graffitiKey)
    const gsocAddress = makeSOCAddress(this.consensusHash, graffitiSigner.address)

    const insiderHandler = {
      onMessage: (data: Data) => {
        try {
          const json = data.json()
          this.assertGraffitiRecord(json)
          messageHandler.onMessage(json)
        } catch (e) {
          messageHandler.onError(e as Error)
        }
      },
      onError: messageHandler.onError,
    }
    const close = gsocSubscribe(this.beeApiUrl, bytesToHex(gsocAddress), insiderHandler)

    return {
      close,
      gsocAddress,
    }
  }

  /**
   * Same as subscribe() method but with different name
   */
  listen(
    messageHandler: SubscriptionHandler<UserPayload>,
    resourceId: string | Uint8Array = DEFAULT_RESOURCE_ID,
  ): {
    close: () => void
    gsocAddress: Bytes<32>
  } {
    return this.subscribe(messageHandler, resourceId)
  }

  async getLatestGsocData(
    resourceId: string | Uint8Array = DEFAULT_RESOURCE_ID,
    requestOptions?: BeeRequestOptions,
  ): Promise<Data> {
    const graffitiKey = getConsensualPrivateKey(resourceId)
    const graffitiSigner = makeSigner(graffitiKey)

    const data = await downloadSingleOwnerChunkData(
      { baseURL: this.beeApiUrl, ...requestOptions },
      graffitiSigner,
      this.consensusHash,
    )

    const payload = flexBytesAtOffset(data, SOC_PAYLOAD_OFFSET, MIN_PAYLOAD_SIZE, MAX_PAYLOAD_SIZE)

    return wrapBytesWithHelpers(new Uint8Array(payload))
  }

  /**
   * Write GSOC and upload to the Swarm network
   *
   * @param data GSOC payload
   * @param resourceID the common topic for the GSOC records. It can be a hex string without 0x prefix to have it without conversation.
   */
  async write(
    data: UserPayload,
    resourceId: string | Uint8Array = DEFAULT_RESOURCE_ID,
    stamp?: PostageBatchId | PostageStamp,
    requestOptions?: BeeRequestOptions,
  ): Promise<SingleOwnerChunk> {
    this.assertGraffitiRecord(data)
    const graffitiKey = getConsensualPrivateKey(resourceId)
    const graffitiSigner = makeSigner(graffitiKey)

    return uploadSingleOwnerChunkData(
      { baseURL: this.beeApiUrl, ...requestOptions },
      stamp || this.postage,
      graffitiSigner,
      this.consensusHash,
      serializePayload(data),
    )
  }

  /**
   * Same as write() method but with different name
   */
  async send(
    data: UserPayload,
    resourceId: string | Uint8Array = DEFAULT_RESOURCE_ID,
  ): Promise<SingleOwnerChunk> {
    return this.write(data, resourceId)
  }

  /**
   * Mine the resource ID respect to the given address of Bee node and storage depth
   * so that the GSOC will fall within the neighborhood of the Bee node.
   *
   * @param beeAddress Bee node 32 bytes address
   * @param storageDepth the depth of the storage on Swarm network
   * @returns mined resource ID and GSOC address
   */
  mineResourceId(
    beeAddress: Uint8Array | HexString,
    storageDepth: number,
  ): { resourceId: Bytes<32>; gsocAddress: Bytes<32> } {
    if (isHexString(beeAddress)) {
      beeAddress = hexToBytes(beeAddress)
    }
    if (typeof storageDepth !== 'number') {
      throw new Error('storageDepth argument must be a number')
    }
    if (storageDepth > 32) {
      throw new Error('Storage depth cannot be greater than 32!')
    }
    if (beeAddress.length !== 32) {
      throw new Error('Bee address has to be 32 bytes!')
    }

    const resourceId: Bytes<32> = new Uint8Array(32) as Bytes<32>
    let graffitiSigner: SignerFn
    let gsocAddress: Bytes<32>
    do {
      // increment resourceId array by one
      for (let i = 0; i < resourceId.length; i++) {
        if (resourceId[i] === 255) {
          resourceId[i] = 0
        } else {
          resourceId[i]++
          break
        }
      }

      graffitiSigner = makeSigner(resourceId)
      gsocAddress = makeSOCAddress(this.consensusHash, graffitiSigner.address)
    } while (!inProximity(beeAddress, gsocAddress, storageDepth))

    return { resourceId, gsocAddress: gsocAddress }
  }

  /**
   * Same as mineResourceId() method but with different name
   */
  mine(
    beeAddress: Uint8Array | HexString,
    storageDepth: number,
  ): { resourceId: Bytes<32>; gsocAddress: Bytes<32> } {
    return this.mineResourceId(beeAddress, storageDepth)
  }
}

/**
 * Validates that passed string is valid URL of Bee, if not it throws BeeArgumentError.
 * We support only HTTP and HTTPS protocols.
 * @param url
 * @throws BeeArgumentError if non valid URL
 */
function assertBeeUrl(url: unknown): asserts url is URL {
  if (!isValidBeeUrl(url)) {
    throw new Error('URL is not valid!')
  }
}

/**
 * Validates that passed string is valid URL of Bee.
 * We support only HTTP and HTTPS protocols.
 *
 * @param url
 */
function isValidBeeUrl(url: unknown): url is URL {
  try {
    if (typeof url !== 'string') {
      return false
    }

    const urlObject = new URL(url)

    // There can be wide range of protocols passed.
    return urlObject.protocol === 'http:' || urlObject.protocol === 'https:'
  } catch (e) {
    // URL constructor throws TypeError if not valid URL
    if (
      e instanceof TypeError ||
      ((e as { code: string }).code !== null && (e as { code: string }).code === 'ERR_INVALID_URL')
    ) {
      return false
    }

    throw e
  }
}

type InformationSignalRecord = string

function isInformationSignalRecord(value: unknown): value is InformationSignalRecord {
  return value !== null && typeof value === 'string'
}

function assertInformationSignalRecord(value: unknown): asserts value is InformationSignalRecord {
  if (!isInformationSignalRecord(value)) {
    throw new Error('Value is not a valid Graffiti Feed Record')
  }
}

interface BaseConstructorOptions<T = InformationSignalRecord> {
  consensus?: {
    /**
     * The used consensus identifier of the GraffitiFeed
     * Default: AnyThread:v1
     */
    id: string
    /**
     * Assertion function that throws an error if the parameter
     * does not satisfy the structural requirements.
     * record formats:
     * - PersonalStorageSignal: record in the personal storage.
     * - InformationSignal: record in the graffiti feed.
     * Default: assertAnyThreadComment
     * @param unknown any object for asserting
     */
    assertRecord: (unknown: unknown) => asserts unknown is T
  }
  /**
   * Swarm Postage Batch ID which is only required when write happens
   * It can be the serialized Postage Stamp as well (envelope API EP)
   * Default: 000000000000000000000000000000000000000000000
   */
  postage?: string
  /**
   * API Url of the Ethereum Swarm Bee client
   * Default: http://localhost:1633
   */
  beeApiUrl?: string
}
