/** Only the affirmative acknowledgement callback may write; no transaction callback is accepted. */
export async function explicitAgeRecovery(
  confirm: () => boolean,
  acknowledge: () => Promise<{ ok: boolean; message?: string }>,
): Promise<string> {
  if (!confirm()) return 'Please confirm that you are 18 or older to continue.';
  try {
    const result = await acknowledge();
    return result.ok ? 'Age confirmation saved. Please try your call or booking again.' : result.message || 'We could not save your age confirmation. Please try again.';
  } catch {
    return 'We could not save your age confirmation. Please try again.';
  }
}
