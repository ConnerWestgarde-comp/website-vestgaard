export interface Env {
  CONTEST_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  MAX_UPLOAD_MB?: string;
}

/** Each part must be ≥ 5 MiB except the last; keep under Workers 100 MB request limit. */
const PART_SIZE_BYTES = 8 * 1024 * 1024;

const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/3gpp",
  "video/3gpp2",
  "video/x-m4v",
]);

interface PendingUpload {
  entryId: string;
  uploadId: string;
  videoKey: string;
  name: string;
  email: string;
  about: string | null;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  submittedAt: string;
}

function parseMaxBytes(env: Env): number {
  const mb = Number(env.MAX_UPLOAD_MB ?? "100");
  if (!Number.isFinite(mb) || mb <= 0) return 100 * 1024 * 1024;
  return Math.min(mb, 500) * 1024 * 1024;
}

function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS ?? "https://vestgaard.ca";
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

function isAllowedOrigin(origin: string, env: Env): boolean {
  if (!origin) return true;
  const allowed = allowedOrigins(env);
  if (allowed.includes(origin)) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === "vestgaard.ca" || host === "www.vestgaard.ca") return true;
  } catch {
    /* ignore */
  }
  return false;
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("Origin") ?? "";
  const headers = new Headers();
  if (isAllowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin || "https://vestgaard.ca");
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  headers.set("Access-Control-Expose-Headers", "CF-RAY, X-Upload-Request-Id");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function requestId(): string {
  return crypto.randomUUID().slice(0, 8);
}

function log(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...data }));
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: Headers,
  reqId?: string
): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
  if (reqId) headers.set("X-Upload-Request-Id", reqId);
  return new Response(JSON.stringify(body), { status, headers });
}

function sanitizeFilename(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  return base || "video";
}

function extFromType(type: string): string {
  const map: Record<string, string> = {
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-msvideo": ".avi",
    "video/3gpp": ".3gp",
    "video/3gpp2": ".3g2",
    "video/x-m4v": ".m4v",
  };
  return map[type] ?? ".mp4";
}

function pendingKey(entryId: string): string {
  return `entries/${entryId}/pending.json`;
}

