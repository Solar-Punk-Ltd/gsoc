export const SIGNATURE_BYTES_LENGTH = 65

export type FlavoredType<Type, Name> = Type & { __tag__?: Name }

export type Signature = Bytes<typeof SIGNATURE_BYTES_LENGTH>

/**
 * Signing function that takes digest in Uint8Array  to be signed that has helpers to convert it
 * conveniently into other types like hex-string (non prefix).
 * Result of the signing can be returned either in Uint8Array or hex string form.
 *
 * @see Data
 */
type SyncSigner = (digest: Uint8Array) => Signature | string
type AsyncSigner = (digest: Uint8Array) => Promise<Signature | string>

/**
 * Interface for implementing Ethereum compatible signing.
 *
 * In order to be compatible with Ethereum and its signing method `personal_sign`, the data
 * that are passed to sign() function should be prefixed with: `\x19Ethereum Signed Message:\n${data.length}`, hashed
 * and only then signed.
 * If you are wrapping another signer tool/library (like Metamask or some other Ethereum wallet), you might not have
 * to do this prefixing manually if you use the `personal_sign` method. Check documentation of the tool!
 * If you are writing your own storage for keys, then you have to prefix the data manually otherwise the Bee node
 * will reject the chunks signed by you!
 *
 * For example see the hashWithEthereumPrefix() function.
 *
 * @property sign     The sign function that can be sync or async. This function takes non-prefixed data. See above.
 * @property address  The ethereum address of the signer in bytes.
 * @see hashWithEthereumPrefix
 */
export type SignerFn = {
  sign: SyncSigner | AsyncSigner
  address: Bytes<20>
}

export type PostageBatchId = HexString<64>

export type PostageStamp = HexString<226>

export interface Bytes<Length extends number> extends Uint8Array {
  readonly length: Length
}

export type Reference = FlavoredType<string, 'EthAddress'>
export type EthAddress = Bytes<20>

export type HexString<Length extends number = number> = FlavoredType<
  string & {
    readonly length: Length
  },
  'HexString'
>

export type PrefixedHexString = FlavoredType<string, 'PrefixedHexString'>

/**
 * Helper interface that adds utility functions
 * to work more conveniently with bytes in normal
 * user scenarios.
 *
 * Concretely: text(), hex(), json()
 */
export interface Data extends Uint8Array {
  /**
   * Converts the binary data using UTF-8 decoding into string.
   */
  text(): string

  /**
   * Converts the binary data into hex-string.
   */
  hex(): HexString

  /**
   * Converts the binary data into string which is then parsed into JSON.
   */
  json(): Record<string, unknown>
}

/**
 * Options for creation of postage batch
 */
export interface PostageBatchOptions {
  /**
   * Sets label for the postage batch
   */
  label?: string

  /**
   * Sets gas price in Wei for the transaction that creates the postage batch
   */
  gasPrice?: string
  immutableFlag?: boolean

  /**
   * The returned Promise will await until the purchased Postage Batch is usable.
   * In other word, it has to have enough block confirmations that Bee pronounce it usable.
   * When turned on, this significantly prolongs the creation of postage batch!
   *
   * If you plan to use the stamp right away for some action with Bee (like uploading using this stamp) it is
   * highly recommended to use this option, otherwise you might get errors "stamp not usable" from Bee.
   *
   * @default true
   */
  waitForUsable?: boolean

  /**
   * When waiting for the postage stamp to become usable, this specify the timeout for the waiting.
   * Default: 120s
   */
  waitForUsableTimeout?: number
}

/**
 * Helper type for dealing with flexible sized byte arrays.
 *
 * The actual min and and max values are not stored in runtime, they
 * are only there to differentiate the type from the Uint8Array at
 * compile time.
 * @see BrandedType
 */
export interface FlexBytes<Min extends number, Max extends number> extends Uint8Array {
  readonly __min__: Min
  readonly __max__: Max
}
