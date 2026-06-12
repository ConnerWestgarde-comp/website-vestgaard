# Framer of the Year — Cloudflare Worker + R2 setup

You already have the R2 bucket **`vestgaard-framer-contest`**. This guide wires it to the upload Worker and your website.

---

## What you’re building

```
vestgaard.ca (browser)
    → POST video + form fields
    → Cloudflare Worker (vestgaard-contest-upload)
    → R2 bucket vestgaard-framer-contest
         entries/<uuid>/video.mp4
         entries/<uuid>/metadata.json
```

---

## Part 1 — Confirm the R2 bucket (Dashboard)

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com).
2. Go to **R2 object storage** → open **`vestgaard-framer-contest`**.
3. You should see an empty bucket (or existing files). No public URL is required; the Worker writes privately.

Optional: note which **account** owns the bucket (same account you’ll use for Workers).

---

## Part 2 — Deploy the Worker (your computer)

You need **Node.js** (v18+) and **npm** installed. In Terminal:

```bash
cd /path/to/website-vestgaard/worker
npm install
npx wrangler login
```

`wrangler login` opens a browser to authorize Cloudflare CLI.

### Check config

`wrangler.toml` should already include:

```toml
[[r2_buckets]]
binding = "CONTEST_BUCKET"
bucket_name = "vestgaard-framer-contest"
```

That binds your bucket to the Worker as `CONTEST_BUCKET` (used in code).

### Deploy

```bash
npm run deploy
```

On success you’ll see something like:

```text
Published vestgaard-contest-upload
  https://vestgaard-contest-upload.<YOUR_SUBDOMAIN>.workers.dev
```

**Copy that URL** — you need it for the website.

### Quick test

```bash
curl https://vestgaard-contest-upload.<YOUR_SUBDOMAIN>.workers.dev/health
```

Expected: `{"ok":true}`

---

## Part 3 — Connect the website

1. Open **`index.html`** in the repo root.
2. Find (near the bottom scripts):

   ```javascript
   const VESTGAARD_CONTEST_API = '';
   ```

3. Set it to your Worker URL **with no trailing slash**:

   ```javascript
   const VESTGAARD_CONTEST_API = 'https://vestgaard-contest-upload.<YOUR_SUBDOMAIN>.workers.dev';
   ```

4. Commit and push so GitHub Pages updates **vestgaard.ca**.

---

## Part 4 — CORS (already configured)

`wrangler.toml` allows:

- `https://vestgaard.ca`
- `https://www.vestgaard.ca`
- local dev origins

If you test from another URL, add it to `ALLOWED_ORIGINS` in `wrangler.toml`, then run `npm run deploy` again.

---

## Part 5 — View submissions

After someone uploads:

1. Dashboard → **R2** → **vestgaard-framer-contest**
2. Browse **`entries/`**
3. Each folder has:
   - video file (e.g. `video.mp4`, `clip.mov`)
   - **`metadata.json`** — name, email, about text, timestamp, file size

Download files from the dashboard or use **R2 → Manage R2 API tokens** if you want CLI/S3 tools later.

---

## Part 6 — Optional: custom domain for the API

Instead of `*.workers.dev`, you can use e.g. **`api.vestgaard.ca`**:

1. Dashboard → **Workers & Pages** → **vestgaard-contest-upload** → **Settings** → **Domains & routes**
2. Add route: `api.vestgaard.ca` (zone must be on Cloudflare)
3. Set in `index.html`:

   ```javascript
   const VESTGAARD_CONTEST_API = 'https://api.vestgaard.ca';
   ```

---

## Local testing (optional)

```bash
cd worker
npm run dev
```

Worker runs at `http://127.0.0.1:8787`. For local HTML testing, set:

```javascript
const VESTGAARD_CONTEST_API = 'http://127.0.0.1:8787';
```

`http://127.0.0.1:8787` is already in `ALLOWED_ORIGINS` via localhost entries; add `http://127.0.0.1:5500` if you use Live Server on another port.

---

## Troubleshooting uploads

### “Network error” on the site (most common)

Cloudflare **Workers reject a single request body over 100 MB** on Free/Pro plans. The site now uploads in **8 MB chunks** via R2 multipart upload so files up to 450 MB work. You must **redeploy the Worker** after pulling this change:

```bash
cd worker && npm run deploy
```

### See what failed

1. **Worker logs** — Cloudflare Dashboard → **Workers & Pages** → **vestgaard-contest-upload** → **Logs** (real-time). Look for `upload_failure`, `cors_rejected`, `part_upload_failed`.
2. **R2 failure log** — bucket **vestgaard-framer-contest** → prefix **`failures/`** — JSON files with error reason and `reqId`.
3. **User’s error message** — now includes `ref <id>` and `ray <cf-ray>` when available; match `ref` to logs.

### Other causes

| Symptom | Likely cause |
|--------|----------------|
| Works for some users, not others | Large file (>100 MB) on old single-request upload; chunk upload fixes this |
| Only on mobile / in-app browser | Open **vestgaard.ca** in Safari/Chrome, not embedded TikTok/Instagram browser |
| CORS / 403 | Origin not allowed — must be `https://vestgaard.ca` or `https://www.vestgaard.ca` |
| 413 | File over 450 MB or chunk too large |


---

## Redeploy after code changes

Any change under `worker/`:

```bash
cd worker
npm run deploy
```

Changes to `index.html` only: push to GitHub (Pages); no Worker redeploy needed unless you changed CORS vars.

---

## Security note

Uploads are **public** (anyone with the form can submit). For production abuse protection, consider Cloudflare **Turnstile** on the form later.