async function loadPending(env: Env, entryId: string): Promise<PendingUpload | null> {
  const obj = await env.CONTEST_BUCKET.get(pendingKey(entryId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as PendingUpload;
}

async function logFailure(
  env: Env,
  reqId: string,
  reason: string,
  extra: Record<string, unknown>
): Promise<void> {
  log("upload_failure", { reqId, reason, ...extra });
  try {
    await env.CONTEST_BUCKET.put(
      `failures/${Date.now()}-${reqId}.json`,
      JSON.stringify({ reqId, reason, at: new Date().toISOString(), ...extra }, null, 2),
      { httpMetadata: { contentType: "application/json" } }
    );
  } catch (e) {
    console.error("Could not write failure log to R2", e);
  }
}

function validateContactFields(name: string, email: string, about: string): string | null {
  if (!name || name.length > 120) return "Please enter your name.";
  if (about.length > 4000) return "Description must be 4000 characters or less.";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "Please enter a valid email address.";
  }
  return null;
}

async function handleInit(request: Request, env: Env, cors: Headers): Promise<Response> {
  const reqId = requestId();
  if (!env.CONTEST_BUCKET) {
    return jsonResponse({ error: "Storage not configured on server.", reqId }, 503, cors, reqId);
  }

  const maxBytes = parseMaxBytes(env);
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    await logFailure(env, reqId, "invalid_json", {});
    return jsonResponse({ error: "Invalid JSON body.", reqId }, 400, cors, reqId);
  }

  const name = String(body.name ?? "").trim();
  const about = String(body.about ?? "").trim();
  const email = String(body.email ?? "").trim();
  const filename = String(body.filename ?? "video.mp4").trim();
  const contentType = String(body.contentType ?? "video/mp4").toLowerCase();
  const sizeBytes = Number(body.sizeBytes ?? 0);

  const fieldErr = validateContactFields(name, email, about);
  if (fieldErr) {
    return jsonResponse({ error: fieldErr, reqId }, 400, cors, reqId);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return jsonResponse({ error: "Invalid file size.", reqId }, 400, cors, reqId);
  }
  if (sizeBytes > maxBytes) {
    return jsonResponse(
      {
        error: `Video must be under ${Math.round(maxBytes / (1024 * 1024))} MB.`,
        reqId,
        sizeBytes,
        maxBytes,
      },
      413,
      cors,
      reqId
    );
  }
  if (!VIDEO_TYPES.has(contentType) && !contentType.startsWith("video/")) {
    return jsonResponse({ error: "Please upload a video file (MP4, MOV, WebM, etc.).", reqId }, 400, cors, reqId);
  }

  const entryId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const safeName = sanitizeFilename(filename);
  const videoKey = `entries/${entryId}/${safeName.includes(".") ? safeName : "video" + extFromType(contentType)}`;

  try {
    const multipart = env.CONTEST_BUCKET.createMultipartUpload(videoKey, {
      httpMetadata: { contentType },
    });

    const pending: PendingUpload = {
      entryId,
      uploadId: multipart.uploadId,
      videoKey,
      name,
      email,
      about: about || null,
      originalFilename: filename,
      contentType,
      sizeBytes,
      submittedAt,
    };

    await env.CONTEST_BUCKET.put(pendingKey(entryId), JSON.stringify(pending), {
      httpMetadata: { contentType: "application/json" },
    });

    log("upload_init", {
      reqId,
      entryId,
      uploadId: multipart.uploadId,
      sizeBytes,
      contentType,
      origin: request.headers.get("Origin"),
    });

    return jsonResponse(
      {
        ok: true,
        entryId,
        uploadId: multipart.uploadId,
        partSize: PART_SIZE_BYTES,
        reqId,
      },
      200,
      cors,
      reqId
    );
  } catch (err) {
    await logFailure(env, reqId, "init_failed", { entryId, message: String(err) });
    return jsonResponse({ error: "Could not start upload. Please try again.", reqId }, 500, cors, reqId);
  }
}

async function handlePart(request: Request, env: Env, cors: Headers): Promise<Response> {
  const reqId = requestId();
  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId") ?? "";
  const uploadId = url.searchParams.get("uploadId") ?? "";
  const partNumber = Number(url.searchParams.get("partNumber") ?? "0");

  if (!entryId || !uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
    return jsonResponse({ error: "Missing entryId, uploadId, or partNumber.", reqId }, 400, cors, reqId);
  }

  const pending = await loadPending(env, entryId);
  if (!pending || pending.uploadId !== uploadId) {
    await logFailure(env, reqId, "part_unknown_upload", { entryId, uploadId, partNumber });
    return jsonResponse({ error: "Upload session not found or expired. Please start over.", reqId }, 404, cors, reqId);
  }

  let data: ArrayBuffer;
  try {
    data = await request.arrayBuffer();
  } catch (err) {
    await logFailure(env, reqId, "part_read_failed", { entryId, partNumber, message: String(err) });
    return jsonResponse({ error: "Could not read upload chunk.", reqId }, 400, cors, reqId);
  }

  if (data.byteLength === 0) {
    return jsonResponse({ error: "Empty chunk.", reqId }, 400, cors, reqId);
  }
  if (data.byteLength > PART_SIZE_BYTES + 512 * 1024) {
    return jsonResponse({ error: "Chunk too large.", reqId }, 413, cors, reqId);
  }

  try {
    const multipart = env.CONTEST_BUCKET.resumeMultipartUpload(pending.videoKey, uploadId);
    const part = await multipart.uploadPart(partNumber, data);
    log("upload_part", { reqId, entryId, partNumber, bytes: data.byteLength });
    return jsonResponse(
      { ok: true, partNumber: part.partNumber, etag: part.etag, reqId },
      200,
      cors,
      reqId
    );
  } catch (err) {
    await logFailure(env, reqId, "part_upload_failed", {
      entryId,
      partNumber,
      message: String(err),
    });
    return jsonResponse({ error: "Chunk upload failed. Please retry.", reqId }, 500, cors, reqId);
  }
}

