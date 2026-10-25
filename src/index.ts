type Bindings = Record<string, unknown>;

interface Config {
  exactSize: boolean;
  hideDotfiles: boolean;
  listingTtl: number;
  fileTtl: number;
  purgeToken?: string;
}

interface Mount {
  name: string; // URL segment, "" when the bucket is served at "/"
  bucket: R2Bucket;
}

// Cache API refuses bodies above 512 MB, don't even try.
const MAX_CACHEABLE_SIZE = 512 * 1024 * 1024;
// R2 returns at most 1000 entries per list call; stop after this many pages.
const MAX_LIST_PAGES = 20;
// nginx truncates names longer than this (NGX_HTTP_AUTOINDEX_NAME_LEN).
const NAME_LEN = 50;

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "405 Method Not Allowed", { Allow: "GET, HEAD" });
    }

    const config = readConfig(env);
    const mounts = findBuckets(env);
    if (mounts.length === 0) {
      return text(
        500,
        "500 No R2 bucket bound. Add one to r2_buckets in wrangler.jsonc, or in the dashboard\n" +
          "under Workers & Pages > r2-index > Settings > Bindings > Add > R2 bucket.",
      );
    }

    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return text(400, "400 Bad Request");
    }
    const cleanUrl = new URL(url.pathname, url.origin).toString();

    if (url.searchParams.has("purge")) {
      if (
        config.purgeToken &&
        !safeEqual(url.searchParams.get("purge") ?? "", config.purgeToken)
      ) {
        return text(403, "403 Forbidden");
      }
      await caches.default.delete(new Request(cleanUrl));
      return Response.redirect(cleanUrl, 302);
    }

    // Resolve which bucket and which key the path points to.
    let mount: Mount;
    let key: string;
    if (mounts.length === 1 && mounts[0].name === "") {
      mount = mounts[0];
      key = pathname.slice(1);
    } else {
      if (pathname === "/") {
        return respond(request, renderBucketIndex(mounts), config.listingTtl);
      }
      const [segment, ...rest] = pathname.slice(1).split("/");
      const found = mounts.find((m) => m.name === segment);
      if (!found) return text(404, "404 Not Found");
      if (rest.length === 0) return redirect(url, `${url.pathname}/`);
      mount = found;
      key = rest.join("/");
    }

    if (key !== "" && !key.endsWith("/")) {
      const file = await serveFile(
        request,
        mount.bucket,
        key,
        cleanUrl,
        config,
        ctx,
      );
      if (file) return file;

      // No object with that key, maybe it's a directory requested without the trailing slash.
      const probe = await mount.bucket.list({ prefix: `${key}/`, limit: 1 });
      if (probe.objects.length > 0 || probe.delimitedPrefixes.length > 0) {
        return redirect(url, `${url.pathname}/`);
      }
      return text(404, "404 Not Found");
    }

    return serveListing(request, mount, key, pathname, cleanUrl, config, ctx);
  },
} satisfies ExportedHandler<Bindings>;

function readConfig(env: Bindings): Config {
  const flag = (v: unknown, fallback: boolean) =>
    v === undefined ? fallback : String(v) === "true";
  const int = (v: unknown, fallback: number) => {
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    exactSize: flag(env.AUTOINDEX_EXACT_SIZE, false),
    hideDotfiles: flag(env.HIDE_DOTFILES, true),
    listingTtl: int(env.LISTING_CACHE_TTL, 30),
    fileTtl: int(env.FILE_CACHE_TTL, 3600),
    purgeToken:
      typeof env.PURGE_TOKEN === "string" && env.PURGE_TOKEN !== ""
        ? env.PURGE_TOKEN
        : undefined,
  };
}

function findBuckets(env: Bindings): Mount[] {
  const buckets = Object.entries(env)
    .filter(([, value]) => isR2Bucket(value))
    .map(([binding, value]) => ({
      name: binding.toLowerCase(),
      bucket: value as R2Bucket,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (buckets.length === 1) buckets[0].name = "";
  return buckets;
}

function isR2Bucket(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return ["head", "get", "list", "put", "createMultipartUpload"].every(
    (m) => typeof v[m] === "function",
  );
}

async function serveFile(
  request: Request,
  bucket: R2Bucket,
  key: string,
  cleanUrl: string,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const cache = caches.default;
  const range = request.headers.get("range");

  // The Cache API answers Range and conditional requests on its own.
  const cacheKey = new Request(cleanUrl, { headers: request.headers });
  const cached = await cache.match(cacheKey);
  if (cached) return withoutBodyIfHead(request, cached);

  let object: R2Object | R2ObjectBody | null;
  try {
    object = await bucket.get(key, {
      onlyIf: request.headers,
      ...(range ? { range: request.headers } : {}),
    });
  } catch {
    // R2 throws on ranges it can't satisfy.
    const head = await bucket.head(key);
    if (!head) return null;
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${head.size}` },
    });
  }
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  if (!headers.has("Cache-Control")) {
    headers.set(
      "Cache-Control",
      `public, max-age=${config.fileTtl}, stale-while-revalidate=86400`,
    );
  }

  // Precondition failed: R2 hands back the metadata without a body.
  if (!("body" in object)) {
    const status =
      request.headers.has("if-none-match") ||
      request.headers.has("if-modified-since")
        ? 304
        : 412;
    return new Response(null, { status, headers });
  }

  if (range && object.range) {
    const contentRange = rangeHeader(object);
    if (!contentRange) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${object.size}` },
      });
    }
    headers.set("Content-Range", contentRange.header);
    headers.set("Content-Length", String(contentRange.length));
    return withoutBodyIfHead(
      request,
      new Response(object.body, { status: 206, headers }),
    );
  }

  headers.set("Content-Length", String(object.size));
  const response = new Response(object.body, { headers });
  if (request.method === "GET" && object.size <= MAX_CACHEABLE_SIZE) {
    ctx.waitUntil(
      cache.put(new Request(cleanUrl), response.clone()).catch(() => {}),
    );
  }
  return withoutBodyIfHead(request, response);
}

