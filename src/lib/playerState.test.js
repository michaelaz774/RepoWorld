import { describe, it, expect, beforeEach } from 'vitest';
import {
  playerState,
  resetPlayerState,
  acquireUiFocus,
  releaseUiFocus,
  uiFocusHolders,
} from './playerState.js';

describe('uiFocused ownership', () => {
  beforeEach(() => {
    resetPlayerState({ x: 0, y: 2, z: 0 });
  });

  it('starts unfocused with no holders', () => {
    expect(playerState.uiFocused).toBe(false);
    expect(uiFocusHolders()).toEqual([]);
  });

  it('one panel focuses and unfocuses', () => {
    acquireUiFocus('review');
    expect(playerState.uiFocused).toBe(true);
    releaseUiFocus('review');
    expect(playerState.uiFocused).toBe(false);
  });

  it('stays focused while a second panel still holds it', () => {
    // The real case: the wizard chat is open and killing a bug opens the review
    // panel on top. The review panel closing must NOT unfreeze the world while
    // the chat is still up — which is exactly what a bare boolean used to do.
    acquireUiFocus('wizard');
    acquireUiFocus('review');
    releaseUiFocus('review');
    expect(playerState.uiFocused).toBe(true);
    expect(uiFocusHolders()).toEqual(['wizard']);
    releaseUiFocus('wizard');
    expect(playerState.uiFocused).toBe(false);
  });

  it('is idempotent — double acquire needs only one release', () => {
    acquireUiFocus('npc');
    acquireUiFocus('npc');
    releaseUiFocus('npc');
    expect(playerState.uiFocused).toBe(false);
  });

  it('ignores a release from an owner that never acquired', () => {
    acquireUiFocus('wizard');
    releaseUiFocus('someone-else');
    expect(playerState.uiFocused).toBe(true);
  });

  it('resetPlayerState drops every holder, so a new world starts unfrozen', () => {
    acquireUiFocus('wizard');
    acquireUiFocus('review');
    resetPlayerState({ x: 1, y: 2, z: 3 });
    expect(playerState.uiFocused).toBe(false);
    expect(uiFocusHolders()).toEqual([]);
  });

  it('resetPlayerState clears the proximity flags', () => {
    playerState.nearbyWizard = true;
    playerState.nearbyCar = 'car-0';
    playerState.driving = true;
    resetPlayerState({ x: 0, y: 2, z: 0 });
    expect(playerState.nearbyWizard).toBe(false);
    expect(playerState.nearbyCar).toBe(null);
    expect(playerState.driving).toBe(false);
  });
});
