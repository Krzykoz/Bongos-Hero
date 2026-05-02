/**
 * Tiny DOM helpers used by the scene overlays.
 *
 * Centralising these means scenes can focus on layout/behaviour without
 * boilerplate `document.createElement` chains, and we get one place to keep
 * formatting (numbers / time) consistent across the app.
 */

type ElProps<K extends keyof HTMLElementTagNameMap> = Partial<
  HTMLElementTagNameMap[K]
>;

/**
 * Create a DOM element, optionally setting properties (assigned with
 * `Object.assign`) and appending children. Children may be nodes or strings.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: ElProps<K>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    Object.assign(node, props);
  }
  if (children) {
    for (const child of children) {
      if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

/** Remove all children from `node`. */
export function clear(node: HTMLElement): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/** Format a duration in ms as `m:ss` (e.g. 73210 → "1:13"). */
export function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const NUMBER_FMT = new Intl.NumberFormat('en-US');

/** Format a number with grouping separators (e.g. 12345 → "12,345"). */
export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return NUMBER_FMT.format(Math.round(n));
}
