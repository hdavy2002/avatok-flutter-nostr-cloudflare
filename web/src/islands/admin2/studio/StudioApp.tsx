/* StudioApp — [AUMFE-POD-STUDIO-WEB-1 2026-10-01] One island for every /admin/shop/studio/** page (one SSR route rule:
 * studio/[...rest].astro). The URL tail picks the screen:
 *   ''                 → Studio home (Main)           /admin/shop/studio
 *   'new'              → Upload, no design yet         /admin/shop/studio/new
 *   '<id>'             → resume at the design's saved step
 *   '<id>/upload|product|design|photos|publish'
 * No Clerk provider here: AdminNav owns it and every call goes through adminApi() (lib/studioApi.ts). */
import { useEffect, useState } from 'react';
import { stepHref, type StudioStep, getDesign } from '../../../lib/studioApi';
import { captureException } from '../../../lib/analytics';
import StudioHome from './StudioHome';
import UploadStep from './UploadStep';
import ProductStep from './ProductStep';
import EditorStep from './EditorStep';
import PhotosStep from './PhotosStep';
import PublishStep from './PublishStep';
import { Loading, Page } from './StudioKit';

const STEPS: StudioStep[] = ['upload', 'product', 'design', 'photos', 'publish'];

function Resume({ id }: { id: string }) {
  const [msg, setMsg] = useState('Opening your design…');
  useEffect(() => {
    getDesign(id).then((d) => window.location.replace(stepHref(id, d.step))).catch((e) => {
      captureException(e, { where: 'studio_resume' });
      setMsg('Could not open that design. Go back to Studio and try again.');
    });
  }, [id]);
  return <Page><Loading what={msg} /></Page>;
}

export default function StudioApp({ rest }: { rest: string }) {
  const parts = rest.split('/').filter(Boolean);
  if (parts.length === 0) return <StudioHome />;
  if (parts[0] === 'new') return <UploadStep designId={null} />;
  const id = parts[0];
  const step = parts[1] as StudioStep | undefined;
  if (!step) return <Resume id={id} />;
  if (!STEPS.includes(step)) return <Resume id={id} />;
  switch (step) {
    case 'upload': return <UploadStep designId={id} />;
    case 'product': return <ProductStep designId={id} />;
    case 'design': return <EditorStep designId={id} />;
    case 'photos': return <PhotosStep designId={id} />;
    default: return <PublishStep designId={id} />;
  }
}
