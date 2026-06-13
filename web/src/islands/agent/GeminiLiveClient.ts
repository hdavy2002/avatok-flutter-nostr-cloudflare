// GeminiLiveClient — the browser side of the AvaVoice agent call.
//
// Opens the Gemini Live WebSocket DIRECTLY from the browser using the
// short-lived EPHEMERAL token minted by the Worker (POST /sessions/start).
// No Google secret ever reaches the browser — the token already has the
// model/prompt/voice/language LOCKED into it server-side via
// `bidiGenerateContentSetup` (see worker/src/routes/avavoice.ts mintToken),
// so our setup message only NAMES the model — exactly like the app's
// reference flow in app/lib/features/translation/translation_engine.dart:
//
//     wss://generativelanguage.googleapis.com/ws/
//       google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent
//       ?access_token=<ephemeral token>
//     -> send { setup: { model: "models/<model>" } }
//     -> recv { serverContent: { modelTurn:{parts:[{inlineData:{data}}]},
//                                outputTranscription:{text}, turnComplete,
//                                interrupted } }
//
// Audio in: { realtimeInput: { audio: { data:<b64 pcm16>, mimeType:"audio/pcm;rate=16000" } } }
// Vision in: { realtimeInput: { video: { data:<b64 jpeg>, mimeType:"image/jpeg" } } }
//   (the app has not shipped its vision frame format yet — Gemini's documented
//    realtimeInput.video shape is mirrored here; noted as contract drift.)

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

export interface GeminiLiveHandlers {
  /** setupComplete received — safe to start streaming mic/vision. */
  onReady?: () => void;
  /** A chunk of agent output audio (raw PCM16 @ 24 kHz, little-endian). */
  onAudio?: (pcm16: ArrayBuffer) => void;
  /** Live output transcript (what the agent is saying). */
  onTranscript?: (text: string) => void;
  /** Model finished its turn. */
  onTurnComplete?: () => void;
  /** User barge-in detected by Gemini — drop any queued agent audio. */
  onInterrupted?: () => void;
  /** Socket closed (clean or error). `clean` true on a normal close. */
  onClose?: (clean: boolean, reason: string) => void;
}

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  }
  return btoa(bin);
}

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = false;

  constructor(
    private readonly token: string,
    private readonly model: string,
    private readonly handlers: GeminiLiveHandlers = {},
  ) {}

  get isReady(): boolean {
    return this.ready;
  }

  connect(): void {
    const url = `${GEMINI_WS_BASE}?access_token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      // Model name is the only thing we send; the ephemeral token carries the
      // rest of the locked setup. Prefix with "models/" like the app does.
      const model = this.model.startsWith('models/') ? this.model : `models/${this.model}`;
      ws.send(JSON.stringify({ setup: { model } }));
    };
    ws.onmessage = (ev) => void this.onMessage(ev.data);
    ws.onerror = () => this.handleClose(false, 'error');
    ws.onclose = (ev) => this.handleClose(ev.wasClean, ev.reason || (ev.wasClean ? 'closed' : 'dropped'));
  }

  private async onMessage(data: unknown): Promise<void> {
    try {
      let text: string;
      if (typeof data === 'string') text = data;
      else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
      else if (data instanceof Blob) text = await data.text();
      else return;
      const m = JSON.parse(text) as Record<string, any>;

      if (m.setupComplete) {
        this.ready = true;
        this.handlers.onReady?.();
        return;
      }

      const content = m.serverContent as Record<string, any> | undefined;
      if (!content) return;

      if (content.interrupted === true) this.handlers.onInterrupted?.();

      const outT: string | undefined = content.outputTranscription?.text;
      if (outT) this.handlers.onTranscript?.(outT);

      const parts: any[] = content.modelTurn?.parts ?? [];
      for (const p of parts) {
        const inline = p?.inlineData;
        const dataB64: string | undefined = inline?.data;
        // Audio parts carry mimeType like "audio/pcm;rate=24000".
        if (dataB64 && (!inline.mimeType || String(inline.mimeType).startsWith('audio'))) {
          this.handlers.onAudio?.(b64ToArrayBuffer(dataB64));
        }
      }

      if (content.turnComplete === true) this.handlers.onTurnComplete?.();
    } catch {
      /* non-JSON keepalives are fine to ignore */
    }
  }

  /** Send a mic chunk: raw PCM16 mono @ 16 kHz. */
  sendAudio(pcm16: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready || pcm16.byteLength === 0) return;
    try {
      ws.send(
        JSON.stringify({
          realtimeInput: { audio: { data: arrayBufferToB64(pcm16), mimeType: 'audio/pcm;rate=16000' } },
        }),
      );
    } catch {
      /* transient backpressure — drop frame */
    }
  }

  /** Send one vision frame (JPEG bytes). Vision agents only. */
  sendVideoFrame(jpeg: ArrayBuffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.ready || jpeg.byteLength === 0) return;
    try {
      ws.send(
        JSON.stringify({
          realtimeInput: { video: { data: arrayBufferToB64(jpeg), mimeType: 'image/jpeg' } },
        }),
      );
    } catch {
      /* drop frame */
    }
  }

  private handleClose(clean: boolean, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.handlers.onClose?.(clean, reason);
  }

  close(): void {
    this.closed = true;
    this.ready = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
