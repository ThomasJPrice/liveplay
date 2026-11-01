<template>
  <div class="settings-pane">
    <h3 class="settings-pane-title">{{ t('settings.sectionProject') }}</h3>
    <p class="settings-pane-intro">{{ t('settings.sectionProjectHelp') }}</p>

    <!-- Autosave also has a header toggle, deliberately: it is flipped often
         enough mid-session to deserve one, and this is where someone looks for
         it when they do not know that. Both drive the same project value. -->
    <section class="settings-field">
      <label class="settings-label settings-label--checkbox">
        <input
          type="checkbox"
          :checked="autoSaveEnabled"
          :disabled="!currentProject"
          @change="onAutoSaveChange"
        />
        {{ t('project.autosave') }}
      </label>
      <p class="settings-help">{{ t('settings.autosaveHelp') }}</p>
    </section>

    <!-- Cue numbering is shared vocabulary between the operator, the stage
         manager and the paper script, so it belongs to the project rather than
         to whoever is sitting at the machine. Display only: stored indices and
         the REST by-index paths stay zero-based. -->
    <section class="settings-field">
      <label class="settings-label">
        <span class="material-symbols-rounded">format_list_numbered</span>
        {{ t('settings.indexDisplayStart') }}
      </label>
      <input
        class="settings-input"
        type="number"
        min="0"
        step="1"
        :value="indexDisplayStart"
        @change="onIndexDisplayStartChange"
      />
      <p class="settings-help">{{ t('settings.indexDisplayStartHelp') }}</p>
    </section>

    <!-- "Scroll to the playing cue" is not here any more: it is a preference of
         whoever is reading the playlist, not a property of the show, so it
         moved to the Appearance pane with the rest of them (U4). -->

    <!-- ================================================================
         Google Sheets cue-list sync (Push/Pull). Which spreadsheet/tab is
         the show's own setting; the service-account credential is this
         machine's and lives in Electron's config, not the project.
         ================================================================ -->
    <h4 class="settings-group-title">{{ t('sheetSync.title') }}</h4>
    <p class="settings-pane-intro">{{ t('sheetSync.intro') }}</p>

    <section v-if="!sheetSync.hasElectron" class="settings-field">
      <p class="settings-help settings-help--warn">{{ t('sheetSync.notAvailable') }}</p>
    </section>

    <template v-else>
      <section class="settings-field">
        <label class="settings-label">
          <span class="material-symbols-rounded">key</span>
          {{ t('sheetSync.credential') }}
        </label>
        <p class="settings-help">
          <span v-if="sheetSync.credentialStatus.value.configured">
            {{ t('sheetSync.credentialConfigured', { email: sheetSync.credentialStatus.value.email || '' }) }}
          </span>
          <span v-else>{{ t('sheetSync.credentialNotConfigured') }}</span>
        </p>
        <div class="settings-actions">
          <button class="settings-btn" @click="pickKeyFile">{{ t('sheetSync.chooseKeyFile') }}</button>
        </div>
      </section>

      <section class="settings-field">
        <label class="settings-label">
          <span class="material-symbols-rounded">table_chart</span>
          {{ t('sheetSync.spreadsheetId') }}
        </label>
        <input
          class="settings-input"
          type="text"
          :placeholder="t('sheetSync.spreadsheetIdPlaceholder')"
          :value="settings.sheetsSyncSpreadsheetId || ''"
          @change="onSpreadsheetIdChange"
        />
        <p class="settings-help">{{ t('sheetSync.spreadsheetIdHelp') }}</p>

        <label class="settings-label" style="margin-top: 0.75rem;">{{ t('sheetSync.sheetName') }}</label>
        <input
          class="settings-input"
          type="text"
          placeholder="Cues"
          :value="settings.sheetsSyncSheetName || ''"
          @change="onSheetNameChange"
        />
      </section>

      <section class="settings-field">
        <p v-if="settings.sheetsSyncLastSync" class="settings-help">
          {{ t('sheetSync.lastSync', { when: formatLastSync(settings.sheetsSyncLastSync) }) }}
        </p>
        <p v-if="sheetSync.lastError.value" class="settings-help settings-help--warn">
          {{ sheetSync.lastError.value }}
        </p>
        <div class="settings-actions">
          <button
            class="settings-btn settings-btn--primary"
            :disabled="sheetSync.syncing.value || !settings.sheetsSyncSpreadsheetId"
            @click="onPush"
          >{{ sheetSync.syncing.value ? t('sheetSync.syncing') : t('sheetSync.push') }}</button>
          <button
            class="settings-btn"
            :disabled="sheetSync.syncing.value || !settings.sheetsSyncSpreadsheetId"
            @click="onPull"
          >{{ sheetSync.syncing.value ? t('sheetSync.syncing') : t('sheetSync.pull') }}</button>
        </div>
      </section>
    </template>
  </div>

  <SheetSyncDiffDialog
    :diff="pendingDiff"
    @confirm="confirmPull"
    @cancel="pendingDiff = null"
  />
