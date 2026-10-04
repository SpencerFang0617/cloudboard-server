export function isAppleMobileClient(userAgent: string | undefined, clientHint: string | undefined): boolean {
  if ((clientHint ?? '').trim().toLowerCase() === 'ios') return true;
  const ua = userAgent ?? '';
  return /iPad|iPhone|iPod/i.test(ua) || /Shortcuts\//i.test(ua) || /Scriptable/i.test(ua);
}
