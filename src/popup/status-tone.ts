// Popup status presentation: state → CSS tone + ARIA live-region role.
// Pure so the mapping is unit-testable. Color never carries the meaning
// alone — every tone also has explicit wording and a matching live-region
// role.

export type StatusKind = 'error' | 'success' | 'info';

export type StatusTone = {
  /** CSS modifier class applied to the .status element. */
  className: string;
  /** Assertive for errors, polite otherwise. */
  role: 'alert' | 'status';
  /** Matches the role so announced behavior is unambiguous. */
  ariaLive: 'assertive' | 'polite';
};

export function toneForStatus(kind: StatusKind): StatusTone {
  switch (kind) {
    case 'error':
      return { className: 'status--error', role: 'alert', ariaLive: 'assertive' };
    case 'success':
      return { className: 'status--success', role: 'status', ariaLive: 'polite' };
    case 'info':
      return { className: 'status--info', role: 'status', ariaLive: 'polite' };
  }
}

/** Applies the tone for `kind` to a status element (replacing any previous). */
export function applyStatusTone(element: HTMLElement, kind: StatusKind): void {
  const tone = toneForStatus(kind);
  element.classList.remove('status--error', 'status--success', 'status--info');
  element.classList.add(tone.className);
  element.setAttribute('role', tone.role);
  element.setAttribute('aria-live', tone.ariaLive);
}
