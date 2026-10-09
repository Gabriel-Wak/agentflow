import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

/** Criptografa segredos (tokens, senhas, connection strings) antes de salvar no banco. */
function key(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("ENCRYPTION_KEY não configurada.");
  const buf = Buffer.from(raw, "base64");
  // Aceita qualquer string: deriva 32 bytes se não vier no formato esperado.
  return buf.length === 32 ? buf : createHash("sha256").update(raw).digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return "";
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function mask(secret: string): string {
  if (!secret) return "";
  return secret.length <= 8 ? "••••" : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
