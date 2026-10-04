import { describe, expect, it } from 'vitest';
import { urlTransform } from './Markdown';

const img = { tagName: 'img' } as never;
const a = { tagName: 'a' } as never;

describe('urlTransform', () => {
  it('lets embedded images through as image sources only', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(urlTransform(png, 'src', img)).toBe(png);
    expect(urlTransform('data:image/svg+xml;utf8,<svg/>', 'src', img)).toMatch(/^data:image\/svg/);
    expect(urlTransform(png, 'href', a)).toBe('');
    expect(urlTransform('data:text/html;base64,PHNjcmlwdD4=', 'src', img)).toBe('');
    expect(urlTransform('javascript:alert(1)', 'href', a)).toBe('');
    expect(urlTransform('https://example.com/x.png', 'src', img)).toBe('https://example.com/x.png');
  });
});
