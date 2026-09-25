/** Only the public SEO resolver may create these records; never construct from request copy. */
export interface OgRecord {
  kind: 'home' | 'page' | 'collection' | 'article' | 'help' | 'listing' | 'creator' | 'agent';
  key: string;
  title: string;
  description?: string;
  canonicalPath: string;
  contentRevision: string;
  art?: { url: string; revision?: string; alt?: string };
}

export type OgResolveResult =
  | { status: 'ok'; record: OgRecord }
  | { status: 'not-found' }
  | { status: 'unavailable' };

export type OgResolver = (kind: string, key: string) => Promise<OgResolveResult>;
