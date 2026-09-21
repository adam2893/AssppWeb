// DMAP (Digital Media Access Protocol) codec for Apple's DAAP protocol.
// DMAP wire format: 4-byte ASCII tag + 4-byte big-endian length + payload.
// Containers nest other elements; leaf values are uint8, uint32, uint64, or string.

// ── Write helpers ──────────────────────────────────────────────────────────

function writeUInt32BE(value: number): Uint8Array {
  const buf = new Uint8Array(4);
  buf[0] = (value >> 24) & 0xff;
  buf[1] = (value >> 16) & 0xff;
  buf[2] = (value >> 8) & 0xff;
  buf[3] = value & 0xff;
  return buf;
}

function writeUInt8(value: number): Uint8Array {
  return new Uint8Array([value & 0xff]);
}

function writeDmapElement(tag: string, payload: Uint8Array): Uint8Array {
  const tagBytes = new TextEncoder().encode(tag);
  if (tagBytes.length !== 4) {
    throw new Error(`DMAP tag must be exactly 4 ASCII bytes: "${tag}"`);
  }
  const length = writeUInt32BE(payload.length);
  const result = new Uint8Array(4 + 4 + payload.length);
  result.set(tagBytes, 0);
  result.set(length, 4);
  result.set(payload, 8);
  return result;
}

/** Build a container element: tag + concatenated children. */
export function writeDmapContainer(tag: string, children: Uint8Array[]): Uint8Array {
  const totalLength = children.reduce((sum, c) => sum + c.length, 0);
  const payload = new Uint8Array(totalLength);
  let offset = 0;
  for (const child of children) {
    payload.set(child, offset);
    offset += child.length;
  }
  return writeDmapElement(tag, payload);
}

/** Build a uint32 DMAP element. */
export function writeDmapUInt32(tag: string, value: number): Uint8Array {
  return writeDmapElement(tag, writeUInt32BE(value));
}

/** Build a uint8 DMAP element. */
export function writeDmapUInt8(tag: string, value: number): Uint8Array {
  return writeDmapElement(tag, writeUInt8(value));
}

/** Build a string DMAP element (UTF-8 encoded). */
export function writeDmapString(tag: string, value: string): Uint8Array {
  return writeDmapElement(tag, new TextEncoder().encode(value));
}

/** Build an empty DMAP element (zero-length payload). */
export function writeDmapEmpty(tag: string): Uint8Array {
  return writeDmapElement(tag, new Uint8Array(0));
}

// ── Parse helpers ──────────────────────────────────────────────────────────

export interface DmapNode {
  /** 4-byte ASCII tag. */
  tag: string;
  /** Declared payload length. */
  length: number;
  /** Raw payload bytes (for containers, the concatenated children). */
  bytes: Uint8Array;
  /** Parsed children (only for container tags). */
  children: DmapNode[];
  /** Parsed uint8 value (length === 1). */
  uint8Value?: number;
  /** Parsed uint32 value (length === 4). */
  uint32Value?: number;
  /** Parsed uint64 value (length === 8). */
  uint64Value?: bigint;
  /** Parsed string value (UTF-8 decoded). */
  stringValue?: string;
}

// Tags known to be containers.
const CONTAINER_TAGS = new Set([
  "adsr", "adbs", "mlcl", "mlit", "mlog", "mupd",
  "cmst", "cmsr", "avdb",
  "apso", "aeFR", "aeSR", "aeFC", "aeS1", "aeS2", "aeS3",
]);

// Tags known to carry string values.
const STRING_TAGS = new Set([
  "aeBI", "aeLN", "minm", "aePd", "aeSN", "aeCD", "aeID",
  "aeTI", "aeMI", "aeOB", "aeTR", "aeUA", "aeUR",
  "mque",
]);

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  // `>>> 0` is required: without it `<< 24` yields a SIGNED int32, so any
  // length or value with bit 31 set becomes negative. A negative length
  // defeated the truncation check and made `offset += length` fail to
  // advance, producing a non-terminating parse loop.
  return (
    (((bytes[offset] & 0xff) << 24) |
      ((bytes[offset + 1] & 0xff) << 16) |
      ((bytes[offset + 2] & 0xff) << 8) |
      (bytes[offset + 3] & 0xff)) >>>
    0
  );
}

function readUInt64BE(bytes: Uint8Array, offset: number): bigint {
  const hi = BigInt(readUInt32BE(bytes, offset));
  const lo = BigInt(readUInt32BE(bytes, offset + 4));
  return (hi << 32n) | lo;
}

/**
 * Maximum container nesting we will recurse into. The reference implementation
 * caps at 16; the wire format never nests deeper than a handful of levels, so
 * this only ever fires on malformed/hostile input and prevents stack exhaustion.
 */
const MAX_CONTAINER_DEPTH = 16;

/**
 * Parse a DMAP-encoded buffer into a tree of DmapNode.
 * Unknown tags are preserved with their raw bytes; truncated input stops
 * gracefully without throwing.
 */
export function parseDmap(
  buffer: ArrayBuffer | Uint8Array,
  depth = 0,
): DmapNode[] {
  if (depth > MAX_CONTAINER_DEPTH) return [];

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const nodes: DmapNode[] = [];
  let offset = 0;

  while (offset + 8 <= bytes.length) {
    const tag = new TextDecoder().decode(bytes.subarray(offset, offset + 4));
    const length = readUInt32BE(bytes, offset + 4);
    offset += 8;

    if (offset + length > bytes.length) {
      // Truncated input — stop parsing without throwing.
      break;
    }

    const payload = bytes.subarray(offset, offset + length);
    offset += length;

    const node: DmapNode = {
      tag,
      length,
      bytes: payload,
      children: [],
    };

    if (CONTAINER_TAGS.has(tag) && length > 0) {
      node.children = parseDmap(payload, depth + 1);
    } else if (length === 1) {
      node.uint8Value = payload[0];
    } else if (length === 4) {
      node.uint32Value = readUInt32BE(payload, 0);
    } else if (length === 8) {
      node.uint64Value = readUInt64BE(payload, 0);
    }

    if (STRING_TAGS.has(tag) && length > 0) {
      node.stringValue = new TextDecoder().decode(payload);
    }

    nodes.push(node);
  }

  return nodes;
}

/** Find the first node with the given tag (depth-first). */
export function findTag(nodes: DmapNode[], tag: string): DmapNode | undefined {
  for (const node of nodes) {
    if (node.tag === tag) return node;
    if (node.children.length > 0) {
      const found = findTag(node.children, tag);
      if (found) return found;
    }
  }
  return undefined;
}

/** Find all nodes with the given tag (depth-first). */
export function findTags(nodes: DmapNode[], tag: string): DmapNode[] {
  const result: DmapNode[] = [];
  for (const node of nodes) {
    if (node.tag === tag) result.push(node);
    if (node.children.length > 0) {
      result.push(...findTags(node.children, tag));
    }
  }
  return result;
}

/**
 * Read a uint32 or uint64 value from a node, handling the 4-vs-8-byte case
 * (e.g. aeSI can be either). Returns Number (safe up to 2^53).
 */
export function readNumericValue(node: DmapNode): number | undefined {
  if (node.uint32Value !== undefined) return node.uint32Value;
  if (node.uint64Value !== undefined) {
    const n = node.uint64Value;
    if (n <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(n);
    }
    // Fall back to Number (may lose precision, but adamId fits in 48 bits).
    return Number(n);
  }
  return undefined;
}