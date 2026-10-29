// [HF-SUPPORT-DESK] Email signature editor (design: AdminSignature). A contenteditable box with a small toolbar, a live preview
// (desktop / phone), team vs personal, and email-safe output (inline styles, table layout, safe fonts) from toEmailSafe().
// No editor library: document.execCommand is old but is supported by every browser and gives bold/italic/colour/links for free.
import { useCallback, useEffect, useRef, useState } from 'react';
import { adminApi, errMessage, uploadAttachment } from './api';
import { esc } from './format';
import { sanitizeHtml } from './sanitize';
import { FILL_INS, FONT_SIZES, FONT_STACKS, SOCIALS, defaultSignature, dividerHtml, fillSample, logoImgHtml, socialHtml, toEmailSafe, BASE_FONT } from './signature';
import { SubHeader, useStaff } from './staff';
import { ErrorBox, Menu, MenuItem, Modal, Spinner, useToast } from './ui';

type Scope = 'team' | 'me';

function exec(cmd: string, val?: string) { try { document.execCommand(cmd, false, val); } catch { /* ignore */ } }

export default function SignatureEditor({ embedded = false }: { embedded?: boolean }) {
  const me = useStaff();
  const toast = useToast();
  const [scope, setScope] = useState<Scope>('team');
  const [html, setHtml] = useState('');
  const [useFor, setUseFor] = useState<'team' | 'personal'>('team');
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState(false);
  const [modal, setModal] = useState<null | 'link' | 'social'>(null);
  const box = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const canEdit = scope === 'me' ? me.canWrite : me.role === 'admin';

  const load = useCallback((s: Scope) => {
    setLoaded(false); setErr(null); setDirty(false);
    adminApi.signature(s).then((r) => {
      const h = r.html.trim() ? r.html : defaultSignature(null);
      setHtml(h); setUseFor(r.useFor); setLoaded(true);
    }).catch((e) => { setErr(errMessage(e, 'Could not load the signature.')); });
  }, []);
  useEffect(() => load(scope), [scope, load]);

  // Put the saved HTML into the box once per load (not on every keystroke, which would reset the cursor).
  useEffect(() => { if (loaded && box.current) box.current.innerHTML = sanitizeHtml(html); }, [loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const read = () => setHtml(box.current?.innerHTML ?? '');
  const changed = () => { read(); setDirty(true); };

  const remember = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && box.current?.contains(s.anchorNode)) saved.current = s.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    box.current?.focus();
    const s = window.getSelection();
    if (s && saved.current) { s.removeAllRanges(); s.addRange(saved.current); }
  };
  const run = (cmd: string, val?: string) => { restore(); exec(cmd, val); changed(); };
  const insert = (h: string) => { restore(); exec('insertHTML', h); changed(); };

  const setFont = (stack: string) => run('fontName', stack);
  const setSize = (px: number) => {
    // execCommand fontSize only knows 1–7; set 7 then rewrite those <font> tags to inline pixel sizes.
    restore(); exec('fontSize', '7');
    box.current?.querySelectorAll('font[size="7"]').forEach((f) => {
      const span = document.createElement('span');
      span.style.fontSize = `${px}px`;
      span.innerHTML = (f as HTMLElement).innerHTML;
      f.replaceWith(span);
    });
    changed();
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/.test(file.type)) { toast('Please choose a PNG, JPG, GIF or WebP picture.', 'error'); return; }
    if (file.size > 2 * 1024 * 1024) { toast('Please use a logo under 2 MB.', 'error'); return; }
    try {
      const up = await uploadAttachment(file, 'signature');
      if (!up.url) { toast('The logo was uploaded but has no public address. Ask the developer to check the signature upload.', 'error'); return; }
      insert(logoImgHtml(up.url));
      toast('Logo added');
    } catch (e) { toast(errMessage(e), 'error'); }
  };

  const output = () => toEmailSafe(box.current?.innerHTML ?? html);
  const body = (): { html: string; useFor: 'team' | 'personal' } => ({ html: output(), useFor: scope === 'team' ? 'team' : useFor });

  const save = async () => {
    if (!canEdit) return;
    setBusy(true);
    try { await adminApi.saveSignature(scope, body()); setDirty(false); toast(scope === 'team' ? 'Team signature saved' : 'Your signature saved'); }
    catch (e) { toast(errMessage(e), 'error'); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { await adminApi.testSignature(body()); toast('Test email sent to you'); }
    catch (e) { toast(errMessage(e), 'error'); } finally { setBusy(false); }
  };
  const reset = () => {
    if (!canEdit) return;
    if (box.current) box.current.innerHTML = defaultSignature(null);
    changed();
    toast('Back to the standard signature. Save to keep it.', 'info');
  };

  const previewHtml = fillSample(sanitizeHtml(toEmailSafe(html)), { agentName: me.name });

  const inner = (
    <>
      <div className="hfs-sigtabs" role="tablist">
        <button type="button" role="tab" aria-selected={scope === 'team'} className={scope === 'team' ? 'is-on' : ''} onClick={() => setScope('team')}>Team signature</button>
        <button type="button" role="tab" aria-selected={scope === 'me'} className={scope === 'me' ? 'is-on' : ''} onClick={() => setScope('me')}>My signature</button>
      </div>
      {err && <ErrorBox message={err} onRetry={() => load(scope)} />}
      {!loaded && !err && <div className="hfs-center"><Spinner /></div>}
      {loaded && (
        <div className="hfs-sig">
          <section className="hfs-card hfs-sig__edit">
            <h2>{scope === 'team' ? 'Team signature' : 'My signature'}</h2>
            <p className="hfs-fineprint">
              {scope === 'team' ? 'Added under every reply unless someone uses their own. ' : 'Used under your replies when the switch below is on. '}
              Words in curly brackets, like {'{agent_name}'}, are filled in when the email is sent.
              {!canEdit && ' You can look but not change this one.'}
            </p>
            {scope === 'me' && (
              <label className="hfs-check">
                <input type="checkbox" checked={useFor === 'personal'} disabled={!canEdit} onChange={(e) => { setUseFor(e.target.checked ? 'personal' : 'team'); setDirty(true); }} />
                Use my own signature on my replies
              </label>
            )}
            <div className="hfs-toolbar" role="toolbar" aria-label="Formatting" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'SELECT' && (e.target as HTMLElement).tagName !== 'INPUT') e.preventDefault(); }}>
              <select aria-label="Font" className="hfs-select hfs-select--sm" defaultValue="" disabled={!canEdit} onFocus={remember} onChange={(e) => { if (e.target.value) setFont(e.target.value); e.target.value = ''; }}>
                <option value="">Font</option>
                {FONT_STACKS.map((f) => <option key={f.label} value={f.stack}>{f.label}</option>)}
              </select>
              <select aria-label="Size" className="hfs-select hfs-select--sm" defaultValue="" disabled={!canEdit} onFocus={remember} onChange={(e) => { if (e.target.value) setSize(Number(e.target.value)); e.target.value = ''; }}>
                <option value="">Size</option>
                {FONT_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="button" className="hfs-tb" title="Bold" aria-label="Bold" disabled={!canEdit} onClick={() => run('bold')}><b>B</b></button>
              <button type="button" className="hfs-tb" title="Italic" aria-label="Italic" disabled={!canEdit} onClick={() => run('italic')}><i>I</i></button>
              <button type="button" className="hfs-tb" title="Underline" aria-label="Underline" disabled={!canEdit} onClick={() => run('underline')}><u>U</u></button>
              <label className="hfs-tb hfs-tb--colour" title="Text colour">
                <span className="hfs-sr">Text colour</span>A
                <input type="color" defaultValue="#4A1747" disabled={!canEdit} onFocus={remember} onChange={(e) => run('foreColor', e.target.value)} />
              </label>
              <button type="button" className="hfs-tb" title="Align left" aria-label="Align left" disabled={!canEdit} onClick={() => run('justifyLeft')}>⇤</button>
              <button type="button" className="hfs-tb" title="Centre" aria-label="Centre" disabled={!canEdit} onClick={() => run('justifyCenter')}>↔</button>
              <button type="button" className="hfs-tb" title="Align right" aria-label="Align right" disabled={!canEdit} onClick={() => run('justifyRight')}>⇥</button>
              <span className="hfs-tb__sep" />
              <button type="button" className="hfs-tb hfs-tb--txt" disabled={!canEdit} onClick={() => { remember(); setModal('link'); }}>Link</button>
              <button type="button" className="hfs-tb hfs-tb--txt" disabled={!canEdit} onClick={() => { remember(); fileRef.current?.click(); }}>Logo</button>
              <button type="button" className="hfs-tb hfs-tb--txt" disabled={!canEdit} onClick={() => insert(dividerHtml())}>Divider</button>
              <button type="button" className="hfs-tb hfs-tb--txt" disabled={!canEdit} onClick={() => { remember(); setModal('social'); }}>Social icons</button>
              <Menu className="hfs-tb hfs-tb--txt" label="Fill-ins ▾" disabled={!canEdit}>
                {(close) => FILL_INS.map((f) => <MenuItem key={f.token} onClick={() => { close(); insert(esc(f.token)); }}>{f.label} <code>{f.token}</code></MenuItem>)}
              </Menu>
              <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            <div
              ref={box} className="hfs-sigbox" contentEditable={canEdit} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Signature"
              style={{ fontFamily: BASE_FONT }} onInput={changed} onKeyUp={remember} onMouseUp={remember} onBlur={remember}
              onPaste={(e) => {
                e.preventDefault();
                const h = e.clipboardData.getData('text/html');
                const t = e.clipboardData.getData('text/plain');
                exec('insertHTML', h ? sanitizeHtml(h) : esc(t).replace(/\n/g, '<br>'));
                changed();
              }}
            />
            <div className="hfs-actions">
              <button type="button" className="hfs-btn hfs-btn--primary" disabled={!canEdit || !dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save signature'}</button>
              <button type="button" className="hfs-btn hfs-btn--ghost" disabled={busy} onClick={() => void test()}>Send test email to me</button>
              <button type="button" className="hfs-btn hfs-btn--ghost" disabled={!canEdit || busy} onClick={reset}>Reset to standard</button>
              {dirty && <span className="hfs-fineprint">Unsaved changes</span>}
            </div>
          </section>

          <section className="hfs-card hfs-sig__preview">
            <div className="hfs-sig__previewhead">
              <h2>Preview</h2>
              <div className="hfs-seg" role="group" aria-label="Preview size">
                <button type="button" className={!phone ? 'is-on' : ''} aria-pressed={!phone} onClick={() => setPhone(false)}>Desktop</button>
                <button type="button" className={phone ? 'is-on' : ''} aria-pressed={phone} onClick={() => setPhone(true)}>Phone</button>
              </div>
            </div>
            <div className={`hfs-mailview${phone ? ' is-phone' : ''}`}>
              <p>Hi Ravi,</p>
              <p>Thanks for writing in. I have checked your top-up and it has now been added to your wallet.</p>
              <p>Warm regards,</p>
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </section>
        </div>
      )}
      {modal === 'link' && <LinkModal onClose={() => setModal(null)} onDone={(url, text) => { setModal(null); const hasSel = !!saved.current && !saved.current.collapsed; if (hasSel) run('createLink', url); else insert(`<a href="${esc(url)}" style="color:#6D4FD0;text-decoration:underline">${esc(text || url)}</a>`); }} />}
      {modal === 'social' && <SocialModal onClose={() => setModal(null)} onDone={(links) => { setModal(null); if (links.length) insert(socialHtml(links)); }} />}
    </>
  );

  if (embedded) return <div className="hfs-sigwrap">{inner}</div>;
  return (
    <div className="hfs hfs-admin">
      <SubHeader back="Settings" backTo="/desk/settings" title="Email signature" />
      <div className="hfs-wrap">{inner}</div>
    </div>
  );
}

