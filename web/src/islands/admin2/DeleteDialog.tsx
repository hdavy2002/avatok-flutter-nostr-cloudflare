/* DeleteDialog — [SAATHUM-ADMIN-DELETE-1] one destructive "Delete permanently" confirm for admin events and free videos.
 * The caller owns the request; a server refusal (e.g. 409 has_money_history) is passed back in `error` and shown here. */
import { Loader2 } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../components/ui/alert-dialog';

export default function DeleteDialog({ open, onOpenChange, title, body, busy, error, onConfirm }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-[14px] font-semibold text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={busy}
            onClick={(e) => { e.preventDefault(); onConfirm(); }}>
            {busy && <Loader2 className="animate-spin" />} Delete permanently
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
