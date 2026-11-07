// =====================================================================
// useSheetSync.ts
// ---------------------------------------------------------------------
// Google Sheets Push/Pull for the cue list (metadata only — never media,
// trim points, waveforms, or anything the sheet can't safely own).
//
// Push: flatten the current item tree to rows and overwrite the sheet.
// Pull: read the sheet, build a diff against the current project, and
//       hand that diff back for confirmation — nothing is applied until
//       the caller calls applyDiff(). Deletions are NEVER applied from a
//       Pull: a row missing from the sheet is reported so you can delete
//       the cue in the app yourself if that's what you meant, which keeps
//       a reordering or bulk-edit pull from being able to silently remove
//       a cue it never actually touched.
//
// Structure (Scene/Block/Cue nesting) comes from the sheet's Level column
// on Pull, since reordering rows is a first-class use of this feature.
// Everything the sheet doesn't carry (media path, trim, fades, waveform,
// ducking, custom actions...) is preserved by patching matched items in
// place rather than rebuilding them from scratch.
// =====================================================================
import { v4 as uuidv4 } from 'uuid';
import type { AudioItem, GroupItem, ActionItem, BaseItem } from '~/types/project';
import { DEFAULT_GROUP_ITEM } from '~/types/project';

export const SHEET_COLUMNS = [
  'UUID', 'Level', 'Type', 'Name', 'Colour', 'Page',
  'Start Behaviour', 'Start Target',
  'End Behaviour',
  'Cue Advance', 'Cue Advance Target',
  'Bus', 'Volume', 'Media File', 'Duration', 'Notes',
  'Lighting Cuelist', 'Lighting Channel',
] as const;

const COL = Object.fromEntries(SHEET_COLUMNS.map((c, i) => [c, i])) as Record<typeof SHEET_COLUMNS[number], number>;

// The only action vocabularies a sheet cell may contain. Kept literal to the
// data model's own action ids (rather than invented friendly phrases) so
// there is exactly one spelling to validate against and no risk of a
// translation layer silently mapping the wrong thing on the way back in.
const START_ACTIONS = ['nothing', 'play-next', 'play-item'] as const;
// 'next'/'goto-item' retired from End Behaviour — see Cue Advance below,
// which replaced them as how a cue's head/play-next-on-end is configured.
const END_ACTIONS = ['nothing', 'loop'] as const;
const GROUP_START_ACTIONS = ['play-first', 'play-all'] as const;
const CUE_ADVANCE_ACTIONS = ['no-action', 'start-advance', 'start-play', 'end-advance', 'end-play'] as const;

export interface SheetRowError {
  rowNumber: number; // 1-based, matching the sheet (header = row 1)
  message: string;
}

