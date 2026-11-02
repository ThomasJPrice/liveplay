<template>
  <div class="notes-panel">
    <div class="notes-panel__header">
      <h2>{{ t('callingBars.notesTitle') }}</h2>
      <PaneControls pane="notes" :divided="false" />
    </div>

    <!-- Now Playing takes most of the height; Up Next is a smaller strip
         below it, same "what's live matters most" priority as the Clocks
         bar. One entry per active cue (overlaid/ducked cues can mean more
         than one is genuinely playing at once, see #80). -->
    <div class="notes-panel__section notes-panel__section--main">
      <h3 class="notes-panel__heading">{{ t('callingBars.nowPlaying') }}</h3>
      <p v-if="!nowPlayingEntries.length" class="notes-panel__empty">{{ t('callingBars.noActiveCues') }}</p>
      <div v-else class="notes-panel__entries">
        <div v-for="entry in nowPlayingEntries" :key="entry.uuid" class="notes-panel__entry">
          <span class="notes-panel__entry-name">{{ entry.name }}</span>
          <p class="notes-panel__entry-text" v-if="entry.notes">{{ entry.notes }}</p>
          <p class="notes-panel__entry-text notes-panel__entry-text--empty" v-else>{{ t('callingBars.noNote') }}</p>
        </div>
      </div>
    </div>

    <div class="notes-panel__divider" aria-hidden="true"></div>

    <div class="notes-panel__section notes-panel__section--next">
      <h3 class="notes-panel__heading">{{ t('callingBars.upNext') }}</h3>
      <p v-if="!upNextEntry" class="notes-panel__empty">{{ t('callingBars.noneQueued') }}</p>
      <div v-else class="notes-panel__entry">
        <span class="notes-panel__entry-name">{{ upNextEntry.name }}</span>
        <p class="notes-panel__entry-text" v-if="upNextEntry.notes">{{ upNextEntry.notes }}</p>
        <p class="notes-panel__entry-text notes-panel__entry-text--empty" v-else>{{ t('callingBars.noNote') }}</p>
      </div>
    </div>
  </div>
</template>

<!--
  NotesPanel.vue
  ---------------------------------------------------------------------
  Side pane (workspace pane id 'notes', see useWorkspaceLayout) showing
  the calling note (AudioItem/GroupItem.notes, edited in the Properties
  panel's Notes tab) for whatever's currently playing and whatever's
  queued as Up Next — the LivePlay equivalent of MultiPlay's Notes panel.
  Read-only here; editing always happens in Properties, same split as
  every other per-cue field. Now Playing gets most of the vertical space
  since it's what the operator needs mid-cue; Up Next is a smaller strip
  underneath for what's coming.
-->
<script setup lang="ts">
import PaneControls from './PaneControls.vue';

const { t } = useLocalization();
const { activeCues, nextItemOverrideUuid, autoNextItemUuid } = useAudioEngine();
const { findItemByUuid } = useProject();

interface NoteEntry { uuid: string; name: string; notes: string }

const nowPlayingEntries = computed<NoteEntry[]>(() => {
  const out: NoteEntry[] = [];
  for (const cue of activeCues.value.values()) {
    const item = findItemByUuid(cue.uuid);
    out.push({ uuid: cue.uuid, name: cue.displayName, notes: (item as any)?.notes || '' });
  }
  return out;
});

// Same precedence as the playlist's "Up Next" badge (PlaylistItem.vue):
// a manual override wins, otherwise fall back to the end-behaviour-derived
// auto next item.
const upNextEntry = computed<NoteEntry | null>(() => {
  const uuid = nextItemOverrideUuid.value || autoNextItemUuid.value;
  if (!uuid) return null;
  const item = findItemByUuid(uuid);
  if (!item) return null;
  return { uuid, name: item.displayName, notes: (item as any).notes || '' };
});
</script>

<style scoped lang="scss">
.notes-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: var(--color-background);
}

.notes-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm);
  padding: 0 var(--spacing-lg);
  // Matches CartPlayer/MixerPanel: one fixed height for every pane header
  // so they line up side by side.
  height: 60px;
  flex: 0 0 auto;
  box-sizing: border-box;
  border-bottom: 1px solid var(--color-border);
  background-color: var(--color-surface);

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
}

.notes-panel__section {
  padding: var(--spacing-md) var(--spacing-lg);
  overflow-y: auto;
  min-height: 0;
}

.notes-panel__section--main {
  flex: 1 1 auto;
}

.notes-panel__section--next {
  flex: 0 0 auto;
  max-height: 35%;
}

.notes-panel__divider {
  height: 1px;
  background-color: var(--color-border);
  flex-shrink: 0;
}

.notes-panel__heading {
  margin: 0 0 var(--spacing-sm);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

.notes-panel__empty {
  margin: 0;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.notes-panel__entries {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.notes-panel__entry-name {
  display: block;
  font-size: 14px;
  font-weight: 600;
}

.notes-panel__entry-text {
  margin: 4px 0 0;
  font-size: 14px;
  line-height: 1.5;
  white-space: pre-wrap;
  color: var(--color-text-primary);
}

.notes-panel__entry-text--empty {
  color: var(--color-text-secondary);
  font-style: italic;
}
</style>