async function handleComplete(request: Request, env: Env, cors: Headers): Promise<Response> {
  const reqId = requestId();
  let body: { entryId?: string; uploadId?: string; parts?: { partNumber: number; etag: string }[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "Invalid JSON body.", reqId }, 400, cors, reqId);
  }

  const entryId = String(body.entryId ?? "");
  const uploadId = String(body.uploadId ?? "");
  const parts = body.parts ?? [];

  if (!entryId || !uploadId || !Array.isArray(parts) || parts.length === 0) {
    return jsonResponse({ error: "Missing entryId, uploadId, or parts.", reqId }, 400, cors, reqId);
  }

  const pending = await loadPending(env, entryId);
  if (!pending || pending.uploadId !== uploadId) {
    await logFailure(env, reqId, "complete_unknown_upload", { entryId, uploadId });
    return jsonResponse({ error: "Upload session not found. Please start over.", reqId }, 404, cors, reqId);
  }

  const metaKey = `entries/${entryId}/metadata.json`;
  const metadata = {
    entryId,
    submittedAt: pending.submittedAt,
    completedAt: new Date().toISOString(),
    name: pending.name,
    email: pending.email,
    about: pending.about,
    originalFilename: pending.originalFilename,
    contentType: pending.contentType,
    sizeBytes: pending.sizeBytes,
    userAgent: request.headers.get("User-Agent"),
    partCount: parts.length,
  };

  try {
    const multipart = env.CONTEST_BUCKET.resumeMultipartUpload(pending.videoKey, uploadId);
    await multipart.complete(
      parts.map((p) => ({ partNumber: Number(p.partNumber), etag: String(p.etag) }))
    );

    await env.CONTEST_BUCKET.put(metaKey, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
    await env.CONTEST_BUCKET.delete(pendingKey(entryId));

    log("upload_complete", { reqId, entryId, partCount: parts.length, sizeBytes: pending.sizeBytes });
    return jsonResponse({ ok: true, entryId, reqId }, 201, cors, reqId);
  } catch (err) {
    await logFailure(env, reqId, "complete_failed", { entryId, message: String(err) });
    return jsonResponse({ error: "Could not finalize upload. Please try again.", reqId }, 500, cors, reqId);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const origin = request.headers.get("Origin") ?? "";

    if (request.method === "OPTIONS") {
      if (origin && !isAllowedOrigin(origin, env)) {
        return new Response(null, { status: 403, headers: cors });
      }
      return new Response(null, { status: 204, headers: cors });
    }

    if (origin && !isAllowedOrigin(origin, env)) {
      log("cors_rejected", { origin, path: new URL(request.url).pathname });
      return jsonResponse({ error: "Origin not allowed.", origin }, 403, cors);
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          service: "vestgaard-contest-upload",
          endpoints: {
            health: "GET /health",
            init: "POST /upload/init",
            part: "POST /upload/part?entryId=&uploadId=&partNumber=",
            complete: "POST /upload/complete",
          },
          partSizeBytes: PART_SIZE_BYTES,
          maxUploadMb: env.MAX_UPLOAD_MB ?? "100",
        },
        200,
        cors
      );
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true, bucket: !!env.CONTEST_BUCKET }, 200, cors);
    }

    if (url.pathname === "/upload/init" && request.method === "POST") {
      return handleInit(request, env, cors);
    }

    if (url.pathname === "/upload/part" && request.method === "POST") {
      return handlePart(request, env, cors);
    }

    if (url.pathname === "/upload/complete" && request.method === "POST") {
      return handleComplete(request, env, cors);
    }

    return jsonResponse({ error: "Not found" }, 404, cors);
  },
};
