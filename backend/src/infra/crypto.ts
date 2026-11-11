import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";

/** Encrypts secrets at rest (the Google refresh token). */
export interface Encryptor {
  encrypt(plain: string): Promise<string>;
  decrypt(cipher: string): Promise<string>;
}

export class KmsEncryptor implements Encryptor {
  constructor(private keyId: string, private kms = new KMSClient({})) {}
  async encrypt(plain: string) {
    const r = await this.kms.send(new EncryptCommand({ KeyId: this.keyId, Plaintext: Buffer.from(plain) }));
    return Buffer.from(r.CiphertextBlob!).toString("base64");
  }
  async decrypt(cipher: string) {
    const r = await this.kms.send(new DecryptCommand({ KeyId: this.keyId, CiphertextBlob: Buffer.from(cipher, "base64") }));
    return Buffer.from(r.Plaintext!).toString();
  }
}

/** Test/local only: reversible, NOT secure. */
export class PlainEncryptor implements Encryptor {
  async encrypt(p: string) { return `plain:${p}`; }
  async decrypt(c: string) { return c.replace(/^plain:/, ""); }
}
