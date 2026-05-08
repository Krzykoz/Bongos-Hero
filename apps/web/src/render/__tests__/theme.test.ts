import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULTS, saveSettings } from '../../settings/index.js';
import {
  COLORBLIND_PALETTE,
  DEFAULT_PALETTE,
  getActivePalette,
  getPaletteEpoch,
  type LanePalette,
  subscribePalette,
  THEME,
} from '../theme.js';

const HEX = /^#[0-9a-fA-F]{6}$/;

function expectValidLaneColours(p: LanePalette['L'] | LanePalette['R']): void {
  expect(p.fill).toMatch(HEX);
  expect(p.glow.length).toBeGreaterThan(0);
  expect(p.ringHit.length).toBeGreaterThan(0);
}

describe('palette constants', () => {
  it('DEFAULT_PALETTE has all required fields', () => {
    expectValidLaneColours(DEFAULT_PALETTE.L);
    expectValidLaneColours(DEFAULT_PALETTE.R);
    expect(DEFAULT_PALETTE.spOverlay.length).toBeGreaterThan(0);
  });

  it('COLORBLIND_PALETTE has all required fields', () => {
    expectValidLaneColours(COLORBLIND_PALETTE.L);
    expectValidLaneColours(COLORBLIND_PALETTE.R);
    expect(COLORBLIND_PALETTE.spOverlay.length).toBeGreaterThan(0);
  });

  it('palettes are distinguishable from each other', () => {
    expect(DEFAULT_PALETTE.L.fill).not.toBe(COLORBLIND_PALETTE.L.fill);
    expect(DEFAULT_PALETTE.R.fill).not.toBe(COLORBLIND_PALETTE.R.fill);
    expect(DEFAULT_PALETTE.spOverlay).not.toBe(COLORBLIND_PALETTE.spOverlay);
  });

  it('each palette keeps L and R distinguishable', () => {
    // Fundamental requirement: L and R must be different. The colour-blind
    // palette additionally ensures the hues stay distinguishable under
    // red-green colour-vision-deficiency (cool blue vs warm amber).
    expect(DEFAULT_PALETTE.L.fill).not.toBe(DEFAULT_PALETTE.R.fill);
    expect(COLORBLIND_PALETTE.L.fill).not.toBe(COLORBLIND_PALETTE.R.fill);
  });
});

describe('getActivePalette + subscribePalette', () => {
  beforeEach(() => {
    // Force the colour-blind setting back to a known baseline before every
    // test. `saveSettings` notifies all subscribers synchronously, so the
    // active palette is up to date by the time the test body runs.
    saveSettings({ ...DEFAULTS });
  });

  it('returns DEFAULT_PALETTE when colorBlind=false', () => {
    saveSettings({ colorBlind: false });
    expect(getActivePalette()).toBe(DEFAULT_PALETTE);
  });

  it('returns COLORBLIND_PALETTE when colorBlind=true', () => {
    saveSettings({ colorBlind: true });
    expect(getActivePalette()).toBe(COLORBLIND_PALETTE);
  });

  it('THEME.laneL / laneR / spOverlay forward to the active palette', () => {
    saveSettings({ colorBlind: false });
    expect(THEME.laneL).toBe(DEFAULT_PALETTE.L);
    expect(THEME.laneR).toBe(DEFAULT_PALETTE.R);
    expect(THEME.spOverlay).toBe(DEFAULT_PALETTE.spOverlay);

    saveSettings({ colorBlind: true });
    expect(THEME.laneL).toBe(COLORBLIND_PALETTE.L);
    expect(THEME.laneR).toBe(COLORBLIND_PALETTE.R);
    expect(THEME.spOverlay).toBe(COLORBLIND_PALETTE.spOverlay);
  });

  it('subscribePalette fires the callback synchronously on subscribe', () => {
    saveSettings({ colorBlind: false });
    let calls = 0;
    let received: LanePalette | null = null;
    const unsub = subscribePalette((p) => {
      calls++;
      received = p;
    });
    expect(calls).toBe(1);
    expect(received).toBe(DEFAULT_PALETTE);
    unsub();
  });

  it('subscribePalette delivers later palette changes', () => {
    saveSettings({ colorBlind: false });
    const seen: LanePalette[] = [];
    const unsub = subscribePalette((p) => {
      seen.push(p);
    });
    // Initial sync delivery.
    expect(seen).toEqual([DEFAULT_PALETTE]);

    saveSettings({ colorBlind: true });
    expect(seen).toEqual([DEFAULT_PALETTE, COLORBLIND_PALETTE]);

    saveSettings({ colorBlind: false });
    expect(seen).toEqual([DEFAULT_PALETTE, COLORBLIND_PALETTE, DEFAULT_PALETTE]);
    unsub();
  });

  it('does not re-notify when the palette is unchanged', () => {
    saveSettings({ colorBlind: false });
    const seen: LanePalette[] = [];
    const unsub = subscribePalette((p) => {
      seen.push(p);
    });
    seen.length = 0; // discard the synchronous initial delivery

    // Setting colorBlind to its current value resolves to the same palette
    // reference; the bridge should short-circuit and skip notifications.
    saveSettings({ colorBlind: false });
    expect(seen).toHaveLength(0);
    unsub();
  });

  it('unsubscribe stops further notifications', () => {
    saveSettings({ colorBlind: false });
    let calls = 0;
    const unsub = subscribePalette(() => {
      calls++;
    });
    expect(calls).toBe(1);
    unsub();
    saveSettings({ colorBlind: true });
    expect(calls).toBe(1);
  });

  it('getPaletteEpoch advances on every actual palette change', () => {
    saveSettings({ colorBlind: false });
    const before = getPaletteEpoch();
    saveSettings({ colorBlind: true });
    const after = getPaletteEpoch();
    expect(after).toBeGreaterThan(before);
    saveSettings({ colorBlind: true }); // no-op
    expect(getPaletteEpoch()).toBe(after);
    saveSettings({ colorBlind: false });
    expect(getPaletteEpoch()).toBeGreaterThan(after);
  });
});
