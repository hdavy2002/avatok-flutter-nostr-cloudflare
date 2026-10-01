// [AUMFE-KNOWLEDGE-VECTOR-1 2026-10-01] Public API of the shared knowledge layer.
export { chunkText, embedTexts, embedOne, EMBED_MODEL, EMBED_DIMS } from "./embed";
export {
  CATALOG_INDEX, TRADITION_INDEX, VECTOR_DIMENSIONS, VECTOR_METRIC, CATALOG_METADATA_INDEXES, TRADITION_METADATA_INDEXES,
} from "./indexes";
export { indexTraditionEntry, removeTraditionEntry, searchTradition } from "./tradition";
export type { TraditionHit, TraditionQuery, TraditionRow } from "./tradition";
export { indexSubjectNote, removeSubject, searchCatalog, getNote, isSubjectKind } from "./catalog";
export type { CatalogHit, CatalogQuery, CatalogFilters, SubjectKind, NoteRow, MatchReason } from "./catalog";
// [AUMFE-DESIGN-MATCH-1 2026-10-01] AI drafting of tradition notes + shop product sync hook.
export { draftNote, DraftError, listLiveWithoutNote } from "./note_draft";
export { onShopProductChanged } from "./product_sync";
