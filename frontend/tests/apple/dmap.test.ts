import { describe, it, expect } from "vitest";
import {
  writeDmapContainer,
  writeDmapUInt32,
  writeDmapUInt8,
  writeDmapString,
  writeDmapEmpty,
  parseDmap,
  findTag,
  findTags,
  readNumericValue,
} from "../../src/apple/dmap";

describe("apple/dmap", () => {
  describe("write", () => {
    it("should encode a uint32 element", () => {
      const buf = writeDmapUInt32("mstc", 305419896); // 0x12345678
      // tag: 4 bytes, length: 4 bytes, payload: 4 bytes = 12 bytes
      expect(buf.length).toBe(12);
      const tag = new TextDecoder().decode(buf.subarray(0, 4));
      expect(tag).toBe("mstc");
      // length = 4
      expect(buf[4]).toBe(0);
      expect(buf[5]).toBe(0);
      expect(buf[6]).toBe(0);
      expect(buf[7]).toBe(4);
      // value = 305419896 = 0x12345678
      expect(buf[8]).toBe(0x12);
      expect(buf[9]).toBe(0x34);
      expect(buf[10]).toBe(0x56);
      expect(buf[11]).toBe(0x78);
    });

    it("should encode a uint8 element", () => {
      const buf = writeDmapUInt8("mikd", 2);
      expect(buf.length).toBe(9); // 4 + 4 + 1
      const tag = new TextDecoder().decode(buf.subarray(0, 4));
      expect(tag).toBe("mikd");
      expect(buf[7]).toBe(1); // length = 1
      expect(buf[8]).toBe(2); // value
    });

    it("should encode a string element", () => {
      const buf = writeDmapString("aeBI", "com.example.app");
      const tag = new TextDecoder().decode(buf.subarray(0, 4));
      expect(tag).toBe("aeBI");
      // length should be the string UTF-8 byte length
      const len = (buf[4] << 24) | (buf[5] << 16) | (buf[6] << 8) | buf[7];
      expect(len).toBe("com.example.app".length);
      const value = new TextDecoder().decode(buf.subarray(8, 8 + len));
      expect(value).toBe("com.example.app");
    });

    it("should encode an empty element", () => {
      const buf = writeDmapEmpty("aetl");
      expect(buf.length).toBe(8); // 4 + 4 + 0
      expect(buf[7]).toBe(0); // length = 0
    });

    it("should encode a container with children", () => {
      const child = writeDmapUInt32("mlid", 42);
      const container = writeDmapContainer("adsr", [child]);
      const tag = new TextDecoder().decode(container.subarray(0, 4));
      expect(tag).toBe("adsr");
      // length should be child's length
      const len = (container[4] << 24) | (container[5] << 16) | (container[6] << 8) | container[7];
      expect(len).toBe(child.length);
    });

    it("should reject non-4-byte tags", () => {
      expect(() => writeDmapUInt32("abc", 1)).toThrow("exactly 4");
    });
  });

  describe("parse", () => {
    it("should parse a uint32 element", () => {
      const buf = writeDmapUInt32("mstc", 1700000000);
      const nodes = parseDmap(buf);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].tag).toBe("mstc");
      expect(nodes[0].uint32Value).toBe(1700000000);
    });

    it("should parse a uint8 element", () => {
      const buf = writeDmapUInt8("mikd", 2);
      const nodes = parseDmap(buf);
      expect(nodes[0].uint8Value).toBe(2);
    });

    it("should parse a string element", () => {
      const buf = writeDmapString("aeBI", "com.example.app");
      const nodes = parseDmap(buf);
      expect(nodes[0].stringValue).toBe("com.example.app");
    });

    it("should parse an empty element", () => {
      const buf = writeDmapEmpty("aetl");
      const nodes = parseDmap(buf);
      expect(nodes[0].length).toBe(0);
    });

    it("should parse a container with nested children", () => {
      const child = writeDmapUInt32("mlid", 42);
      const container = writeDmapContainer("adsr", [child]);
      const nodes = parseDmap(container);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].tag).toBe("adsr");
      expect(nodes[0].children).toHaveLength(1);
      expect(nodes[0].children[0].tag).toBe("mlid");
      expect(nodes[0].children[0].uint32Value).toBe(42);
    });

    it("should round-trip a complex structure", () => {
      const body = writeDmapContainer("adsr", [
        writeDmapUInt32("mstc", 1700000000),
        writeDmapUInt32("mlid", 12345),
        writeDmapUInt8("mikd", 2),
        writeDmapUInt32("musr", 67890),
        writeDmapUInt32("mder", 0),
        writeDmapString("mque", "test-query"),
        writeDmapEmpty("aetl"),
      ]);

      const nodes = parseDmap(body);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].tag).toBe("adsr");
      expect(nodes[0].children).toHaveLength(7);

      const mstc = findTag(nodes, "mstc");
      expect(mstc?.uint32Value).toBe(1700000000);

      const mlid = findTag(nodes, "mlid");
      expect(mlid?.uint32Value).toBe(12345);

      const mikd = findTag(nodes, "mikd");
      expect(mikd?.uint8Value).toBe(2);

      const musr = findTag(nodes, "musr");
      expect(musr?.uint32Value).toBe(67890);

      const mder = findTag(nodes, "mder");
      expect(mder?.uint32Value).toBe(0);

      const mque = findTag(nodes, "mque");
      expect(mque?.stringValue).toBe("test-query");

      const aetl = findTag(nodes, "aetl");
      expect(aetl?.length).toBe(0);
    });

    it("should handle 4-byte aeSI (adamId)", () => {
      // aeSI as uint32
      const buf = writeDmapUInt32("aeSI", 1234567890);
      const nodes = parseDmap(buf);
      expect(nodes[0].tag).toBe("aeSI");
      expect(nodes[0].uint32Value).toBe(1234567890);
      expect(readNumericValue(nodes[0])).toBe(1234567890);
    });

    it("should handle 8-byte aeSI (adamId)", () => {
      // aeSI as uint64 — manually construct 8-byte payload
      const tag = new TextEncoder().encode("aeSI");
      const length = new Uint8Array([0, 0, 0, 8]);
      const value = new Uint8Array([0, 0, 0, 0, 0x49, 0x96, 0x02, 0xd2]); // 1234567890 as 64-bit
      const buf = new Uint8Array(4 + 4 + 8);
      buf.set(tag, 0);
      buf.set(length, 4);
      buf.set(value, 8);

      const nodes = parseDmap(buf);
      expect(nodes[0].tag).toBe("aeSI");
      expect(nodes[0].uint64Value).toBe(1234567890n);
      expect(readNumericValue(nodes[0])).toBe(1234567890);
    });

    it("should parse a full mlit response structure", () => {
      // Build a mock adbs → mlcl → mlit response
      const mlit = writeDmapContainer("mlit", [
        writeDmapUInt32("aeSI", 100), // 4-byte adamId
        writeDmapString("aeBI", "com.test.app"),
        writeDmapString("aeLN", "Test App"),
        writeDmapString("aePd", "1.2.3"),
        writeDmapUInt32("asdp", 1600000000),
        writeDmapUInt32("aeMk", 131072),
        writeDmapUInt32("aeSS", 3), // iPhone + iPad
      ]);

      const mlcl = writeDmapContainer("mlcl", [mlit]);
      const adbs = writeDmapContainer("adbs", [
        writeDmapUInt32("mstt", 200),
        mlcl,
      ]);

      const nodes = parseDmap(adbs);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].tag).toBe("adbs");

      const mstt = findTag(nodes, "mstt");
      expect(mstt?.uint32Value).toBe(200);

      const mlitNodes = findTags(nodes, "mlit");
      expect(mlitNodes).toHaveLength(1);

      const aeSI = findTag(mlitNodes[0].children, "aeSI");
      expect(readNumericValue(aeSI!)).toBe(100);

      const aeBI = findTag(mlitNodes[0].children, "aeBI");
      expect(aeBI?.stringValue).toBe("com.test.app");

      const aeLN = findTag(mlitNodes[0].children, "aeLN");
      expect(aeLN?.stringValue).toBe("Test App");

      const aePd = findTag(mlitNodes[0].children, "aePd");
      expect(aePd?.stringValue).toBe("1.2.3");

      const asdp = findTag(mlitNodes[0].children, "asdp");
      expect(asdp?.uint32Value).toBe(1600000000);

      const aeMk = findTag(mlitNodes[0].children, "aeMk");
      expect(aeMk?.uint32Value).toBe(131072);

      const aeSS = findTag(mlitNodes[0].children, "aeSS");
      expect(aeSS?.uint32Value).toBe(3);
    });

    it("should handle multiple mlit items", () => {
      const mlit1 = writeDmapContainer("mlit", [
        writeDmapUInt32("aeSI", 1),
        writeDmapString("aeLN", "App One"),
      ]);
      const mlit2 = writeDmapContainer("mlit", [
        writeDmapUInt32("aeSI", 2),
        writeDmapString("aeLN", "App Two"),
      ]);
      const mlcl = writeDmapContainer("mlcl", [mlit1, mlit2]);
      const adbs = writeDmapContainer("adbs", [mlcl]);

      const nodes = parseDmap(adbs);
      const mlitNodes = findTags(nodes, "mlit");
      expect(mlitNodes).toHaveLength(2);
      expect(mlitNodes[0].children[0].uint32Value).toBe(1);
      expect(mlitNodes[1].children[0].uint32Value).toBe(2);
    });

    it("should not throw on truncated input", () => {
      const buf = new Uint8Array([0, 0, 0, 0]); // too short for even a tag
      expect(() => parseDmap(buf)).not.toThrow();
      expect(parseDmap(buf)).toEqual([]);
    });

    it("should not throw on partial payload", () => {
      // Valid header but declared length exceeds buffer
      const buf = new Uint8Array([0x61, 0x65, 0x53, 0x49, 0, 0, 0, 20, 1, 2, 3]);
      expect(() => parseDmap(buf)).not.toThrow();
      const nodes = parseDmap(buf);
      expect(nodes).toHaveLength(0); // truncated, stops gracefully
    });

    it("should skip unknown tags as data", () => {
      // Unknown tag with 4-byte payload — parsed as uint32 (pragmatic)
      const tag = new TextEncoder().encode("XXXX");
      const length = new Uint8Array([0, 0, 0, 4]);
      const payload = new Uint8Array([1, 2, 3, 4]);
      const buf = new Uint8Array(4 + 4 + 4);
      buf.set(tag, 0);
      buf.set(length, 4);
      buf.set(payload, 8);

      const nodes = parseDmap(buf);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].tag).toBe("XXXX");
      expect(nodes[0].length).toBe(4);
      // 4-byte payloads are pragmatically parsed as uint32
      expect(nodes[0].uint32Value).toBe(0x01020304);
      // Unknown tags don't get string interpretation
      expect(nodes[0].stringValue).toBeUndefined();
    });

    it("should handle minm as name fallback", () => {
      const mlit = writeDmapContainer("mlit", [
        writeDmapUInt32("aeSI", 42),
        writeDmapString("minm", "Fallback Name"),
      ]);
      const nodes = parseDmap(mlit);
      const minm = findTag(nodes, "minm");
      expect(minm?.stringValue).toBe("Fallback Name");
    });
  });

  describe("findTag / findTags", () => {
    it("should find a tag at any depth", () => {
      const inner = writeDmapContainer("mlit", [
        writeDmapUInt32("aeSI", 99),
      ]);
      const mlcl = writeDmapContainer("mlcl", [inner]);
      const adbs = writeDmapContainer("adbs", [mlcl]);

      const nodes = parseDmap(adbs);
      const aeSI = findTag(nodes, "aeSI");
      expect(aeSI?.uint32Value).toBe(99);
    });

    it("findTags should return all matching tags", () => {
      const mlit1 = writeDmapContainer("mlit", [writeDmapUInt32("aeSI", 1)]);
      const mlit2 = writeDmapContainer("mlit", [writeDmapUInt32("aeSI", 2)]);
      const mlcl = writeDmapContainer("mlcl", [mlit1, mlit2]);
      const adbs = writeDmapContainer("adbs", [mlcl]);

      const nodes = parseDmap(adbs);
      const mlits = findTags(nodes, "mlit");
      expect(mlits).toHaveLength(2);
    });

    it("should return undefined for missing tag", () => {
      const nodes = parseDmap(writeDmapUInt32("mstc", 1));
      expect(findTag(nodes, "nonexistent")).toBeUndefined();
    });
  });

  describe("hardening (F-B)", () => {
    it("must terminate on a declared length with bit 31 set", () => {
      // "mstt" + length 0xFFFFFFF8. Before the `>>> 0` fix, `<< 24` produced a
      // NEGATIVE length, which defeated the truncation check and left `offset`
      // stuck at 0 — a non-terminating parse loop (the reviewer reproduced it).
      const bytes = new Uint8Array([
        0x6d, 0x73, 0x74, 0x74, // "mstt"
        0xff, 0xff, 0xff, 0xf8, // length 0xFFFFFFF8
      ]);
      expect(() => parseDmap(bytes)).not.toThrow();
      expect(parseDmap(bytes)).toEqual([]);
    });

    it("must read a 4-byte value with bit 31 set as unsigned", () => {
      const bytes = new Uint8Array([
        0x6d, 0x73, 0x74, 0x63, // "mstc"
        0x00, 0x00, 0x00, 0x04, // length 4
        0xff, 0xff, 0xff, 0xf8, // value 0xFFFFFFF8
      ]);
      const nodes = parseDmap(bytes);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].uint32Value).toBe(0xfffffff8);
      expect(readNumericValue(nodes[0])).toBe(0xfffffff8);
    });

    it("must cap container nesting instead of exhausting the stack", () => {
      // 200 nested containers, well past MAX_CONTAINER_DEPTH (16).
      let nested = writeDmapEmpty("aetl");
      for (let i = 0; i < 200; i++) {
        nested = writeDmapContainer("adbs", [nested]);
      }
      expect(() => parseDmap(nested)).not.toThrow();
    });
  });
});