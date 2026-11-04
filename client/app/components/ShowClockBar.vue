<template>
  <div class="calling-bar" :class="{ collapsed: !clocksOpen }">
    <button class="calling-bar__header" @click="toggleClocks" :aria-expanded="clocksOpen">
      <span class="material-symbols-rounded calling-bar__chevron">{{ clocksOpen ? 'expand_more' : 'chevron_right' }}</span>
      <span class="material-symbols-rounded calling-bar__icon">timer</span>
      <span class="calling-bar__title">{{ t('callingBars.clocksTitle') }}</span>
      <span v-if="!clocksOpen && current" class="calling-bar__summary">{{ current.displayName }}</span>
    </button>

    <div v-if="clocksOpen" class="calling-bar__body clock-bar__body">
      <span class="clock-bar__cue-name" :title="current?.displayName">
        {{ current ? current.displayName : t('callingBars.noActiveCues') }}
      </span>
      <div class="clock-bar__clocks">
        <div class="digital-clock clock--active">
          <span class="clock-label">{{ t('callingBars.time') }}</span>
          <span class="clock-value">{{ wallClock }}</span>
        </div>
        <div class="digital-clock" :class="current ? 'clock--active' : 'clock--inactive'">
          <span class="clock-label">{{ t('callingBars.elapsed') }}</span>
          <span class="clock-value">{{ elapsedDisplay }}</span>
        </div>
        <div class="digital-clock" :class="remainingClass">
          <span class="clock-label">{{ t('callingBars.remaining') }}</span>
          <span class="clock-value">{{ remainingDisplay }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<!--
  ShowClockBar.vue
  ---------------------------------------------------------------------
  A collapsible strip pinned to the bottom of the workspace: three
  side-by-side digital clocks (Time / Elapsed / Remaining), matching
  MultiPlay's Clock + Remaining Time + Elapsed Time panels. Elapsed and
  Remaining always describe the SAME cue — the most recently started one
  still playing — never a mix of several; `activeCues` is a Map, and a
  cue's key keeps its original insertion position when re-set (see
  useAudioEngine's upsertActiveCue), so the last entry in iteration order
  is reliably "most recently started" without tracking timestamps
  ourselves.

  Elapsed/Remaining are derived from ONE floored seconds value so they can
  never visibly drift out of sync with each other: formatting each side
  independently (floor(elapsed) and floor(duration - elapsed) separately)
  can differ by a second depending on where the fractional part falls,
  which read as "elapsed ticking faster than remaining" during testing.
-->
<script setup lang="ts">
const { t } = useLocalization();
const { activeCues } = useAudioEngine();
const { clocksOpen, toggleClocks } = useShowCallingBars();

const current = computed(() => {
  const vals = Array.from(activeCues.value.values());
  return vals.length ? vals[vals.length - 1] : null;
});

const elapsedSeconds = computed(() => current.value ? Math.max(0, Math.floor(current.value.currentTime)) : 0);
const totalSeconds = computed(() => current.value ? Math.max(0, Math.floor(current.value.duration)) : 0);
const remainingSeconds = computed(() => Math.max(0, totalSeconds.value - elapsedSeconds.value));

function formatClock(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
    : `${m}:${s.toString().padStart(2, '0')}`;
}

const elapsedDisplay   = computed(() => current.value ? formatClock(elapsedSeconds.value)   : '--:--');
const remainingDisplay = computed(() => current.value ? formatClock(remainingSeconds.value) : '--:--');

const remainingClass = computed(() => {
  if (!current.value) return 'clock--inactive';
  const r = remainingSeconds.value;
  if (r <= 5) return 'clock--danger';
  if (r <= 10) return 'clock--warn';
  if (r <= 30) return 'clock--caution';
  return 'clock--active';
});

// ---- Wall clock, same format as ProjectHeader's --------------------------
const wallClock = ref('--:--:--');
let wallClockInterval: ReturnType<typeof setInterval> | null = null;
function updateWallClock() {
  const now = new Date();
  wallClock.value = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
}
onMounted(() => {
  updateWallClock();
  wallClockInterval = setInterval(updateWallClock, 1000);
});
onUnmounted(() => {
  if (wallClockInterval) clearInterval(wallClockInterval);
});
</script>

<style scoped lang="scss">
.calling-bar {
  flex: 0 0 auto;
  border-top: 1px solid var(--color-border);
  background-color: var(--color-surface);
}

.calling-bar__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  width: 100%;
  padding: 6px var(--spacing-md);
  background: transparent;
  border: none;
  color: var(--color-text-primary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  text-align: left;

  &:hover { background-color: var(--color-surface-hover, var(--color-surface)); }
}

.calling-bar__chevron {
  font-size: 18px;
  color: var(--color-text-secondary);
}

.calling-bar__icon {
  font-size: 16px;
  color: var(--color-text-secondary);
}

.calling-bar__summary {
  margin-left: auto;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}

.clock-bar__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
}

.clock-bar__cue-name {
  font-size: 14px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.clock-bar__clocks {
  display: flex;
  gap: var(--spacing-lg);
}

// Same visual language as ProjectHeader's wall clock.
.digital-clock {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px var(--spacing-lg);
  border-radius: 4px;
  background-color: var(--color-background);
  min-width: 120px;
}

.clock-label {
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  margin-bottom: 2px;
}

.clock-value {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
}

.clock--active   { color: var(--color-accent); }
.clock--inactive { color: var(--color-text-secondary); opacity: 0.5; }
.clock--caution  { color: var(--color-warning, #f1c21b); }
.clock--warn     { color: #ff8c1a; }
.clock--danger   { color: var(--color-danger, #fa4d56); }
</style>