function LinkModal({ onClose, onDone }: { onClose: () => void; onDone: (url: string, text: string) => void }) {
  const [url, setUrl] = useState('https://');
  const [text, setText] = useState('');
  const [bad, setBad] = useState('');
  const go = () => {
    const u = url.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(u) || u.length < 9) { setBad('The address should start with https:// or mailto:'); return; }
    onDone(u, text.trim());
  };
  return (
    <Modal title="Add a link" onClose={onClose}>
      <label htmlFor="hfs-lu" className="hfs-label">Address</label>
      <input id="hfs-lu" className="hfs-input" value={url} onChange={(e) => setUrl(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      <label htmlFor="hfs-lt" className="hfs-label">Text to show (only if nothing is selected)</label>
      <input id="hfs-lt" className="hfs-input" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
      {bad && <p className="hfs-fielderr" role="alert">{bad}</p>}
      <div className="hfs-modal__actions">
        <button type="button" className="hfs-btn hfs-btn--primary" onClick={go}>Add link</button>
        <button type="button" className="hfs-btn hfs-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function SocialModal({ onClose, onDone }: { onClose: () => void; onDone: (links: { key: (typeof SOCIALS)[number]['key']; url: string }[]) => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [bad, setBad] = useState('');
  const go = () => {
    const links = SOCIALS.map((s) => ({ key: s.key, url: (urls[s.key] ?? '').trim() })).filter((l) => l.url);
    if (links.some((l) => !/^https?:\/\//i.test(l.url))) { setBad('Each address should start with https://'); return; }
    onDone(links);
  };
  return (
    <Modal title="Social icons" onClose={onClose}>
      <p>Fill in the ones you want. Empty ones are left out.</p>
      {SOCIALS.map((s) => (
        <div key={s.key}>
          <label htmlFor={`hfs-so-${s.key}`} className="hfs-label">{s.label}</label>
          <input id={`hfs-so-${s.key}`} className="hfs-input" placeholder="https://" value={urls[s.key] ?? ''} onChange={(e) => setUrls((u) => ({ ...u, [s.key]: e.target.value }))} />
        </div>
      ))}
      {bad && <p className="hfs-fielderr" role="alert">{bad}</p>}
      <div className="hfs-modal__actions">
        <button type="button" className="hfs-btn hfs-btn--primary" onClick={go}>Add icons</button>
        <button type="button" className="hfs-btn hfs-btn--ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
