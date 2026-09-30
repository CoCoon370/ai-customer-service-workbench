import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "workbench_session";
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export function createSessionToken(bytes: Uint8Array = randomBytes(32)): string {
  if (bytes.byteLength !== 32) throw new Error("session token source must contain 32 bytes");
  return Buffer.from(bytes).toString("hex");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function shouldUseSecureCookie(nodeEnv: string | undefined, url: URL): boolean {
  return nodeEnv === "production" && url.protocol === "https:";
}

export function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function expiredSessionCookie(secure = false): string {
  return [
    `${SESSION_COOKIE}=`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
