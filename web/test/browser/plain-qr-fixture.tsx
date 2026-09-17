// CI-only entry: mount the real public island without Clerk or invitation state.
import { createRoot } from 'react-dom/client';
import UpiPlainQr from '../../src/islands/checkout/UpiPlainQr';
createRoot(document.getElementById('root')!).render(<UpiPlainQr />);
