import { capture } from '../../lib/analytics';

// Only allowlisted fictional profile ids and fixed actions reach analytics.
const profileElement = document.querySelector<HTMLElement>('[data-profile-id]');
const sampleProfiles = new Set(['neha', 'priya', 'sana', 'kavya', 'dr-ananya', 'rohan', 'arjun', 'dev']);
const profileId = profileElement?.dataset.profileId || '';
const profileName = profileElement?.dataset.profileName || 'this sample profile';
const knownProfile = sampleProfiles.has(profileId);
const metadata = { surface: 'callvaal-profile', profile_id: profileId, sample_profile: true };
const status = document.querySelector<HTMLElement>('[data-profile-status]');
function record(action: string, extra: Record<string, string | number | boolean> = {}) {
  if (!knownProfile) return;
  capture('cta_click', { ...metadata, label: action, ...extra });
}
const triggers = new WeakMap<HTMLDialogElement, HTMLElement>();
function openDialog(dialog: HTMLDialogElement | null, trigger: HTMLElement) {
  if (!dialog || dialog.open) return;
  triggers.set(dialog, trigger);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('[data-disclaimer-ack], [data-dialog-close]')?.focus();
}
document.querySelectorAll<HTMLDialogElement>('.cv-detail-dialog').forEach(dialog => {
  dialog.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { triggers.get(dialog)?.focus(); triggers.delete(dialog); });
  dialog.addEventListener('click', event => {
    if (dialog.id === 'cv-profile-preview' || event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
});

document.querySelector<HTMLButtonElement>('[data-profile-save]')?.addEventListener('click', event => {
  const button = event.currentTarget as HTMLButtonElement;
  const saved = button.getAttribute('aria-pressed') !== 'true';
  button.setAttribute('aria-pressed', String(saved));
  button.setAttribute('aria-label', `${saved ? 'Unsave' : 'Save'} ${profileName} for this visit`);
  const label = button.querySelector('[data-save-label]');
  if (label) label.textContent = saved ? 'Saved' : 'Save';
  if (status) status.textContent = saved ? 'Sample profile saved for this visit.' : 'Sample profile removed from saved items.';
  record('save_profile', { saved });
});

const preview = document.querySelector<HTMLDialogElement>('#cv-profile-preview');
// Preview has no call continuation. Dismissal explicitly acknowledges the disclaimer.
preview?.addEventListener('cancel', event => event.preventDefault());
preview?.querySelector('[data-disclaimer-ack]')?.addEventListener('click', () => {
  record('call_disclaimer_acknowledged');
  if (status) status.textContent = 'Disclaimer acknowledged. This sample has no live calls or bookings.';
});
document.querySelectorAll<HTMLButtonElement>('[data-profile-preview]').forEach(button => button.addEventListener('click', () => {
  const heading = preview?.querySelector('h2');
  const action = button.dataset.profilePreview === 'book' ? 'book' : button.dataset.profilePreview === 'notify' ? 'notify' : 'call';
  if (heading) heading.textContent = action === 'notify' ? `Notify me about ${profileName}` : 'Before you call';
  openDialog(preview, button);
  record(`${action}_preview`);
}));

interface GalleryPhoto { src: string; srcset: string; alt: string; width: number; height: number; }
const galleryData = document.querySelector('#cv-gallery-data');
const photos: GalleryPhoto[] = JSON.parse(galleryData?.textContent || '[]');
const gallery = document.querySelector<HTMLDialogElement>('#cv-gallery-dialog');
let photoIndex = 0;
function showPhoto(index: number) {
  if (!photos.length || !gallery) return;
  photoIndex = (index + photos.length) % photos.length;
  const photo = photos[photoIndex];
  const image = gallery.querySelector<HTMLImageElement>('[data-gallery-image]');
  if (image) { image.src = photo.src; image.srcset = photo.srcset; image.sizes = '(max-width: 849px) calc(100vw - 68px), 810px'; image.alt = photo.alt; image.width = photo.width; image.height = photo.height; }
  const caption = gallery.querySelector('#cv-gallery-caption');
  if (caption) caption.textContent = photo.alt;
  const count = gallery.querySelector('[data-gallery-count]');
  if (count) count.textContent = `${photoIndex + 1} / ${photos.length}`;
}
document.querySelectorAll<HTMLButtonElement>('[data-gallery-index]').forEach(button => button.addEventListener('click', () => {
  showPhoto(Number(button.dataset.galleryIndex));
  openDialog(gallery, button);
  record('gallery_open', { photo_index: photoIndex });
}));
gallery?.querySelectorAll<HTMLButtonElement>('[data-gallery-step]').forEach(button => button.addEventListener('click', () => showPhoto(photoIndex + Number(button.dataset.galleryStep))));
gallery?.addEventListener('keydown', event => {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); showPhoto(photoIndex + (event.key === 'ArrowLeft' ? -1 : 1)); }
});

