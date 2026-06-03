# Framer of the Year — contest upload API

Cloudflare Worker that receives video + entry details from the website and stores them in **R2**.

## One-time setup

1. **Cloudflare account** with R2 enabled.

2. **Create an R2 bucket** (e.g. `vestgaard-framer-contest`).

3. **Enable the bucket binding** in `wrangler.toml` — uncomment the `[[r2_buckets]]` block and set `bucket_name` to your bucket name.

4. **Install and deploy** from this folder:

   ```bash
   cd worker
   npm install
   npx wrangler login
   npm run deploy
   ```

5. Copy the Worker URL from the deploy output (e.g. `https://vestgaard-contest-upload.<account>.workers.dev`).

6. In **`index.html`**, set `VESTGAARD_CONTEST_API` to that URL (no trailing slash):

   ```javascript
   const VESTGAARD_CONTEST_API = 'https://vestgaard-contest-upload.<account>.workers.dev';
   ```

7. **Optional:** Route a custom subdomain (e.g. `api.vestgaard.ca`) to this Worker in Cloudflare DNS + Workers routes.

## What gets stored in R2

Each submission creates a folder:

```
entries/<uuid>/video.mp4   (or original extension)
entries/<uuid>/metadata.json
```

`metadata.json` includes name, about text, email, timestamps, file size, and user agent.

## CORS

`ALLOWED_ORIGINS` in `wrangler.toml` must include every origin that serves the site (production + local dev).

## Limits

Default max upload size is **100 MB** (`MAX_UPLOAD_MB` in `wrangler.toml`). Workers can stream the file body to R2; very large files may need a paid Workers plan.

## Local testing

```bash
npm run dev
```

Use `http://127.0.0.1:8787` as `VESTGAARD_CONTEST_API` while testing locally (add that origin to `ALLOWED_ORIGINS` if needed).

## Viewing submissions

In Cloudflare Dashboard → R2 → your bucket → browse `entries/`.
