<template>
  <div class="notes-panel">
    <div class="notes-panel__header">
      <h2>{{ t('callingBars.notesTitle') }}</h2>
      <PaneControls pane="notes" :divided="false" />
    </div>

    <!-- MultiPlay-style stack: the cue just before the head (small, dimmed),
         the head itself (large, highlighted — this is what GO will fire),
         then the cue just after it (small, dimmed). Previous/Next follow
         the exact same flattened order PREV/NEXT step through (a play-first
         group aliases its first child, same as useShowControl.selectStep),
         so what's shown here never disagrees with what those buttons do. -->
    <div class="notes-panel__section notes-panel__section--minor">
      <h3 class="notes-panel__heading">{{ t('callingBars.previousCue') }}</h3>
      <p v-if="!previousEntry" class="notes-panel__empty">{{ t('callingBars.noneQueued') }}</p>
      <div v-else class="notes-panel__entry">
        <span class="notes-panel__entry-name">{{ previousEntry.name }}</span>
        <!-- Always rendered, even blank: a fixed 2-line box so the whole
             panel doesn't reflow when a note is added/removed. -->
        <p class="notes-panel__entry-text notes-panel__entry-text--clamped">{{ previousEntry.notes }}</p>
      </div>
    </div>

    <div class="notes-panel__divider" aria-hidden="true"></div>

    <div class="notes-panel__section notes-panel__section--main">
      <h3 class="notes-panel__heading notes-panel__heading--selected">{{ t('callingBars.selectedCue') }}</h3>
      <p v-if="!selectedEntry" class="notes-panel__empty">{{ t('callingBars.noneSelected') }}</p>
      <div v-else class="notes-panel__entry notes-panel__entry--selected">
        <span class="notes-panel__entry-name">{{ selectedEntry.name }}</span>
        <p class="notes-panel__entry-text" v-if="selectedEntry.notes">{{ selectedEntry.notes }}</p>
        <p class="notes-panel__entry-text notes-panel__entry-text--empty" v-else>{{ t('callingBars.noNote') }}</p>
      </div>
    </div>

    <div class="notes-panel__divider" aria-hidden="true"></div>

    <div class="notes-panel__section notes-panel__section--minor">
      <h3 class="notes-panel__heading">{{ t('callingBars.nextCue') }}</h3>
      <p v-if="!nextEntry" class="notes-panel__empty">{{ t('callingBars.noneQueued') }}</p>
      <div v-else class="notes-panel__entry">
        <span class="notes-panel__entry-name">{{ nextEntry.name }}</span>
        <p class="notes-panel__entry-text notes-panel__entry-text--clamped">{{ nextEntry.notes }}</p>
      </div>
    </div>
  </div>
</template>

<!--
  NotesPanel.vue
  ---------------------------------------------------------------------
  Side pane (workspace pane id 'notes', see useWorkspaceLayout) showing
  the calling note (AudioItem/GroupItem.notes, edited in the Properties
  panel's Notes tab) for the cue the head is on and its neighbours —
  mirrors MultiPlay's Notes panel, which centres the same way on the
  armed GO cue with the one before/after shown smaller above and below.
  Read-only here; editing always happens in Properties, same split as
  every other per-cue field.
-->
<script setup lang="ts">
import PaneControls from './PaneControls.vue';
import type { AudioItem, BaseItem, GroupItem } from '~/types/project';

const { t } = useLocalization();
// The head — see the Head pointer + Cue Advance plan.
const { selectedItemUuid } = useShowControl();
const { currentProject } = useProject();

interface NoteEntry { uuid: string; name: string; notes: string }

// Mirrors the server's flat_item_uuids_locked: a play-first group aliases
// its first child (resolve_selection_target_locked redirects to it), so it
// isn't given its own stop here either — keeps Previous/Next in step with
// what PREV/NEXT actually land on, never a group heading they'd skip past.
const flatPlayable = computed<BaseItem[]>(() => {
  const out: BaseItem[] = [];
  const walk = (items: (AudioItem | GroupItem)[]) => {
    for (const item of items) {
      const isGroup = item.type === 'group';
      const startAction = isGroup ? ((item as GroupItem).startBehavior?.action ?? 'play-first') : undefined;
      if (!(isGroup && startAction === 'play-first')) out.push(item);
      if (isGroup) walk((item as GroupItem).children ?? []);
    }
  };
  walk(currentProject.value?.items ?? []);
  return out;
});

const selectedIndex = computed(() =>
  selectedItemUuid.value ? flatPlayable.value.findIndex(it => it.uuid === selectedItemUuid.value) : -1,
);

function entryFor(item: BaseItem | undefined): NoteEntry | null {
  if (!item) return null;
  return { uuid: item.uuid, name: item.displayName, notes: (item as any).notes || '' };
}

const previousEntry = computed(() =>
  selectedIndex.value > 0 ? entryFor(flatPlayable.value[selectedIndex.value - 1]) : null,
);
const selectedEntry = computed(() => entryFor(flatPlayable.value[selectedIndex.value]));
const nextEntry = computed(() =>
  selectedIndex.value >= 0 ? entryFor(flatPlayable.value[selectedIndex.value + 1]) : null,
);
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
  padding: var(--spacing-sm) var(--spacing-lg);
  overflow-y: auto;
  min-height: 0;
}

// Previous/Next: capped, secondary — context, not the focus.
.notes-panel__section--minor {
  flex: 0 0 auto;
  max-height: 20%;
  opacity: 0.6;
  // Matches the entry-name line plus the 2-line clamped note box below it,
  // so "nothing before/after" and "a cue with/without a note" all reserve
  // the same footprint — nothing above or below this section ever reflows.
  min-height: calc(1em + 2px + 13px * 1.4 * 2);
}

// Selected: the main event, same way MultiPlay's armed-GO row dominates.
.notes-panel__section--main {
  flex: 1 1 auto;
  padding-top: var(--spacing-md);
}

.notes-panel__divider {
  height: 1px;
  background-color: var(--color-border);
  flex-shrink: 0;
}

.notes-panel__heading {
  margin: 0 0 var(--spacing-xs);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
}

.notes-panel__heading--selected {
  color: var(--color-accent);
}

.notes-panel__empty {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.notes-panel__entry-name {
  display: block;
  font-size: 13px;
  font-weight: 600;
}

.notes-panel__entry-text {
  margin: 2px 0 0;
  font-size: 13px;
  line-height: 1.4;
  white-space: pre-wrap;
  color: var(--color-text-primary);
}

.notes-panel__entry-text--empty {
  color: var(--color-text-secondary);
  font-style: italic;
}

// Previous/Next: always rendered (even with empty text), clamped to exactly
// 2 lines both ways — a short note doesn't leave the box collapsed and a
// long one doesn't grow it — so adding/removing/editing a note never
// reflows the Selected section above/below it.
.notes-panel__entry-text--clamped {
  min-height: calc(13px * 1.4 * 2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: normal;
}

// The selected cue's own name/note read bigger — it's the one the operator
// is about to call.
.notes-panel__section--main .notes-panel__entry-name {
  font-size: 18px;
}
.notes-panel__section--main .notes-panel__entry-text {
  font-size: 15px;
  line-height: 1.5;
}
</style>
