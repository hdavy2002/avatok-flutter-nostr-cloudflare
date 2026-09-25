// [DASH2-FOUNDATION 2026-09-25] Shared "coming in this build" card for the
// screen islands until their owners replace them.
import { Sparkles } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';

export function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardHeader>
        <Badge variant="secondary" className="w-fit"><Sparkles className="h-3.5 w-3.5" /> Coming in this build</Badge>
        <CardTitle className="pt-2 text-grand-teal">{title}</CardTitle>
        <CardDescription className="text-[15px]">{body}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
