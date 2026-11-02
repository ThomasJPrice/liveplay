<template>
  <Teleport to="body">
    <div v-if="diff" class="ss-backdrop" :data-theme="theme" @click.self="$emit('cancel')">
      <div class="ss-modal" role="dialog" aria-modal="true">
        <header class="ss-header">
          <h3>{{ t('sheetSync.diffTitle') }}</h3>
        </header>

        <div class="ss-body">
          <p v-if="isEmpty" class="ss-empty">{{ t('sheetSync.diffEmpty') }}</p>

          <template v-else>
            <section v-if="diff.errors.length" class="ss-section ss-section--errors">
              <h4>{{ t('sheetSync.diffErrors', { count: diff.errors.length }) }}</h4>
              <p class="ss-help">{{ t('sheetSync.diffErrorsHelp') }}</p>
              <ul class="ss-list">
                <li v-for="(e, i) in diff.errors" :key="i">
                  {{ t('sheetSync.diffRow', { row: e.rowNumber }) }} — {{ e.message }}
                </li>
              </ul>
            </section>

            <section v-if="diff.adds.length" class="ss-section">
              <h4>{{ t('sheetSync.diffAdds', { count: diff.adds.length }) }}</h4>
              <ul class="ss-list">
                <li v-for="(a, i) in diff.adds" :key="i">{{ a.type }} — {{ a.name }}</li>
              </ul>
            </section>

            <section v-if="diff.changes.length" class="ss-section">
              <h4>{{ t('sheetSync.diffChanges', { count: diff.changes.length }) }}</h4>
              <ul class="ss-list">
                <li v-for="(c, i) in diff.changes" :key="i">
                  <strong>{{ c.name }}</strong> — {{ fieldLabel(c.field) }}:
                  <code>{{ display(c.from) }}</code> → <code>{{ display(c.to) }}</code>
                </li>
              </ul>
            </section>

            <section v-if="diff.reordered" class="ss-section">
              <p class="ss-help">{{ t('sheetSync.diffReordered') }}</p>
            </section>

            <section v-if="diff.missingFromSheet.length" class="ss-section ss-section--warn">
              <h4>{{ t('sheetSync.diffMissing', { count: diff.missingFromSheet.length }) }}</h4>
              <p class="ss-help">{{ t('sheetSync.diffMissingHelp') }}</p>
              <ul class="ss-list">
                <li v-for="(m, i) in diff.missingFromSheet" :key="i">{{ m.name }}</li>
              </ul>
            </section>
          </template>
        </div>

        <div class="ss-actions">
          <button class="ss-btn ghost" @click="$emit('cancel')">{{ t('sheetSync.diffCancel') }}</button>
          <button
            class="ss-btn primary"
            :disabled="diff.errors.length > 0 || isEmpty"
            @click="$emit('confirm')"
          >
            {{ t('sheetSync.diffApply') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<!--
  SheetSyncDiffDialog.vue
  ---------------------------------------------------------------------
  Shown after a Pull, before anything touches the live project. Nothing
  is applied until "Apply" is pressed, and Apply is disabled while the
  diff carries any row errors — a half-valid sheet should be fixed and
  re-pulled, not partially applied. Deletions are never offered here:
  cues missing from the sheet are listed for information only (see
  useSheetSync.ts), never removed by a Pull.
-->
<script setup lang="ts">
import type { SheetDiff } from '~/composables/useSheetSync';

const props = defineProps<{ diff: SheetDiff | null }>();
defineEmits<{ confirm: []; cancel: [] }>();

const { t } = useLocalization();
const theme = useState<string>('theme', () => 'dark');

const isEmpty = computed(() => {
  const d = props.diff;
  if (!d) return true;
  return d.adds.length === 0 && d.changes.length === 0 && !d.reordered &&
         d.missingFromSheet.length === 0 && d.errors.length === 0;
});

const FIELD_LABELS: Record<string, string> = {
  displayName: 'sheetSync.fieldName',
  color: 'sheetSync.fieldColour',
  startBehavior: 'sheetSync.fieldStartBehaviour',
  endBehavior: 'sheetSync.fieldEndBehaviour',
  cueAdvance: 'sheetSync.fieldCueAdvance',
  busId: 'sheetSync.fieldBus',
  volume: 'sheetSync.fieldVolume',
};
function fieldLabel(field: string): string {
  const key = FIELD_LABELS[field];
  return key ? t(key) : field;
}
function display(v: unknown): string {
  if (v === undefined || v === null || v === '') return t('sheetSync.fieldEmpty');
  return String(v);
}
</script>

<style lang="scss">
.ss-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.6);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}
.ss-modal {
  background: var(--color-surface, #262626);
  border: 1px solid var(--color-border, #525252);
  color: var(--color-text-primary, #f4f4f4);
  border-radius: 8px;
  padding: 24px;
  width: 560px;
  max-width: 90vw;
  max-height: 80vh;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  display: flex; flex-direction: column; gap: 16px;
}
.ss-header h3 { margin: 0; font-size: 18px; font-weight: 600; }
.ss-body { overflow-y: auto; display: flex; flex-direction: column; gap: 16px; }
.ss-empty { color: var(--color-text-secondary, #c6c6c6); font-size: 14px; }
.ss-section h4 { margin: 0 0 4px; font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8; }
.ss-section--errors h4 { color: var(--color-danger, #fa4d56); }
.ss-section--warn h4 { color: #ffc400; }
.ss-help { margin: 0 0 8px; font-size: 12px; color: var(--color-text-secondary, #c6c6c6); }
.ss-list {
  margin: 0; padding-left: 18px;
  font-size: 13px; line-height: 1.6;
  color: var(--color-text-primary, #f4f4f4);
  max-height: 180px; overflow-y: auto;
}
.ss-list code { font-family: monospace; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; }
.ss-actions { display: flex; justify-content: flex-end; gap: 12px; }
.ss-btn {
  padding: 10px 16px; border-radius: 6px;
  border: 1px solid var(--color-border, #525252);
  background: var(--color-background, #161616);
  color: var(--color-text-primary, #f4f4f4);
  font-size: 14px; font-weight: 500; cursor: pointer;
  &:disabled { opacity: 0.4; cursor: default; }
  &.primary { background: var(--color-accent-custom, #DA1E28); border-color: transparent; color: #fff; }
  &.ghost { background: transparent; border-color: transparent; color: var(--color-text-secondary, #c6c6c6); }
}
</style>