const shareDialog = document.querySelector<HTMLDialogElement>('#cv-share-dialog');
const shareInput = document.querySelector<HTMLInputElement>('#cv-share-url');
const shareStatus = document.querySelector<HTMLElement>('[data-share-status]');
// Drop all incoming query parameters and fragments; sharing never exposes them.
const shareUrl = new URL(knownProfile ? `/people/${profileId}` : '/', window.location.origin).href;
async function copyLink() {
  try {
    await navigator.clipboard.writeText(shareUrl);
    if (shareStatus) shareStatus.textContent = 'Link copied.';
    if (status) status.textContent = 'Profile link copied.';
    record('share_copy');
    return true;
  } catch {
    if (shareInput) { shareInput.value = shareUrl; shareInput.focus(); shareInput.select(); }
    if (shareStatus) shareStatus.textContent = 'Select and copy the link above.';
    return false;
  }
}
document.querySelector<HTMLButtonElement>('[data-profile-share]')?.addEventListener('click', async event => {
  const button = event.currentTarget as HTMLButtonElement;
  record('share_profile');
  if (navigator.share) {
    try { await navigator.share({ title: `${profileName} — sample profile`, url: shareUrl }); return; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
  }
  if (shareInput) shareInput.value = shareUrl;
  if (shareStatus) shareStatus.textContent = '';
  openDialog(shareDialog, button);
  await copyLink();
});
document.querySelector('[data-copy-link]')?.addEventListener('click', () => { void copyLink(); });

const tabs = [...document.querySelectorAll<HTMLAnchorElement>('.cv-profile-tabs a')];
tabs.forEach(tab => tab.addEventListener('click', () => {
  tabs.forEach(link => link.removeAttribute('aria-current'));
  tab.setAttribute('aria-current', 'location');
  record('profile_section', { section: tab.hash.slice(1) });
}));
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (knownProfile) capture('profile_section_view', { ...metadata, section: entry.target.id });
      observer.unobserve(entry.target);
    }
  }, { threshold: .2 });
  document.querySelectorAll('#about, #moods, #reviews').forEach(section => observer.observe(section));
}

// [HF-PROFILE-DETAIL-2] Voice intro — a visual demo; no audio file exists yet.
const voice = document.querySelector<HTMLElement>('[data-voice]');
const voiceButton = voice?.querySelector<HTMLButtonElement>('[data-voice-play]');
const voiceTime = voice?.querySelector<HTMLElement>('[data-voice-time]');
const voiceCaption = document.querySelector<HTMLElement>('[data-voice-caption]');
let voiceTimer: number | undefined;
let voiceLeft = 20;
function stopVoice() {
  if (voiceTimer) window.clearInterval(voiceTimer);
  voiceTimer = undefined; voiceLeft = 20;
  voice?.classList.remove('is-playing');
  voiceButton?.setAttribute('aria-pressed', 'false');
  if (voiceTime) voiceTime.textContent = '0:20';
}
voiceButton?.addEventListener('click', () => {
  if (voiceTimer) { stopVoice(); return; }
  voice?.classList.add('is-playing');
  voiceButton.setAttribute('aria-pressed', 'true');
  if (voiceCaption) voiceCaption.hidden = false;
  voiceTimer = window.setInterval(() => {
    voiceLeft -= 1;
    if (voiceTime) voiceTime.textContent = `0:${String(Math.max(voiceLeft, 0)).padStart(2, '0')}`;
    if (voiceLeft <= 0) stopVoice();
  }, 1000);
  record('voice_intro_play');
});

// [HF-PROFILE-DETAIL-2] Write a review — demo only. Nothing is sent or stored;
// the review text never leaves the page (analytics gets the star count only).
const reviewDialog = document.querySelector<HTMLDialogElement>('#cv-review-dialog');
const reviewForm = reviewDialog?.querySelector<HTMLFormElement>('[data-review-form]');
const reviewError = reviewDialog?.querySelector<HTMLElement>('[data-review-error]');
const reviewList = document.querySelector<HTMLElement>('[data-review-list]');
document.querySelector<HTMLButtonElement>('[data-review-open]')?.addEventListener('click', event => {
  if (reviewError) reviewError.textContent = '';
  openDialog(reviewDialog, event.currentTarget as HTMLElement);
  reviewDialog?.querySelector<HTMLInputElement>('input[name=rating]')?.focus();
  record('review_open');
});
const escapeText = (value: string) => { const node = document.createElement('span'); node.textContent = value; return node.innerHTML; };
reviewForm?.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(reviewForm);
  const stars = Number(data.get('rating') || 0);
  const text = String(data.get('text') || '').trim();
  const name = String(data.get('name') || '').trim().replace(/\s+/g, ' ').split(' ')[0] || 'You';
  const mood = String(data.get('mood') || '');
  if (!stars) { if (reviewError) reviewError.textContent = 'Please choose a star rating.'; return; }
  if (text.length < 10) { if (reviewError) reviewError.textContent = 'Please write at least 10 characters.'; return; }
  if (/\d{6,}|@/.test(text.replace(/\s/g, ''))) { if (reviewError) reviewError.textContent = 'Please remove phone numbers or email addresses from your review.'; return; }
  const today = new Date();
  const card = document.createElement('article');
  card.className = 'cv-review-card is-new';
  card.setAttribute('aria-label', `Your review: ${stars} out of 5 stars`);
  card.innerHTML = `<span class="cv-review-avatar" aria-hidden="true">${escapeText(name.slice(0, 1).toUpperCase())}</span><div><div class="cv-review-heading"><h3>${escapeText(name)}<span class="cv-review-regular">Your review</span></h3><time datetime="${today.toISOString().slice(0, 10)}">${today.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</time></div><span class="cv-review-stars">${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}</span><p>${escapeText(text)}</p><p class="cv-review-meta">${mood ? `${escapeText(mood)} · ` : ''}Demo · not saved</p></div>`;
  reviewList?.prepend(card);
  reviewForm.reset();
  reviewDialog?.close();
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (status) status.textContent = 'Thank you! Your review is shown on this page only (demo, not saved).';
  record('review_submit_demo', { stars, has_mood: Boolean(mood) });
});

document.documentElement.dataset.profileReady = 'true';
