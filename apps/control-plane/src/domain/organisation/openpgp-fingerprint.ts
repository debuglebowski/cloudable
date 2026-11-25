import { createHash } from "node:crypto";

/**
 * The fingerprint of an ASCII-armored OpenPGP public key's primary key, upper-case hex.
 *
 * Just enough OpenPGP to name a key: dearmor, read the first packet, check it is a
 * public-key packet (tag 6), and hash it the way RFC 4880 (v4: SHA-1) and RFC 9580
 * (v5, v6: SHA-256) say. It does not verify signatures or self-certifications: apt does
 * that on the machine. The fingerprint is what an approver compares with the vendor's
 * published one, and what the record keeps.
 *
 * Returns null for anything that is not one armored public key block.
 */
export function openPgpFingerprint(armored: string): string | null {
  const bytes = dearmor(armored);
  if (!bytes) return null;
  const packet = firstPacket(bytes);
  if (!packet || packet.tag !== 6 || packet.body.length < 1) return null;
  const body = packet.body;
  const version = body[0];
  if (version === 4) {
    const prefix = Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
    return createHash("sha1").update(prefix).update(body).digest("hex").toUpperCase();
  }
  if (version === 5 || version === 6) {
    const prefix = Buffer.alloc(5);
    prefix[0] = version === 5 ? 0x9a : 0x9b;
    prefix.writeUInt32BE(body.length, 1);
    return createHash("sha256").update(prefix).update(body).digest("hex").toUpperCase();
  }
  return null;
}

const BEGIN = "-----BEGIN PGP PUBLIC KEY BLOCK-----";
const END = "-----END PGP PUBLIC KEY BLOCK-----";

function dearmor(text: string): Buffer | null {
  const lines = text.replace(/\r\n/g, "\n").trim().split("\n");
  if (lines[0]?.trim() !== BEGIN) return null;
  const end = lines.findIndex((line) => line.trim() === END);
  if (end === -1 || end !== lines.length - 1) return null;
  // Armor headers ("Version: ...") run until the first blank line.
  let i = 1;
  while (i < end && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes(":")) i++;
  const data: string[] = [];
  for (; i < end; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    if (line.startsWith("=")) break; // CRC-24 checksum line
    if (!/^[A-Za-z0-9+/=]+$/.test(line)) return null;
    data.push(line);
  }
  if (data.length === 0) return null;
  const decoded = Buffer.from(data.join(""), "base64");
  return decoded.length > 0 ? decoded : null;
}

function firstPacket(bytes: Buffer): { tag: number; body: Buffer } | null {
  const b0 = bytes[0];
  if (b0 === undefined || (b0 & 0x80) === 0) return null;
  let offset: number;
  let length: number;
  let tag: number;
  if (b0 & 0x40) {
    // New format.
    tag = b0 & 0x3f;
    const l0 = bytes[1];
    if (l0 === undefined) return null;
    if (l0 < 192) {
      length = l0;
      offset = 2;
    } else if (l0 < 224) {
      const l1 = bytes[2];
      if (l1 === undefined) return null;
      length = ((l0 - 192) << 8) + l1 + 192;
      offset = 3;
    } else if (l0 === 255) {
      if (bytes.length < 6) return null;
      length = bytes.readUInt32BE(2);
      offset = 6;
    } else {
      return null; // partial body lengths never frame a key packet
    }
  } else {
    // Old format.
    tag = (b0 >> 2) & 0x0f;
    const lengthType = b0 & 0x03;
    if (lengthType === 0) {
      const l = bytes[1];
      if (l === undefined) return null;
      length = l;
      offset = 2;
    } else if (lengthType === 1) {
      if (bytes.length < 3) return null;
      length = bytes.readUInt16BE(1);
      offset = 3;
    } else if (lengthType === 2) {
      if (bytes.length < 5) return null;
      length = bytes.readUInt32BE(1);
      offset = 5;
    } else {
      return null;
    }
  }
  if (offset + length > bytes.length) return null;
  return { tag, body: bytes.subarray(offset, offset + length) };
}
