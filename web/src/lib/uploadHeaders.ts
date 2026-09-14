/*
 * uploadHeaders — safe header values for the `POST /upload/public` byte-staging
 * endpoint. [UPLOAD-FILENAME-HDR-1 2026-09-13]
 *
 * WHY THIS EXISTS — do not "simplify" it back to `file.name`.
 *
 * HTTP header values are ByteStrings (ISO-8859-1). `fetch` validates them
 * BEFORE the request leaves the browser, so a filename with any code point
 * above U+00FF makes the call throw synchronously — no status, no server log,
 * no `api_error` event, nothing to diagnose from. Reproduced live in a real
 * browser against production:
 *
 *   plain.png       -> 200
 *   पूजा.png         -> TypeError: Failed to execute 'fetch' on 'Window':
 *                      Failed to read the 'headers' property from
 *                      'RequestInit': String contains non ISO-8859-1 code point.
 *   photo–dash.png  -> same TypeError (EN DASH U+2013 — trivially easy to hit;
 *                      macOS and Word produce it by autocorrect)
 *   emoji🙏.png      -> same TypeError
 *   café.png        -> 200 (é IS Latin-1, so the bug hid behind accented Latin)
 *
 * For an Indian marketplace this made every Devanagari filename unuploadable,
 * and the creator saw only a generic "could not upload" message.
 *
 * THE FIX / WIRE CONTRACT: send `x-file-name` percent-encoded.
 * `encodeURIComponent` output is always ASCII, hence always a legal header
 * value. The worker `decodeURIComponent`s it with a try/catch fallback to the
 * raw value, so a plain ASCII name is byte-identical to what we sent before
 * and nothing already deployed breaks.
 *
 * Anything else put in a header must clear the same bar. `x-content-type` is a
 * MIME type and `x-app` is a constant, so both are safe as-is; today no other
 * header on these call sites carries user-supplied free text.
 */

/**
 * Percent-encode a filename so it is a legal HTTP header value.
 * ASCII in, identical ASCII out; anything else becomes `%XX` escapes.
 */
export function fileNameHeader(name: string): string {
  try {
    return encodeURIComponent(name);
  } catch {
    // Only reachable for a lone surrogate (URIError). A name we cannot encode
    // is not worth failing an upload over — the byte staging does not need it.
    return 'file';
  }
}

/**
 * The sentence a creator sees when a photo upload fails for a reason we have
 * no better words for. "Could not upload that photo." told them nothing they
 * could act on, so it read as a dead end — this names one thing to try, in
 * plain dashboard English, with no error code or jargon in it.
 */
export const UPLOAD_FALLBACK_MESSAGE = "Couldn't upload that photo — check your connection and try again.";
