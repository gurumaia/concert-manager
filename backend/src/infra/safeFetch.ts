import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import type { ImageFetcher } from "../domain/photos.js";

/** True for loopback, private, link-local, metadata, multicast and other non-public addresses (IPv4 and IPv6). */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const [a, b, c] = addr.split(".").map(Number) as [number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const x = addr.toLowerCase();
    const mapped = x.match(/^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    const hex = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const h = parseInt(hex[1]!, 16), l = parseInt(hex[2]!, 16); return isBlockedAddress(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`); }
    return (
      x === "::" || x === "::1" ||
      /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x) || // unique-local, link-local, multicast
      x.startsWith("64:ff9b:") || x.startsWith("2002:") || x.startsWith("2001:db8") || x.startsWith("::ffff:")
    );
  }
  return true; // not an IP at all
}

const MAX_REDIRECTS = 3;

/**
 * Downloads an image over https. Every connection (including redirects) resolves the host itself and refuses
 * non-public addresses, so a URL cannot be used to reach internal services or cloud metadata (SSRF).
 */
export const safeFetchImage: ImageFetcher = async (url, { maxBytes }) => {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== "https:") throw new Error("Only https image URLs are allowed");
    if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
    if (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, ""))) throw new Error("That address is not allowed");
    const res = await once(u, maxBytes);
    if (res.redirect) { current = new URL(res.redirect, u).toString(); continue; }
    return { data: res.data!, contentType: res.contentType };
  }
  throw new Error("Too many redirects");
};

function once(u: URL, maxBytes: number): Promise<{ redirect?: string; data?: Uint8Array; contentType?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      u,
      {
        method: "GET",
        timeout: 10_000,
        headers: { accept: "image/jpeg,image/png,image/webp,image/*;q=0.5", "user-agent": "ShowManager/1.0 (+photo import)" },
        // The check happens on the address actually connected to, which defeats DNS rebinding.
        lookup: (host, opts, cb) => {
          dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
            if (err) return (cb as any)(err);
            const list = addrs as unknown as Array<{ address: string; family: number }>;
            const bad = list.find((a) => isBlockedAddress(a.address));
            if (bad || !list.length) return (cb as any)(new Error("That address is not allowed"));
            if ((opts as any).all) return (cb as any)(null, list);
            return (cb as any)(null, list[0]!.address, list[0]!.family);
          });
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) { res.resume(); return resolve({ redirect: res.headers.location }); }
        if (status !== 200) { res.resume(); return reject(new Error(`The image server answered ${status}`)); }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > maxBytes) { res.destroy(); return reject(new Error("The image is too large")); }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > maxBytes) { res.destroy(); return reject(new Error("The image is too large")); }
          chunks.push(c);
        });
        res.on("end", () => resolve({ data: new Uint8Array(Buffer.concat(chunks)), contentType: res.headers["content-type"] }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The image server took too long")));
    req.on("error", reject);
    req.end();
  });
}
