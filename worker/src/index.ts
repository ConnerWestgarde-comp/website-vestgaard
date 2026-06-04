export interface Env {
  CONTEST_BUCKET: R2Bucket;
  ALLOWED_ORIGINS?: string;
  MAX_UPLOAD_MB?: string;
}

const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-msvideo",
  "video/3gpp",
  "video/3gpp2",
  "video/x-m4v",
]);

function parseMaxBytes(env: Env): number {
  const mb = Number(env.MAX_UPLOAD_MB ?? "100");
  if (!Number.isFinite(mb) || mb <= 0) return 100 * 1024 * 1024;
  return Math.min(mb, 500) * 1024 * 1024;
}

function allowedOrigins(env: Env): string[] {
  const raw = env.ALLOWED_ORIGINS ?? "https://vestgaard.ca";
  return raw.split(",").map((o) => o.trim()).filter(Boolean);
}

function corsHeaders(request: Request, env: Env): Headers {
  const origin = request.headers.get("Origin") ?? "";
  const allowed = allowedOrigins(env);
  const headers = new Headers();
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  } else if (!origin) {
    headers.set("Access-Control-Allow-Origin", allowed[0] ?? "*");
  }
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function jsonResponse(
  body: unknown,
  status: number,
  cors: Headers
): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json");
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

async function handleUpload(request: Request, env: Env, cors: Headers): Promise<Response> {
  if (!env.CONTEST_BUCKET) {
    return jsonResponse({ error: "Storage not configured on server." }, 503, cors);
  }

  const maxBytes = parseMaxBytes(env);
  const contentLength = request.headers.get("Content-Length");
  if (contentLength && Number(contentLength) > maxBytes) {
    return jsonResponse(
      { error: `Video must be under ${Math.round(maxBytes / (1024 * 1024))} MB.` },
      413,
      cors
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonResponse({ error: "Invalid form data." }, 400, cors);
  }

  const name = String(form.get("name") ?? "").trim();
  const about = String(form.get("about") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const video = form.get("video");

  if (!name || name.length > 120) {
    return jsonResponse({ error: "Please enter your name." }, 400, cors);
  }
  if (about.length > 4000) {
    return jsonResponse(
      { error: "Description must be 4000 characters or less." },
      400,
      cors
    );
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: "Please enter a valid email address." }, 400, cors);
  }
  if (!(video instanceof File) || video.size === 0) {
    return jsonResponse({ error: "Please choose a video file." }, 400, cors);
  }
  if (video.size > maxBytes) {
    return jsonResponse(
      { error: `Video must be under ${Math.round(maxBytes / (1024 * 1024))} MB.` },
      413,
      cors
    );
  }

  const type = (video.type || "video/mp4").toLowerCase();
  if (!VIDEO_TYPES.has(type) && !type.startsWith("video/")) {
    return jsonResponse({ error: "Please upload a video file (MP4, MOV, WebM, etc.)." }, 400, cors);
  }

  const entryId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const safeName = sanitizeFilename(video.name);
  const videoKey = `entries/${entryId}/${safeName.includes(".") ? safeName : "video" + extFromType(type)}`;
  const metaKey = `entries/${entryId}/metadata.json`;

  const metadata = {
    entryId,
    submittedAt,
    name,
    email,
    about: about || null,
    originalFilename: video.name,
    contentType: type,
    sizeBytes: video.size,
    userAgent: request.headers.get("User-Agent"),
  };

  try {
    await env.CONTEST_BUCKET.put(videoKey, video.stream(), {
      httpMetadata: { contentType: type },
      customMetadata: {
        entryId,
        name,
        submittedAt,
      },
    });

    await env.CONTEST_BUCKET.put(metaKey, JSON.stringify(metadata, null, 2), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (err) {
    console.error("R2 upload failed", err);
    return jsonResponse({ error: "Upload failed. Please try again." }, 500, cors);
  }

  return jsonResponse({ ok: true, entryId }, 201, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return jsonResponse(
        {
          ok: true,
          service: "vestgaard-contest-upload",
          endpoints: { health: "GET /health", upload: "POST /upload" },
        },
        200,
        cors
      );
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({ ok: true }, 200, cors);
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      return handleUpload(request, env, cors);
    }

    return jsonResponse({ error: "Not found" }, 404, cors);
  },
};