</template>

<script setup lang="ts">
import { normalizeIndexDisplayStart } from '~/utils/indexDisplay';
import { useProjectSettings } from '~/composables/useProjectSettings';
import { useSheetSync, type SheetDiff } from '~/composables/useSheetSync';
import SheetSyncDiffDialog from './SheetSyncDiffDialog.vue';

const { t } = useLocalization();
const { settings, applyPatch } = useProjectSettings();
const { currentProject, autoSaveEnabled, setAutoSave } = useProject();
const sheetSync = useSheetSync();

const indexDisplayStart = computed(() => normalizeIndexDisplayStart(settings.value.indexDisplayStart));

function onAutoSaveChange(e: Event) {
  setAutoSave((e.target as HTMLInputElement).checked);
}
function onIndexDisplayStartChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const value = normalizeIndexDisplayStart(input.value);
  input.value = String(value);
  applyPatch({ indexDisplayStart: value });
}

// ---- Google Sheets sync ------------------------------------------------
onMounted(() => { void sheetSync.refreshCredentialStatus(); });

async function pickKeyFile() {
  const electronApi: any = (globalThis as any).electronAPI?.sheetsSync;
  if (!electronApi) return;
  const path = await electronApi.selectKeyFile();
  if (!path) return;
  await electronApi.setConfig({ serviceAccountKeyPath: path });
  await sheetSync.refreshCredentialStatus();
}

function onSpreadsheetIdChange(e: Event) {
  applyPatch({ sheetsSyncSpreadsheetId: (e.target as HTMLInputElement).value.trim() || null });
}
function onSheetNameChange(e: Event) {
  applyPatch({ sheetsSyncSheetName: (e.target as HTMLInputElement).value.trim() || null });
}
function formatLastSync(iso: string): string {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

async function onPush() {
  const res = await sheetSync.push();
  if (!res.ok) sheetSync.lastError.value = res.error || t('sheetSync.pushFailed');
}

const pendingDiff = ref<SheetDiff | null>(null);
async function onPull() {
  const res = await sheetSync.pull();
  if (!res.ok) { sheetSync.lastError.value = res.error || t('sheetSync.pullFailed'); return; }
  pendingDiff.value = res.diff || null;
}
function confirmPull() {
  if (!pendingDiff.value) return;
  sheetSync.applyDiff(pendingDiff.value);
  pendingDiff.value = null;
}
</script>

<style lang="scss" scoped>
// The shared `.settings-*` field/label/input classes reach here through
// SettingsPage.vue's :deep() rules; these few (group heading, buttons, the
// warn variant of .settings-help) aren't part of that shared set and are
// styled the same way SettingsPaneServer.vue defines its own copy.
.settings-group-title {
  margin: 32px 0 4px;
  font-size: 15px;
  font-weight: 600;
  padding-top: 20px;
  border-top: 1px solid var(--color-border, #333);
}
.settings-help--warn { color: #ffc400; }
.settings-btn {
  padding: 6px 14px;
  border-radius: 4px;
  border: 1px solid var(--color-border, #444);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  &:disabled { opacity: 0.45; cursor: default; }
  &--primary {
    background: var(--color-accent-custom, #DA1E28);
    border-color: transparent;
    color: #fff;
  }
}
</style>
