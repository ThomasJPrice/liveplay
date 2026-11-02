// =====================================================================
// useShowCallingBars.ts
// ---------------------------------------------------------------------
// Open/collapsed state for the bottom Clocks strip, shown while running a
// show (MultiPlay-style always-visible Time/Elapsed/Remaining). Notes used
// to live here too but moved into the workspace pane row (NotesPanel, pane
// id 'notes' in useWorkspaceLayout) since it benefits from the same width/
// collapse controls as the playlist, cart and mixer.
//
// Clocks stays a separate, fixed-height bottom strip rather than a pane:
// it's meant to be glanceable without taking up column width, which suits
// a tall/portrait monitor better than another vertical splitter would.
//
// OWNERSHIP: the MACHINE, like useWorkspaceLayout — a screen's layout
// preference, not a show-file setting.
// =====================================================================

const STORAGE_KEY = 'liveplay-calling-bars';

interface StoredBars {
  clocksOpen?: boolean;
}

let _hydrated = false;

export const useShowCallingBars = () => {
  const clocksOpen = useState<boolean>('liveplay:clocksOpen', () => true);

  if (import.meta.client && !_hydrated) {
    _hydrated = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as StoredBars;
        if (typeof s?.clocksOpen === 'boolean') clocksOpen.value = s.clocksOpen;
      }
    } catch {
      // Unparseable, or storage denied — defaults stand.
    }
  }

  function persist() {
    if (!import.meta.client) return;
    try {
      const out: StoredBars = { clocksOpen: clocksOpen.value };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch {
      // No storage — the session keeps working, it just won't be recalled.
    }
  }

  function toggleClocks() { clocksOpen.value = !clocksOpen.value; persist(); }

  return { clocksOpen, toggleClocks };
};
