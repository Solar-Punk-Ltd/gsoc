import {
  Bytes,
  Data,
  FlexBytes,
  HexString,
  PostageBatchId,
  PostageStamp,
  PrefixedHexString,
  SignerFn,
} from './types'
import { Utils } from '@nugaon/bmt-js'
// For ESM compatibility
import pkg from 'elliptic'
const { ec } = pkg

const UNCOMPRESSED_RECOVERY_ID = 27

export const keccak256Hash = Utils.keccak256Hash

export function getConsensualPrivateKey(resource: string | Uint8Array): Bytes<32> {
  if (isBytes(resource, 32)) {
    return resource
  }
  if (isHexString(resource) && resource.length === 64) {
    return hexToBytes<32>(resource)
  }

  return keccak256Hash(resource)
}

export function isPostageBatchId(value: unknown): value is PostageBatchId {
  return isHexString(value) && value.length === 64
}

export function isPostageStamp(value: unknown): value is PostageStamp {
  return isHexString(value) && value.length === 226
}

function publicKeyToAddress(pubBytes: number[]): Bytes<20> {
  return keccak256Hash(pubBytes.slice(1)).slice(12) as Bytes<20>
}

function hashWithEthereumPrefix(data: Uint8Array): Bytes<32> {
  const ethereumSignedMessagePrefix = `\x19Ethereum Signed Message:\n${data.length}`
  const prefixBytes = new TextEncoder().encode(ethereumSignedMessagePrefix)

  return keccak256Hash(prefixBytes, data)
}

/**
 * The default signer function that can be used for integrating with
 * other applications (e.g. wallets).
 *
 * @param data      The data to be signed
 * @param privateKey  The private key used for signing the data
 * @returns signature
 */
function defaultSign(data: Uint8Array, privateKey: Bytes<32>): Bytes<65> {
  const curve = new ec('secp256k1')
  const keyPair = curve.keyFromPrivate(privateKey)

  const hashedDigest = hashWithEthereumPrefix(data)
  const sigRaw = curve.sign(hashedDigest, keyPair, { canonical: true, pers: undefined })

  if (sigRaw.recoveryParam === null) {
    throw new Error('signDigest recovery param was null')
  }
  const signature = new Uint8Array([
    ...sigRaw.r.toArray('be', 32),
    ...sigRaw.s.toArray('be', 32),
    sigRaw.recoveryParam + UNCOMPRESSED_RECOVERY_ID,
  ])

  return signature as Bytes<65>
}

/**
 * Creates a singer object that can be used when the private key is known.
 *
 * @param privateKey The private key
 */
