import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

export function serveStatic(req: IncomingMessage, res: ServerResponse, options: { root: string; fallback?: string }): boolean {
  if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) {
    return false;
  }
  const url = new URL(req.url, "http://localhost");
  const filePath = resolveStaticPath(options.root, url.pathname, options.fallback);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
    return false;
  }
  const realRoot = realpathSync(options.root);
  const realFilePath = realpathSync(filePath);
  if (!isInsideRoot(realRoot, realFilePath)) {
    return false;
  }

  const stats = statSync(realFilePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES[extname(realFilePath)] ?? "application/octet-stream",
    "content-length": String(stats.size),
    "cache-control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    createReadStream(realFilePath).pipe(res);
  }
  return true;
}

export function resolveStaticPath(root: string, rawPathname: string, fallback?: string): string | null {
  const rootPath = resolve(root);
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  const requested = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(rootPath, `.${requested}`);
  if (isInsideRoot(rootPath, candidate)) {
    return candidate;
  }
  if (!fallback) {
    return null;
  }
  const fallbackPath = resolve(rootPath, fallback);
  return isInsideRoot(rootPath, fallbackPath) ? fallbackPath : null;
}

function isInsideRoot(rootPath: string, candidate: string): boolean {
  const rel = relative(rootPath, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