export interface FieldChange {
  uuid: string;
  name: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface SheetDiff {
  /** New items to create (groups always; audio only when Media File matched an existing file). */
  adds: Array<{ rowNumber: number; type: 'Scene' | 'Block' | 'Cue' | 'Lighting'; name: string }>;
  /** Items present in the project but missing from the sheet — reported, never auto-deleted. */
  missingFromSheet: Array<{ uuid: string; name: string }>;
  /** Field-level changes on matched items. */
  changes: FieldChange[];
  /** Whether the new tree order/nesting differs from the current one. */
  reordered: boolean;
  /** Rows that couldn't be applied at all (bad action value, ambiguous target name, unmatched media file...). */
  errors: SheetRowError[];
  /** Built, ready-to-apply tree — only ever applied by applyDiff() after confirmation. May
   *  also contain ActionItem rows (Lighting cues), kept out of this union deliberately —
   *  see project.ts — so this is typed loosely rather than widening that structural union. */
  _tree: any[];
}

function busNameToId(buses: { id: string; name: string }[], name: string): string | undefined {
  if (!name) return undefined;
  const bus = buses.find(b => b.name === name);
  return bus?.id;
}
function busIdToName(buses: { id: string; name: string }[], id: string | undefined): string {
  if (!id) return '';
  return buses.find(b => b.id === id)?.name ?? '';
}

export function useSheetSync() {
  const { t } = useLocalization();
  const { currentProject, findItemByUuid, beginItemBatch, endItemBatch, getAllItemsFlat, updateIndices, saveProject } = useProject();
  const server = useLiveplayServer();

  const electronApi: any = (globalThis as any).electronAPI?.sheetsSync;
  const hasElectron = !!electronApi;

  const syncing = ref(false);
  const lastError = ref<string | null>(null);

  // ---- Config (spreadsheetId/sheetName travel with the project; the key
  // path is a machine setting read straight from Electron) -----------------
  const credentialStatus = ref<{ configured: boolean; email: string | null }>({ configured: false, email: null });

  async function refreshCredentialStatus() {
    if (!hasElectron) return;
    const cfg = await electronApi.getConfig();
    credentialStatus.value = { configured: !!cfg.serviceAccountKeyPath, email: cfg.serviceAccountEmail ?? null };
  }

  // ---- Flatten: project tree -> sheet rows --------------------------------
  function flattenToRows(): string[][] {
    const buses = server.buses as { id: string; name: string }[];
    const midiMap = ((currentProject.value as any)?.settings?.midiCuelistMap ?? []) as Array<{ note: number; label: string }>;
    const labelForNote = (note: number) => midiMap.find(r => r.note === note)?.label ?? '';
    const rows: string[][] = [];

    // Typed loosely here (not AudioItem | GroupItem) so an ActionItem — a
    // third, intentionally-kept-narrow item type (see project.ts) — flows
    // through this walk without widening the core structural unions.
    const typeFor = (item: any, level: number): 'Scene' | 'Block' | 'Cue' | 'Lighting' =>
      item.type === 'group' ? (level === 0 ? 'Scene' : 'Block') : item.type === 'action' ? 'Lighting' : 'Cue';

    const walk = (items: any[], level: number) => {
      for (const item of items) {
        const row = new Array(SHEET_COLUMNS.length).fill('');
        row[COL['UUID']] = item.uuid;
        row[COL['Level']] = String(level);
        row[COL['Type']] = typeFor(item, level);
        row[COL['Name']] = item.displayName ?? '';
        row[COL['Colour']] = item.color ?? '';
        row[COL['Page']] = item.pageNumber ?? '';
        row[COL['Notes']] = item.notes ?? '';

        if (item.type === 'group') {
          row[COL['Start Behaviour']] = item.startBehavior?.action ?? 'play-first';
          row[COL['End Behaviour']] = item.endBehavior?.action ?? 'nothing';
        } else if (item.type === 'action') {
          const action = item as ActionItem;
          row[COL['Cue Advance']] = action.cueAdvance?.action ?? 'no-action';
          if (action.cueAdvance?.targetUuid) {
            row[COL['Cue Advance Target']] = findItemByUuid(action.cueAdvance.targetUuid)?.displayName ?? '';
          }
          row[COL['Lighting Cuelist']] = labelForNote(action.midiTrigger?.goNote);
          row[COL['Lighting Channel']] = String(action.midiTrigger?.channel ?? 1);
        } else {
          const audio = item as AudioItem;
          row[COL['Start Behaviour']] = audio.startBehavior?.action ?? 'nothing';
          if (audio.startBehavior?.action === 'play-item' && audio.startBehavior.targetUuid) {
            row[COL['Start Target']] = findItemByUuid(audio.startBehavior.targetUuid)?.displayName ?? '';
          }
          row[COL['End Behaviour']] = audio.endBehavior?.action === 'loop' ? 'loop' : 'nothing';
          row[COL['Cue Advance']] = audio.cueAdvance?.action ?? 'start-advance';
          if (audio.cueAdvance?.targetUuid) {
            row[COL['Cue Advance Target']] = findItemByUuid(audio.cueAdvance.targetUuid)?.displayName ?? '';
          }
          row[COL['Bus']] = busIdToName(buses, audio.busId);
          row[COL['Volume']] = String(audio.volume ?? 1);
          row[COL['Media File']] = audio.mediaFileName ?? '';
          row[COL['Duration']] = audio.duration ? audio.duration.toFixed(2) : '';
        }
        rows.push(row);

        if (item.type === 'group') walk((item as GroupItem).children ?? [], level + 1);
      }
    };

    walk((currentProject.value?.items ?? []) as any[], 0);
    return rows;
  }

  async function push(): Promise<{ ok: boolean; error?: string }> {
    if (!hasElectron) return { ok: false, error: t('sheetSync.notAvailable') };
    const settings = (currentProject.value as any)?.settings ?? {};
    const spreadsheetId = settings.sheetsSyncSpreadsheetId;
    const sheetName = settings.sheetsSyncSheetName || 'Cues';
    if (!spreadsheetId) return { ok: false, error: t('sheetSync.noSpreadsheet') };

    syncing.value = true;
    lastError.value = null;
    try {
      const rows = flattenToRows();
      await electronApi.push({ spreadsheetId, sheetName, header: [...SHEET_COLUMNS], rows });
      markSynced();
      return { ok: true };
    } catch (e: any) {
      lastError.value = String(e?.message ?? e);
      return { ok: false, error: lastError.value };
    } finally {
      syncing.value = false;
    }
  }

  function markSynced() {
    const p = currentProject.value as any;
    if (!p) return;
    p.settings = { ...(p.settings ?? {}), sheetsSyncLastSync: new Date().toISOString() };
    void saveProject({ force: true });
  }

  // ---- Pull: sheet rows -> diff -------------------------------------------
  interface ParsedRow {
    rowNumber: number;
    uuid: string;
    level: number;
    type: string;
    name: string;
    colour: string;
    page: string;
    startAction: string;
    startTarget: string;
    endAction: string;
    cueAdvanceAction: string;
    cueAdvanceTarget: string;
    busName: string;
    volume: string;
    mediaFile: string;
    notes: string;
    lightingCuelist: string;
    lightingChannel: string;
  }

  function parseRows(header: string[], rawRows: string[][]): { parsed: ParsedRow[]; errors: SheetRowError[] } {
    const errors: SheetRowError[] = [];
    // Column order in the sheet may not exactly match SHEET_COLUMNS (someone
    // may have reordered columns, which spreadsheets make trivially easy) —
    // resolve by header name, not position, and complain once if a required
    // header is simply missing.
    const idx = (col: string) => header.indexOf(col);
    const required = ['UUID', 'Level', 'Type', 'Name'];
    for (const col of required) {
      if (idx(col) === -1) errors.push({ rowNumber: 1, message: t('sheetSync.errorMissingColumn', { column: col }) });
    }
    if (errors.length) return { parsed: [], errors };

    const get = (row: string[], col: string) => {
      const i = idx(col);
      return i === -1 || i >= row.length ? '' : (row[i] ?? '').trim();
    };

    const parsed: ParsedRow[] = rawRows.map((row, i) => {
      const rowNumber = i + 2; // header is row 1
      const uuid = get(row, 'UUID');
      const levelRaw = get(row, 'Level');
      const level = levelRaw === '' ? 0 : Number(levelRaw);
      if (Number.isNaN(level)) errors.push({ rowNumber, message: t('sheetSync.errorBadLevel') });
      return {
        rowNumber,
        uuid,
        level: Number.isNaN(level) ? 0 : level,
        type: get(row, 'Type'),
        name: get(row, 'Name'),
        colour: get(row, 'Colour'),
        page: get(row, 'Page'),
        startAction: get(row, 'Start Behaviour'),
        startTarget: get(row, 'Start Target'),
        endAction: get(row, 'End Behaviour'),
        cueAdvanceAction: get(row, 'Cue Advance'),
        cueAdvanceTarget: get(row, 'Cue Advance Target'),
        busName: get(row, 'Bus'),
        volume: get(row, 'Volume'),
        mediaFile: get(row, 'Media File'),
        notes: get(row, 'Notes'),
        lightingCuelist: get(row, 'Lighting Cuelist'),
        lightingChannel: get(row, 'Lighting Channel'),
      };
    });
    return { parsed, errors };
  }

  /** Build a diff (and the tree it would apply) from sheet rows. Applies nothing. */
  function buildDiff(header: string[], rawRows: string[][]): SheetDiff {
    const buses = server.buses as { id: string; name: string }[];
    const { parsed, errors } = parseRows(header, rawRows);

    const existingByUuid = new Map<string, AudioItem | GroupItem>();
    for (const it of getAllItemsFlat() as (AudioItem | GroupItem)[]) existingByUuid.set(it.uuid, it);

    // Name -> uuid, for resolving Start/End Target columns. Ambiguous names
    // (two cues sharing a display name) can't be resolved safely — flagged
    // per affected row rather than guessing.
    const nameCounts = new Map<string, number>();
    for (const it of getAllItemsFlat()) nameCounts.set(it.displayName, (nameCounts.get(it.displayName) ?? 0) + 1);
    const resolveTargetUuid = (name: string, rowNumber: number): string | undefined => {
      if (!name) return undefined;
      if ((nameCounts.get(name) ?? 0) > 1) {
        errors.push({ rowNumber, message: t('sheetSync.errorAmbiguousTarget', { name }) });
        return undefined;
      }
      const match = (getAllItemsFlat() as BaseItem[]).find(it => it.displayName === name);
      if (!match) {
        errors.push({ rowNumber, message: t('sheetSync.errorUnknownTarget', { name }) });
        return undefined;
      }
      return match.uuid;
    };

    // Media-file lookup for brand-new audio rows (no UUID): can only ever
    // reference a file already used by SOME existing cue in this project —
    // the sheet cannot introduce new audio.
    const itemByMediaFile = new Map<string, AudioItem>();
    for (const it of getAllItemsFlat() as any[]) {
      if (it.type === 'audio' && it.mediaFileName) itemByMediaFile.set(it.mediaFileName, it as AudioItem);
    }

    // Lighting cuelist dictionary (note <-> label), project-scoped.
    const midiMap = ((currentProject.value as any)?.settings?.midiCuelistMap ?? []) as Array<{ note: number; label: string }>;
    const resolveMidiNote = (label: string, rowNumber: number): number | undefined => {
      if (!label) return undefined;
      const row = midiMap.find(r => r.label === label);
      if (!row) {
        errors.push({ rowNumber, message: t('sheetSync.errorUnknownCuelist', { name: label }) });
        return undefined;
      }
      return row.note;
    };

    const adds: SheetDiff['adds'] = [];
    const changes: FieldChange[] = [];

    // Build the new tree by walking rows in order, using Level to nest.
    // A stack of open containers' children arrays, indexed by level. Typed
    // loosely (not AudioItem | GroupItem) so a Lighting row's ActionItem —
    // kept deliberately out of those structural unions, see project.ts —
    // can flow through without widening them.
    const rootChildren: any[] = [];
    const stack: any[][] = [rootChildren];

    for (const row of parsed) {
      if (row.level < 0 || row.level > stack.length) {
        errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadNesting', { name: row.name }) });
        continue;
      }
      // Trim the stack back to this row's level (a dedent), then this row
      // becomes the new top if it's a container.
      stack.length = row.level + 1;
      const parentChildren = stack[row.level];

      const isGroup = row.type === 'Scene' || row.type === 'Block';
      const isLighting = row.type === 'Lighting';
      let item: any = row.uuid ? existingByUuid.get(row.uuid) : undefined;

      if (row.uuid && !item) {
        errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorUnknownUuid', { name: row.name }) });
        continue;
      }

      if (!row.uuid) {
        // New row.
        if (isGroup) {
          item = {
            ...(DEFAULT_GROUP_ITEM as GroupItem),
            uuid: uuidv4(),
            index: [],
            displayName: row.name || t('sheetSync.untitledGroup'),
            color: row.colour || (DEFAULT_GROUP_ITEM.color as string),
            type: 'group',
            children: [],
          } as GroupItem;
          adds.push({ rowNumber: row.rowNumber, type: row.type as any, name: item.displayName });
        } else if (isLighting) {
          const goNote = resolveMidiNote(row.lightingCuelist, row.rowNumber);
          if (goNote === undefined) continue;
          const channel = row.lightingChannel ? Number(row.lightingChannel) || 1 : 1;
          item = {
            uuid: uuidv4(),
            index: [],
            type: 'action',
            kind: 'midi-trigger',
            displayName: row.name || t('sheetSync.untitledLighting'),
            color: row.colour || '#DA1E28',
            midiTrigger: { channel, goNote },
          } as ActionItem;
          adds.push({ rowNumber: row.rowNumber, type: 'Lighting', name: item.displayName });
        } else {
          const source = itemByMediaFile.get(row.mediaFile);
          if (!row.mediaFile || !source) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorUnmatchedMedia', { name: row.name || row.mediaFile }) });
            continue;
          }
          item = { ...source, uuid: uuidv4(), index: [], displayName: row.name || source.displayName } as AudioItem;
          adds.push({ rowNumber: row.rowNumber, type: 'Cue', name: item.displayName });
        }
      } else {
        // Existing row — clone so we can patch without mutating the live
        // project until the caller actually applies the diff.
        item = JSON.parse(JSON.stringify(item));
      }

      // ---- Field patches (both new and existing items go through this,
      // so a new row's own values are validated the same way). ----
      const record = (field: string, from: unknown, to: unknown) => {
        if (from !== to) changes.push({ uuid: item!.uuid, name: row.name || item!.displayName, field, from, to });
      };
      if (row.name && row.name !== item!.displayName) { record('displayName', item!.displayName, row.name); item!.displayName = row.name; }
      if (row.colour && row.colour !== item!.color) { record('color', item!.color, row.colour); item!.color = row.colour; }
      if (row.page && row.page !== (item!.pageNumber ?? '')) { record('pageNumber', item!.pageNumber, row.page); item!.pageNumber = row.page; }
      // Same convention as name/colour/page: an empty Notes cell means "untouched"
      // (a sheet can't distinguish "blank on purpose" from "never filled in"),
      // not "clear the note" — clearing stays a Properties-panel action.
      if (row.notes && row.notes !== (item!.notes ?? '')) { record('notes', item!.notes, row.notes); item!.notes = row.notes; }

      if (item!.type === 'group') {
        const g = item as GroupItem;
        if (row.startAction) {
          if (!GROUP_START_ACTIONS.includes(row.startAction as any)) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadStartAction', { value: row.startAction }) });
          } else if (row.startAction !== g.startBehavior?.action) {
            record('startBehavior', g.startBehavior?.action, row.startAction);
            g.startBehavior = { action: row.startAction as any };
          }
        }
        if (row.endAction) {
          if (row.endAction !== 'nothing' && row.endAction !== 'loop') {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadEndActionGroup', { value: row.endAction }) });
          } else if (row.endAction !== g.endBehavior?.action) {
            record('endBehavior', g.endBehavior?.action, row.endAction);
            g.endBehavior = { action: row.endAction as any };
          }
        }
      } else if (item!.type === 'action') {
        const act = item as ActionItem;
        if (row.cueAdvanceAction) {
          if (!CUE_ADVANCE_ACTIONS.includes(row.cueAdvanceAction as any)) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadCueAdvance', { value: row.cueAdvanceAction }) });
          } else {
            const targetUuid = row.cueAdvanceAction !== 'no-action'
              ? resolveTargetUuid(row.cueAdvanceTarget, row.rowNumber) : undefined;
            if (row.cueAdvanceAction !== act.cueAdvance?.action || targetUuid !== act.cueAdvance?.targetUuid) {
              record('cueAdvance', act.cueAdvance?.action, row.cueAdvanceAction);
              act.cueAdvance = { action: row.cueAdvanceAction as any, ...(targetUuid ? { targetUuid } : {}) };
            }
          }
        }
        if (row.lightingCuelist) {
          const goNote = resolveMidiNote(row.lightingCuelist, row.rowNumber);
          if (goNote !== undefined && goNote !== act.midiTrigger?.goNote) {
            record('midiTrigger.goNote', act.midiTrigger?.goNote, goNote);
            act.midiTrigger = { ...act.midiTrigger, goNote };
          }
        }
        if (row.lightingChannel) {
          const channel = Number(row.lightingChannel) || 1;
          if (channel !== act.midiTrigger?.channel) {
            record('midiTrigger.channel', act.midiTrigger?.channel, channel);
            act.midiTrigger = { ...act.midiTrigger, channel };
          }
        }
      } else {
        const a = item as AudioItem;
        if (row.startAction) {
          if (!START_ACTIONS.includes(row.startAction as any)) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadStartAction', { value: row.startAction }) });
          } else {
            const targetUuid = row.startAction === 'play-item' ? resolveTargetUuid(row.startTarget, row.rowNumber) : undefined;
            if (row.startAction !== a.startBehavior?.action || targetUuid !== a.startBehavior?.targetUuid) {
              record('startBehavior', a.startBehavior?.action, row.startAction);
              a.startBehavior = { action: row.startAction as any, ...(targetUuid ? { targetUuid } : {}) };
            }
          }
        }
        if (row.endAction) {
          if (!END_ACTIONS.includes(row.endAction as any)) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadEndAction', { value: row.endAction }) });
          } else if (row.endAction !== a.endBehavior?.action) {
            record('endBehavior', a.endBehavior?.action, row.endAction);
            a.endBehavior = { action: row.endAction as any };
          }
        }
        if (row.cueAdvanceAction) {
          if (!CUE_ADVANCE_ACTIONS.includes(row.cueAdvanceAction as any)) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadCueAdvance', { value: row.cueAdvanceAction }) });
          } else {
            const targetUuid = row.cueAdvanceAction !== 'no-action'
              ? resolveTargetUuid(row.cueAdvanceTarget, row.rowNumber) : undefined;
            if (row.cueAdvanceAction !== a.cueAdvance?.action || targetUuid !== a.cueAdvance?.targetUuid) {
              record('cueAdvance', a.cueAdvance?.action, row.cueAdvanceAction);
              a.cueAdvance = { action: row.cueAdvanceAction as any, ...(targetUuid ? { targetUuid } : {}) };
            }
          }
        }
        if (row.busName) {
          const busId = busNameToId(buses, row.busName);
          if (!busId) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorUnknownBus', { name: row.busName }) });
          } else if (busId !== a.busId) {
            record('busId', a.busId, busId);
            a.busId = busId;
          }
        }
        if (row.volume !== '') {
          const vol = Number(row.volume);
          if (Number.isNaN(vol) || vol < 0 || vol > 2) {
            errors.push({ rowNumber: row.rowNumber, message: t('sheetSync.errorBadVolume', { value: row.volume }) });
          } else if (vol !== a.volume) {
            record('volume', a.volume, vol);
            a.volume = vol;
          }
        }
      }

      parentChildren.push(item!);
      if (item!.type === 'group') {
        // The tree is rebuilt entirely from the sheet's rows, so a matched
        // existing group's cloned (and possibly still-populated) children
        // array must not be reused as-is — otherwise nested rows get pushed
        // alongside its stale old children instead of replacing them.
        (item as GroupItem).children = [];
        stack.push((item as GroupItem).children);
      }
    }

    const missingFromSheet = (getAllItemsFlat() as BaseItem[])
      .filter(it => parsed.every(r => r.uuid !== it.uuid))
      .map(it => ({ uuid: it.uuid, name: it.displayName }));

    const reordered = JSON.stringify(indexSignature(currentProject.value?.items ?? []))
                    !== JSON.stringify(indexSignature(rootChildren));

    return { adds, missingFromSheet, changes, reordered, errors, _tree: rootChildren };
  }

  function indexSignature(items: (AudioItem | GroupItem)[]): any[] {
    return items.map(it => [it.uuid, it.type === 'group' ? indexSignature((it as GroupItem).children) : null]);
  }

  async function pull(): Promise<{ ok: boolean; diff?: SheetDiff; error?: string }> {
    if (!hasElectron) return { ok: false, error: t('sheetSync.notAvailable') };
    const settings = (currentProject.value as any)?.settings ?? {};
    const spreadsheetId = settings.sheetsSyncSpreadsheetId;
    const sheetName = settings.sheetsSyncSheetName || 'Cues';
    if (!spreadsheetId) return { ok: false, error: t('sheetSync.noSpreadsheet') };

    syncing.value = true;
    lastError.value = null;
    try {
      const { header, rows } = await electronApi.pull({ spreadsheetId, sheetName });
      const diff = buildDiff(header, rows);
      return { ok: true, diff };
    } catch (e: any) {
      lastError.value = String(e?.message ?? e);
      return { ok: false, error: lastError.value };
    } finally {
      syncing.value = false;
    }
  }

  /** Apply a diff built by pull(). Only ever called after the caller confirms it. */
  function applyDiff(diff: SheetDiff) {
    if (!currentProject.value) return;
    beginItemBatch();
    try {
      updateIndices(diff._tree);
      currentProject.value.items = diff._tree;
      markSynced();
    } finally {
      endItemBatch();
    }
  }

  return {
    hasElectron,
    syncing,
    lastError,
    credentialStatus,
    refreshCredentialStatus,
    push,
    pull,
    applyDiff,
    flattenToRows,
  };
}