function makePrivateKeySigner(privateKey: Bytes<32>): SignerFn {
  const curve = new ec('secp256k1')
  const keyPair = curve.keyFromPrivate(privateKey)
  const address = publicKeyToAddress(keyPair.getPublic().encode('array', false))

  return {
    sign: (digest: Uint8Array) => defaultSign(digest, privateKey),
    address,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function isStrictlyObject(value: unknown): value is Record<string, unknown> {
  return isObject(value) && !Array.isArray(value)
}

function assertSignerFn(signer: unknown): asserts signer is SignerFn {
  if (!isStrictlyObject(signer)) {
    throw new TypeError('Signer must be an object!')
  }

  const typedSigner = signer as SignerFn

  if (!isBytes(typedSigner.address, 20)) {
    throw new TypeError("Signer's address must be Uint8Array with 20 bytes!")
  }

  if (typeof typedSigner.sign !== 'function') {
    throw new TypeError('Signer sign property needs to be function!')
  }
}

export function makeSigner(signer: SignerFn | Uint8Array | string | unknown): SignerFn {
  if (typeof signer === 'string') {
    const hexKey = makeHexString(signer, 64)
    const keyBytes = hexToBytes<32>(hexKey) // HexString is verified for 64 length => 32 is guaranteed

    return makePrivateKeySigner(keyBytes)
  } else if (signer instanceof Uint8Array) {
    assertBytes(signer, 32)

    return makePrivateKeySigner(signer)
  }

  assertSignerFn(signer)

  return signer
}

/**
 * @notice Returns true if the segment A is within proximity order minimum of B
 * @param a 32 bytes.
 * @param b 32 bytes.
 * @param minimum Minimum proximity order.
 */
export function inProximity(a: Uint8Array, b: Uint8Array, minimum: number): boolean {
  if (a.length !== b.length || a.length !== 32) throw new Error('Lengths are incorrect at proximity check')

  let byteIndex = 0
  let remaningBits = minimum
  while (remaningBits > 0) {
    if (remaningBits >= 8) {
      if (a[byteIndex] !== b[byteIndex]) return false
      byteIndex++
      remaningBits -= 8
    } else {
      const aBits = a[byteIndex] >>> (8 - remaningBits)
      const bBits = b[byteIndex] >>> (8 - remaningBits)

      return aBits === bBits
    }
  }

  return true // minimum === 0
}

/**
 * Type guard for `Bytes<T>` type
 *
 * @param b       The byte array
 * @param length  The length of the byte array
 */
export function isBytes<Length extends number>(b: unknown, length: Length): b is Bytes<Length> {
  return b instanceof Uint8Array && b.length === length
}

/**
 * Verifies if a byte array has a certain length
 *
 * @param b       The byte array
 * @param length  The specified length
 */
export function assertBytes<Length extends number>(b: unknown, length: Length): asserts b is Bytes<Length> {
  if (!isBytes(b, length)) {
    throw new TypeError(`Parameter is not valid Bytes of length: ${length} !== ${(b as Uint8Array).length}`)
  }
}

/**
 * Helper function for serialize byte arrays
 *
 * @param arrays Any number of byte array arguments
 */
export function serializeBytes(...arrays: Uint8Array[]): Uint8Array {
  const length = arrays.reduce((prev, curr) => prev + curr.length, 0)
  const buffer = new Uint8Array(length)
  let offset = 0
  arrays.forEach(arr => {
    buffer.set(arr, offset)
    offset += arr.length
  })

  return buffer
}

/**
 * Converts array of number or Uint8Array to HexString without prefix.
 *
 * @param bytes   The input array
 * @param len     The length of the non prefixed HexString
 */
export function bytesToHex<Length extends number = number>(
  bytes: Uint8Array,
  len?: Length,
): HexString<Length> {
  const hexByte = (n: number) => n.toString(16).padStart(2, '0')
  const hex = Array.from(bytes, hexByte).join('') as HexString<Length>

  if (len && hex.length !== len) {
    throw new TypeError(`Resulting HexString does not have expected length ${len}: ${hex}`)
  }

  return hex
}

/**
 * Converts integer number to hex string.
 *
 * Optionally provides '0x' prefix or padding
 *
 * @param int         The positive integer to be converted
 * @param len     The length of the non prefixed HexString
 */
export function intToHex<Length extends number = number>(int: number, len?: Length): HexString<Length> {
  if (!Number.isInteger(int)) throw new TypeError('the value provided is not integer')

  if (int > Number.MAX_SAFE_INTEGER) throw new TypeError('the value provided exceeds safe integer')

  if (int < 0) throw new TypeError('the value provided is a negative integer')
  const hex = int.toString(16) as HexString<Length>

  if (len && hex.length !== len) {
    throw new TypeError(`Resulting HexString does not have expected length ${len}: ${hex}`)
  }

  return hex
}

/**
 * Converts a hex string to Uint8Array
 *
 * @param hex string input without 0x prefix!
 */
export function hexToBytes<Length extends number, LengthHex extends number = number>(
  hex: HexString<LengthHex>,
): Bytes<Length> {
  assertHexString(hex)

  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    const hexByte = hex.substr(i * 2, 2)
    bytes[i] = parseInt(hexByte, 16)
  }

  return bytes as Bytes<Length>
}

/**
 * Type guard for HexStrings.
 * Requires no 0x prefix!
 *
 * @param s string input
 * @param len expected length of the HexString
 */
export function isHexString<Length extends number = number>(
  s: unknown,
  len?: number,
): s is HexString<Length> {
  return typeof s === 'string' && /^[0-9a-f]+$/i.test(s) && (!len || s.length === len)
}

/**
 * Type guard for PrefixedHexStrings.
 * Does enforce presence of 0x prefix!
 *
 * @param s string input
 */
export function isPrefixedHexString(s: unknown): s is PrefixedHexString {
  return typeof s === 'string' && /^0x[0-9a-f]+$/i.test(s)
}

export function serializePayload(userPayload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(userPayload))
}

export function deserializePayload(data: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(data))
  } catch (e) {
    throw new Error('Cannot deserialize JSON data')
  }
}

function assertHexString<Length extends number = number>(
  s: unknown,
  len?: number,
  name = 'value',
): asserts s is HexString<Length> {
  if (!isHexString(s, len)) {
    if (isPrefixedHexString(s)) {
      throw new TypeError(`${name} not valid non prefixed hex string (has 0x prefix): ${s}`)
    }

    // Don't display length error if no length specified in order not to confuse user
    const lengthMsg = len ? ` of length ${len}` : ''
    throw new TypeError(`${name} not valid hex string${lengthMsg}: ${s}`)
  }
}

/**
 * Creates unprefixed hex string from wide range of data.
 *
 * @param input
 * @param len of the resulting HexString WITHOUT prefix!
 */
export function makeHexString<L extends number>(
  input: string | number | Uint8Array | unknown,
  len?: L,
): HexString<L> {
  if (typeof input === 'number') {
    return intToHex<L>(input, len)
  }

  if (input instanceof Uint8Array) {
    return bytesToHex<L>(input, len)
  }

  if (typeof input === 'string') {
    if (isPrefixedHexString(input)) {
      const hex = input.slice(2) as HexString<L>

      if (len && hex.length !== len) {
        throw new TypeError(`Length mismatch for valid hex string. Expecting length ${len}: ${hex}`)
      }

      return hex
    } else {
      // We use assertHexString() as there might be more reasons why a string is not valid hex string
      // and usage of isHexString() would not give enough information to the user on what is going
      // wrong.
      assertHexString<L>(input, len)

      return input
    }
  }

  throw new TypeError('Not HexString compatible type!')
}

export function wrapBytesWithHelpers(data: Uint8Array): Data {
  return Object.assign(data, {
    text: () => new TextDecoder('utf-8').decode(data),
    json: () => JSON.parse(new TextDecoder('utf-8').decode(data)),
    hex: () => bytesToHex(data),
  })
}

/**
 * Returns true if two byte arrays are equal
 *
 * @param a Byte array to compare
 * @param b Byte array to compare
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * Return flex bytes starting from `offset`
 *
 * @param data   The original data
 * @param offset The offset to start from
 * @param _min   The minimum size of the data
 * @param _max   The maximum size of the data
 */
export function flexBytesAtOffset<Min extends number, Max extends number>(
  data: Uint8Array,
  offset: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _min: Min,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _max: Max,
): FlexBytes<Min, Max> {
  return data.slice(offset) as FlexBytes<Min, Max>
}
