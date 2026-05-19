import { generateKeyPairSync, createSign } from "node:crypto";

export interface SelfSignedCert {
  key: string;
  cert: string;
}

// Mint a throwaway self-signed RSA X.509 cert for loopback testing.
// Returns PEM strings ready to drop into a TLS server config. We avoid
// adding a `selfsigned` or `node-forge` dep by hand-assembling the
// minimum DER structure Node's TLS layer will accept.
export function mintSelfSignedCert(commonName = "localhost", days = 1): SelfSignedCert {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  // SubjectPublicKeyInfo as DER bytes.
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + days * 86_400_000);

  // TBSCertificate ::= SEQUENCE {
  //   version       [0] INTEGER (v3),
  //   serialNumber  INTEGER,
  //   signature     AlgorithmIdentifier (sha256WithRSAEncryption),
  //   issuer        Name (CN=commonName),
  //   validity      Validity (notBefore, notAfter),
  //   subject       Name (CN=commonName, same as issuer for self-signed),
  //   subjectPublicKeyInfo SubjectPublicKeyInfo
  // }
  const version = der.tagged(0, der.integer(2)); // v3 (0-indexed)
  const serialNumber = der.integer(1);
  const sigAlgo = der.sequence([der.oid("1.2.840.113549.1.1.11"), der.nullValue()]); // sha256WithRSAEncryption
  const name = der.sequence([
    der.set([der.sequence([der.oid("2.5.4.3"), der.utf8String(commonName)])]),
  ]);
  const validity = der.sequence([der.utcTime(notBefore), der.utcTime(notAfter)]);

  const tbs = der.sequence([version, serialNumber, sigAlgo, name, validity, name, spkiDer]);

  // Sign the TBS bytes with the private key.
  const signer = createSign("RSA-SHA256");
  signer.update(tbs);
  const signature = signer.sign(privateKey);

  // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue BIT STRING }
  const certDer = der.sequence([tbs, sigAlgo, der.bitString(signature)]);

  const certPem = pem("CERTIFICATE", certDer);
  const keyPem = (privateKey.export({ type: "pkcs8", format: "pem" }) as string).trim();
  return { key: keyPem, cert: certPem };
}

// Minimal DER builders for the subset of ASN.1 we need. Tags follow
// X.690 universal class. All builders return raw Buffers.
const der = {
  length(n: number): Buffer {
    if (n < 0x80) return Buffer.from([n]);
    const bytes: number[] = [];
    while (n > 0) {
      bytes.unshift(n & 0xff);
      n >>>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
  },
  tag(tag: number, payload: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), der.length(payload.length), payload]);
  },
  sequence(children: Buffer[]): Buffer {
    return der.tag(0x30, Buffer.concat(children));
  },
  set(children: Buffer[]): Buffer {
    return der.tag(0x31, Buffer.concat(children));
  },
  tagged(num: number, inner: Buffer): Buffer {
    return der.tag(0xa0 | num, inner);
  },
  integer(value: number): Buffer {
    // Two's complement, minimum bytes, leading 0 if high bit set.
    const bytes: number[] = [];
    let v = value;
    do {
      bytes.unshift(v & 0xff);
      v >>>= 8;
    } while (v > 0);
    if (bytes[0] & 0x80) bytes.unshift(0);
    return der.tag(0x02, Buffer.from(bytes));
  },
  bitString(content: Buffer): Buffer {
    return der.tag(0x03, Buffer.concat([Buffer.from([0x00]), content])); // 0 unused bits
  },
  oid(oid: string): Buffer {
    const parts = oid.split(".").map(Number);
    const bytes: number[] = [40 * parts[0] + parts[1]];
    for (let i = 2; i < parts.length; i++) {
      const v = parts[i];
      if (v < 0x80) {
        bytes.push(v);
      } else {
        const out: number[] = [];
        let n = v;
        while (n > 0) {
          out.unshift((n & 0x7f) | 0x80);
          n >>>= 7;
        }
        out[out.length - 1] &= 0x7f;
        bytes.push(...out);
      }
    }
    return der.tag(0x06, Buffer.from(bytes));
  },
  utf8String(s: string): Buffer {
    return der.tag(0x0c, Buffer.from(s, "utf8"));
  },
  utcTime(d: Date): Buffer {
    const pad = (n: number) => String(n).padStart(2, "0");
    const s =
      pad(d.getUTCFullYear() % 100) +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) +
      "Z";
    return der.tag(0x17, Buffer.from(s, "ascii"));
  },
  nullValue(): Buffer {
    return Buffer.from([0x05, 0x00]);
  },
};

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
