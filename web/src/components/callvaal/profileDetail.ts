import { capture } from '../../lib/analytics';

// Only allowlisted fictional profile/category ids and fixed actions reach analytics.
const profileElement = document.querySelector<HTMLElement>('[data-profile-id]');
const sampleProfiles: Record<string, string> = { 'dr-ananya': 'doctors', sana: 'counsellor', neha: 'listener', kavya: 'astrology', priya: 'practice' };
const profileId = profileElement?.dataset.profileId || '';
const profileName = profileElement?.dataset.profileName || 'this sample profile';
const categoryId = Object.prototype.hasOwnProperty.call(sampleProfiles, profileId) ? sampleProfiles[profileId] : undefined;
const metadata = { surface: 'callvaal-profile', profile_id: profileId, category: categoryId, sample_profile: true };
const status = document.querySelector<HTMLElement>('[data-profile-status]');
function record(action: string, extra: Record<string, string | number | boolean> = {}) {
  if (!categoryId) return;
  capture('cta_click', { ...metadata, label: action, ...extra });
}
const triggers = new WeakMap<HTMLDialogElement, HTMLElement>();
function openDialog(dialog: HTMLDialogElement | null, trigger: HTMLElement) {
  if (!dialog || dialog.open) return;
  triggers.set(dialog, trigger);
  dialog.showModal();
  dialog.querySelector<HTMLButtonElement>('[data-dialog-close]')?.focus();
}
document.querySelectorAll<HTMLDialogElement>('.cv-detail-dialog').forEach(dialog => {
  dialog.querySelector('[data-dialog-close]')?.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { triggers.get(dialog)?.focus(); triggers.delete(dialog); });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
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
document.querySelectorAll<HTMLButtonElement>('[data-profile-preview]').forEach(button => button.addEventListener('click', () => {
  const heading = preview?.querySelector('h2');
  const action = button.dataset.profilePreview === 'book' ? 'book' : 'call';
  if (heading) heading.textContent = action === 'book' ? `Book a time with ${profileName}` : `Call ${profileName}`;
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
const shareUrl = new URL(categoryId ? `/people/${profileId}` : '/', window.location.origin).href;
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
      if (categoryId) capture('profile_section_view', { ...metadata, section: entry.target.id });
      observer.unobserve(entry.target);
    }
  }, { threshold: .2 });
  document.querySelectorAll('#about, #services, #gallery, #reviews').forEach(section => observer.observe(section));
}
document.documentElement.dataset.profileReady = 'true';