function rangeHeader(
  object: R2ObjectBody,
): { header: string; length: number } | undefined {
  // R2 may fill every field of the range, some as undefined, so don't narrow on `in`.
  const r = object.range as {
    offset?: number;
    length?: number;
    suffix?: number;
  };
  let start: number;
  let end: number;
  if (r.suffix !== undefined) {
    start = Math.max(0, object.size - r.suffix);
    end = object.size - 1;
  } else {
    start = r.offset ?? 0;
    end = Math.min(
      r.length !== undefined ? start + r.length - 1 : object.size - 1,
      object.size - 1,
    );
  }
  if (start >= object.size || end < start) return undefined;
  return {
    header: `bytes ${start}-${end}/${object.size}`,
    length: end - start + 1,
  };
}

async function serveListing(
  request: Request,
  mount: Mount,
  prefix: string,
  pathname: string,
  cleanUrl: string,
  config: Config,
  ctx: ExecutionContext,
): Promise<Response> {
  const cache = caches.default;
  const cacheKey = new Request(cleanUrl);
  const cached = await cache.match(cacheKey);
  if (cached) return withoutBodyIfHead(request, cached);

  const dirs: string[] = [];
  const files: R2Object[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page === MAX_LIST_PAGES) {
      truncated = true;
      break;
    }
    const listed = await mount.bucket.list({ prefix, delimiter: "/", cursor });
    dirs.push(...listed.delimitedPrefixes);
    files.push(...listed.objects);
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }

  // Nothing under this prefix: the directory doesn't exist (the bucket root always does).
  if (prefix !== "" && dirs.length === 0 && files.length === 0) {
    return text(404, "404 Not Found");
  }

  const hidden = (name: string) =>
    name === "" || (config.hideDotfiles && name.startsWith("."));
  const rows: string[] = [];
  const parentLink = prefix !== "" || mount.name !== "";
  if (parentLink) rows.push(`<a href="../">../</a>`);

  for (const dir of dirs) {
    const name = dir.slice(prefix.length);
    if (hidden(name.slice(0, -1))) continue;
    rows.push(row(name, "-", "-"));
  }
  for (const obj of files) {
    const name = obj.key.slice(prefix.length);
    if (hidden(name)) continue;
    rows.push(
      row(
        name,
        formatDate(obj.uploaded),
        config.exactSize ? String(obj.size) : formatSize(obj.size),
      ),
    );
  }
  if (truncated)
    rows.push(`\n[listing truncated after ${MAX_LIST_PAGES * 1000} entries]`);

  const response = htmlResponse(renderPage(pathname, rows), config.listingTtl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withoutBodyIfHead(request, response);
}

function renderBucketIndex(mounts: Mount[]): string {
  return renderPage(
    "/",
    mounts.map((m) => row(`${m.name}/`, "-", "-")),
  );
}

function respond(request: Request, html: string, ttl: number): Response {
  return withoutBodyIfHead(request, htmlResponse(html, ttl));
}

function htmlResponse(html: string, ttl: number): Response {
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, s-maxage=${ttl}, stale-while-revalidate=600`,
    },
  });
}

// One line of the listing, laid out exactly like nginx: name padded to 50 columns,
// date, then the size right-aligned in a 19-column field.
function row(name: string, date: string, size: string): string {
  const href = name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const chars = Array.from(name);
  const display =
    chars.length > NAME_LEN
      ? `${chars.slice(0, NAME_LEN - 3).join("")}..>`
      : name;
  const pad = " ".repeat(NAME_LEN + 1 - Array.from(display).length);
  return `<a href="${escapeHtml(href)}">${escapeHtml(display)}</a>${pad}${date.padEnd(17)} ${size.padStart(19)}`;
}

function renderPage(pathname: string, rows: string[]): string {
  const title = `Index of ${escapeHtml(pathname)}`;
  return `<html>
<head><title>${title}</title></head>
<body>
<h1>${title}</h1><hr><pre>${rows.join("\n")}
</pre><hr></body>
</html>
`;
}

function formatDate(d: Date): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

// Same rounding as nginx with autoindex_exact_size off: plain bytes up to 9999, then rounded K/M/G.
function formatSize(bytes: number): string {
  const units: [number, string][] = [
    [1024 ** 3, "G"],
    [1024 ** 2, "M"],
    [1024, "K"],
  ];
  for (const [unit, suffix] of units) {
    if (bytes >= unit && (suffix !== "K" || bytes > 9999)) {
      return `${Math.round(bytes / unit)}${suffix}`;
    }
  }
  return String(bytes);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function withoutBodyIfHead(request: Request, response: Response): Response {
  return request.method === "HEAD" ? new Response(null, response) : response;
}

function redirect(url: URL, pathname: string): Response {
  return Response.redirect(
    new URL(pathname + url.search, url.origin).toString(),
    301,
  );
}

function text(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}
