# Vectorize setup: Aum Fe knowledge layer (AUMFE-KNOWLEDGE-VECTOR-1)

Documentation only. These are production writes that the owner approves; no agent runs them.
Run from `worker/`. Embedding model is Workers AI `@cf/baai/bge-m3` (1024 dims, cosine).

**Order matters:** create the index, then create ALL metadata indexes, then insert. Vectors
inserted before a metadata index exists are not filterable on it.

## 1. Catalog index (products and events)

```bash
npx wrangler vectorize create aumfe-catalog --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=kind --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=deity --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=graha --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=chakra --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=design_type --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=wear_day --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=print_colour --type=string
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=in_stock --type=boolean
npx wrangler vectorize create-metadata-index aumfe-catalog --property-name=active --type=boolean
```

`wear_day` and `print_colour` hold the FIRST value only; all wear days are also stored in the
non-indexed `wear_days` metadata field.

## 2. Tradition index (approved Hindu tradition library)

```bash
npx wrangler vectorize create aumfe-tradition --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=topic --type=string
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=graha --type=string
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=weekday --type=string
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=deity --type=string
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=lang --type=string
npx wrangler vectorize create-metadata-index aumfe-tradition --property-name=status --type=string
```

## 3. Verify

```bash
npx wrangler vectorize list-metadata-index aumfe-catalog
npx wrangler vectorize list-metadata-index aumfe-tradition
```

## 4. Then

1. Apply `worker/migrations/2026-10-01-aumfe-knowledge.sql` to DB_META.
2. Deploy the worker (bindings `VEC_CATALOG`, `VEC_TRADITION` are in `wrangler.toml`).
3. In Admin: import tradition entries (they arrive as drafts), approve them, approve product notes,
   then `POST /api/admin/v2/knowledge/reindex` per index if needed.

Until the indexes exist the bindings are absent in `Env`, searches return `[]` and emit
`vector_search {ok:false, reason:'unbound'}`.

D1 is the truth, Vectorize is only the finder: every hit is hydrated from D1 and dropped unless
the row is approved (tradition), or approved AND live and in stock (catalog).
