/**
 * Identifier factory.
 *
 * Serialized projects reference nodes by opaque string ids so that cyclic
 * mechatronic wiring (relay → motor → relay) can be flattened into a tree.
 * We prefer `crypto.randomUUID` and fall back to a seeded-free Math.random
 * generator so the engine still boots in non-secure contexts (plain HTTP LAN
 * previews) where WebCrypto's UUID helper is unavailable.
 */

const hasCryptoUuid =
  typeof globalThis.crypto !== 'undefined' &&
  typeof globalThis.crypto.randomUUID === 'function'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function uuid() {
  if (hasCryptoUuid) return globalThis.crypto.randomUUID()
  let out = ''
  for (let i = 0; i < 32; i++) out += ALPHABET[(Math.random() * 16) | 0]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`
}

/** URL-safe short id (default 8 chars ≈ 2.8e12 keyspace). */
export function shortId(length = 8) {
  let out = ''
  const random = Math.random
  for (let i = 0; i < length; i++) out += ALPHABET[(random() * ALPHABET.length) | 0]
  return out
}

/** Human-readable node id, e.g. `ultrasonic_a1b2c3`. */
export function nodeId(type, length = 6) {
  const slug = String(type)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `${slug || 'node'}_${shortId(length)}`
}
