// [AUMFE-PREVIEW-GATE-1] Small dark pill shown on any hidden-until-gateway surface, only to previewers.
// Usage: <PreviewRibbon />  (renders nothing for customers). Pass `force` to render without the check.
import type { CSSProperties } from 'react';
import { usePreview } from '../lib/preview';

const pill: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 12px', borderRadius: 999,
  background: '#1f1a17', color: '#fff', fontFamily: "'Nunito', system-ui, sans-serif", fontWeight: 800,
  fontSize: 13, lineHeight: 1.3, letterSpacing: '.01em',
};

export default function PreviewRibbon({ force = false }: { force?: boolean }) {
  const { preview } = usePreview();
  if (!force && !preview) return null;
  return <span role="note" style={pill} data-preview-ribbon>Admin preview · hidden from customers</span>;
}
