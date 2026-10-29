// [HF-SUPPORT-DESK] support.<domain> host helpers.
import { describe, it, expect } from 'vitest';
import { isSupportHost, isSupportPath, supportRewritePath } from './supportHost';

const u = (s: string) => new URL(s);

describe('support host rewrite', () => {
  it('maps the support host to the mounted desk', () => {
    expect(supportRewritePath(u('https://support.hellofraands.com/'))).toBe('/support-desk');
    expect(supportRewritePath(u('https://support.hellofraands.com/desk/t/HF-10240?focus=note'))).toBe('/support-desk/desk/t/HF-10240?focus=note');
    expect(supportRewritePath(u('https://support.hellofraands.com/t/HF-1/'))).toBe('/support-desk/t/HF-1');
  });
  it('leaves assets, files, the mounted path and other hosts alone', () => {
    expect(supportRewritePath(u('https://support.hellofraands.com/_astro/x.js'))).toBeNull();
    expect(supportRewritePath(u('https://support.hellofraands.com/fonts/Nunito-Bold.woff2'))).toBeNull();
    expect(supportRewritePath(u('https://support.hellofraands.com/favicon.ico'))).toBeNull();
    expect(supportRewritePath(u('https://support.hellofraands.com/support-desk/desk'))).toBeNull();
    expect(supportRewritePath(u('https://hellofraands.com/new'))).toBeNull();
  });
  it('recognises the host and the mount path', () => {
    expect(isSupportHost('SUPPORT.hellofraands.com:443')).toBe(true);
    expect(isSupportHost('hellofraands.com')).toBe(false);
    expect(isSupportPath('/support-desk/x')).toBe(true);
    expect(isSupportPath('/support-deskx')).toBe(false);
  });
});
