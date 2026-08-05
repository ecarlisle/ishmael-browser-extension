// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { applyStatusTone, toneForStatus } from './status-tone';

describe('toneForStatus', () => {
  it('maps error to an alert-role rose tone, never green', () => {
    expect(toneForStatus('error')).toEqual({
      className: 'status--error',
      role: 'alert',
      ariaLive: 'assertive',
    });
  });

  it('maps success to a polite status tone', () => {
    expect(toneForStatus('success')).toEqual({
      className: 'status--success',
      role: 'status',
      ariaLive: 'polite',
    });
  });

  it('maps info to a polite status tone', () => {
    expect(toneForStatus('info')).toEqual({
      className: 'status--info',
      role: 'status',
      ariaLive: 'polite',
    });
  });
});

describe('applyStatusTone', () => {
  it('applies the tone classes and ARIA attributes', () => {
    const element = document.createElement('p');
    applyStatusTone(element, 'error');
    expect(element.classList.contains('status--error')).toBe(true);
    expect(element.getAttribute('role')).toBe('alert');
    expect(element.getAttribute('aria-live')).toBe('assertive');
  });

  it('replaces a previous tone instead of stacking classes', () => {
    const element = document.createElement('p');
    applyStatusTone(element, 'error');
    applyStatusTone(element, 'success');
    expect(element.classList.contains('status--error')).toBe(false);
    expect(element.classList.contains('status--success')).toBe(true);
    expect(element.classList.contains('status--info')).toBe(false);
    expect(element.getAttribute('role')).toBe('status');
    expect(element.getAttribute('aria-live')).toBe('polite');
  });
});
