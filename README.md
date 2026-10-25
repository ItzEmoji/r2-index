# r2-index

An nginx `autoindex`-style directory listing for Cloudflare R2, running as a Worker.

## Setup

The Worker serves every R2 binding it finds, whatever its name and wherever it was added.
You can set it up in either of two ways.

### With Wrangler

```sh
npm install
npx wrangler r2 bucket create files   # or leave out "bucket_name" and deploy creates it
npm run deploy
```

### Without Wrangler, in the dashboard only

1. Download `r2-index.js` from the latest [release](../../releases/latest), or build it yourself
   with `npm run build`, which writes `dist/index.js`.
2. **Workers & Pages → Create → Start with Hello World**, open **Edit code**, replace everything
   with the contents of `r2-index.js` and click **Deploy**.
3. **Settings → Bindings → Add → R2 bucket**: pick a bucket and give it a binding name, such as
   `FILES`. Add more buckets the same way, and each one shows up at `/<binding in lowercase>/`.
4. Optional: add the variables from the table below under **Settings → Variables and Secrets**.

To update it later, paste the new `r2-index.js` into the editor again. The bindings stay.

> **Use one place per Worker.** `wrangler deploy` replaces _all_ of a Worker's bindings with
> the ones in `wrangler.jsonc`, so R2 buckets added in the dashboard are removed on the next
> deploy (Wrangler asks before it does that). Variables survive, because `keep_vars` is set.
> If you want both, deploy two Workers: one managed by Wrangler and one by the dashboard.

## Configuration

Everything lives in `wrangler.jsonc`. Each entry in `r2_buckets` gets picked up automatically:

- **one bucket**: served at `/`
- **several buckets**: `/` lists them, and each one is served under `/<binding in lowercase>/`

```jsonc
"r2_buckets": [
  { "binding": "FILES", "bucket_name": "files" },          // -> /files/
  { "binding": "ISOS",  "bucket_name": "my-iso-mirror" }   // -> /isos/
]
```

| var                    | default | meaning                                         |
| ---------------------- | ------- | ----------------------------------------------- |
| `AUTOINDEX_EXACT_SIZE` | `false` | sizes in bytes instead of `49K` / `3M` / `4G`   |
| `HIDE_DOTFILES`        | `true`  | hide keys starting with `.`                     |
| `LISTING_CACHE_TTL`    | `30`    | edge-cache seconds for directory listings       |
| `FILE_CACHE_TTL`       | `3600`  | `max-age` for files with no own `Cache-Control` |

Append `?purge` to a URL to drop it from the edge cache. If you set a `PURGE_TOKEN` secret
(`wrangler secret put PURGE_TOKEN`), you have to use `?purge=<token>`.

## Development

```sh
npx wrangler r2 object put files/hello.txt --local --file ./hello.txt
npm run dev
npm run check   # regenerate types + tsc
```
