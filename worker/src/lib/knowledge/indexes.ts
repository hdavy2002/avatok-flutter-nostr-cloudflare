// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Index names, dimensions and metadata-index lists.
// These MUST match Specs/VECTORIZE-SETUP-AUMFE-KNOWLEDGE.md and wrangler.toml. Metadata indexes
// have to exist BEFORE the first insert, or earlier vectors stay unfilterable.
export const CATALOG_INDEX = "aumfe-catalog";
export const TRADITION_INDEX = "aumfe-tradition";
export const VECTOR_DIMENSIONS = 1024;
export const VECTOR_METRIC = "cosine";

export type MetaIndexType = "string" | "number" | "boolean";
export interface MetaIndexDef { property: string; type: MetaIndexType }

export const CATALOG_METADATA_INDEXES: readonly MetaIndexDef[] = [
  { property: "kind", type: "string" },
  { property: "deity", type: "string" },
  { property: "graha", type: "string" },
  { property: "chakra", type: "string" },
  { property: "design_type", type: "string" },
  { property: "wear_day", type: "string" },
  { property: "print_colour", type: "string" },
  { property: "in_stock", type: "boolean" },
  { property: "active", type: "boolean" },
];

export const TRADITION_METADATA_INDEXES: readonly MetaIndexDef[] = [
  { property: "topic", type: "string" },
  { property: "graha", type: "string" },
  { property: "weekday", type: "string" },
  { property: "deity", type: "string" },
  { property: "lang", type: "string" },
  { property: "status", type: "string" },
];

export const SEARCH_DEFAULT_K = 5;
export const SEARCH_MAX_K = 20;
