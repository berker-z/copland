/* ============================================================================
   Private keys in PEM, for WebCrypto (githubApp.ts). GitHub hands out an
   App's key as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto imports RSA
   private keys only as PKCS#8, which is the same key in one more wrapper.
   No imports, so checks/github.check.ts can run it under plain node.
   ========================================================================== */

const b64 = (bytes: ArrayLike<number>) => btoa(String.fromCharCode(...Array.from(bytes)));


/** A PEM private key → PKCS#8 DER, base64. PKCS#1 ("RSA PRIVATE KEY") is wrapped; PKCS#8 passes through. */
export function pkcs8FromPem(pem: string): string {
  const body = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!pem.includes("BEGIN RSA PRIVATE KEY")) return b64(body);
  /* PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING { the PKCS#1 key } } */
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...rsaAlgorithm, ...der(0x04, body)];
  return b64(new Uint8Array(der(0x30, inner)));
}

/** One DER element: tag, length (short or long form), contents. */
function der(tag: number, contents: ArrayLike<number>): number[] {
  const n = contents.length;
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : n < 0x10000 ? [0x82, n >> 8, n & 0xff] : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return [tag, ...length, ...Array.from(contents)];
}
