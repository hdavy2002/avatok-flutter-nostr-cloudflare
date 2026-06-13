// StudioFlow — the studio's step controller: TemplatePicker → AgentForm.
//
// One client island so the picker→form transition keeps state on the client
// (Astro renders the page shell; this island owns the flow). Mirrors the app's
// template-first studio (MASTER §6 / Phase 2).

import { useState } from 'react';
import { TemplatePicker } from './TemplatePicker';
import AgentForm from './AgentForm';
import type { VisionCategory, VisionTemplate } from './avavisionApi';

type Picked = { category: VisionCategory; template: VisionTemplate };

export default function StudioFlow() {
  const [picked, setPicked] = useState<Picked | null>(null);

  if (!picked) {
    return <TemplatePicker onPick={(category, template) => setPicked({ category, template })} />;
  }
  return (
    <AgentForm
      category={picked.category}
      template={picked.template}
      onBack={() => setPicked(null)}
    />
  );
}
