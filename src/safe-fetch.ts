// Guarded download of a public zip for deploy_frontend (hosted mode). The URL
// comes from the model, so the server must never be steered at its own
// network: https only, every address the host resolves to must be public,
// redirects are followed by hand and checked at every hop, the connection is
// pinned to the address that was checked, and the body is cut off as soon as
// it passes the size limit.
import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** The 16 bytes of an IPv6 address, or null when it does not parse. */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    if (isIP(tail[1]) !== 4) return null;
    const p = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

/**
 * True only for a globally routable unicast address. Private, loopback,
 * link-local, CGNAT, multicast, unspecified and documentation ranges are
 * refused, in IPv4 and IPv6. IPv4-mapped (::ffff:a.b.c.d), the deprecated
 * IPv4-compatible form and NAT64 (64:ff9b::a.b.c.d) are judged by the IPv4
 * address inside. Anything that does not parse is refused.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.split("%")[0];
  const kind = isIP(bare);
  if (kind === 4) return !blocked.check(bare, "ipv4");
  if (kind !== 6) return false;
  const b = ipv6Bytes(bare);
  if (!b) return false;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  const mapped = zeros(0, 10) && b[10] === 255 && b[11] === 255;
  const compatible = zeros(0, 12) && !zeros(12, 16) && !(zeros(12, 15) && b[15] === 1);
  const nat64 = b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12);
  if (mapped || compatible || nat64) return !blocked.check(v4, "ipv4");
  const text = Array.from({ length: 8 }, (_, i) => ((b[i * 2] << 8) | b[i * 2 + 1]).toString(16)).join(":");
  return !blocked.check(text, "ipv6");
}

export type ResolvedAddress = { address: string; family: number };
export type Resolver = (host: string) => Promise<ResolvedAddress[]>;
export type ZipResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Buffer | Uint8Array>;
  destroy: () => void;
};
/** One request to the validated address. Replaceable in tests. */
export type Requester = (url: URL, pinned: ResolvedAddress) => Promise<ZipResponse>;

const defaultResolver: Resolver = (host) => dnsLookup(host, { all: true });

// The socket connects to the address that was just validated (the lookup
// callback hands back that exact address), so a second DNS answer cannot
// swap in a private one between the check and the connection. TLS still
// verifies the certificate against the original host name.
const defaultRequester: Requester = (url, pinned) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: { accept: "application/zip, application/octet-stream, */*" },
        lookup: ((_host: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          // Node may ask for all addresses or for one; answer in the shape asked.
          if (opts?.all) cb(null, [pinned]);
          else cb(null, pinned.address, pinned.family);
        }) as never,
        timeout: 30_000,
      },
      (res) =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: res,
          destroy: () => res.destroy(),
        }),
    );
    req.on("timeout", () => req.destroy(new Error("The download timed out.")));
    req.on("error", reject);
    req.end();
  });

export const MAX_REDIRECTS = 3;

/** https only, host resolves only to public addresses; returns the address to connect to. */
async function validate(raw: string, resolve: Resolver): Promise<{ url: URL; pinned: ResolvedAddress }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("zipUrl is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("zipUrl must be https.");
  if (url.username || url.password) throw new Error("zipUrl must not carry credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: ResolvedAddress[];
  if (isIP(host)) {
    addrs = [{ address: host, family: isIP(host) }];
  } else {
    try {
      addrs = await resolve(host);
    } catch {
      throw new Error("zipUrl host could not be resolved.");
    }
  }
  if (addrs.length === 0 || addrs.some((a) => !isPublicAddress(a.address))) {
    throw new Error("zipUrl must point at a public host, not a private address.");
  }
  return { url, pinned: addrs[0] };
}

/**
 * Downloads a zip from a public https URL. Follows at most MAX_REDIRECTS
 * redirects itself and re-checks scheme, host and resolved addresses at every
 * hop. The body is read as a stream and the download is aborted once it passes
 * maxBytes, whatever content-length claims.
 */
export async function downloadPublicZip(
  rawUrl: string,
  maxBytes: number,
  deps: { resolve?: Resolver; request?: Requester } = {},
): Promise<Buffer> {
  const resolve = deps.resolve ?? defaultResolver;
  const request = deps.request ?? defaultRequester;
  const tooBig = () =>
    new Error(
      `Bundle is over the ${Math.round(maxBytes / 1024 / 1024)}MB limit. Static frontends should not embed large media; upload those as attachments instead.`,
    );
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url, pinned } = await validate(current, resolve);
    const res = await request(url, pinned);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      res.destroy();
      if (hop === MAX_REDIRECTS) throw new Error(`zipUrl redirected more than ${MAX_REDIRECTS} times.`);
      current = new URL(String(res.headers.location), url).toString();
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      res.destroy();
      throw new Error(`Could not download zipUrl: HTTP ${res.status}.`);
    }
    if (Number(res.headers["content-length"] || 0) > maxBytes) {
      res.destroy();
      throw tooBig();
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        res.destroy();
        throw tooBig();
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error(`zipUrl redirected more than ${MAX_REDIRECTS} times.`);
}
