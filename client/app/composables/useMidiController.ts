import type { AudioItem } from '~/types/project';

// MIDI binding: identifies a specific control on a MIDI device
export interface MidiBinding {
  channel: number;   // 0-15
  type: 'note' | 'cc' | 'pitchbend';
  number: number;    // note number, CC number (0-127), or 0 for pitchbend
}

// Available action IDs
export type MidiActionId =
  | 'trigger-slot-0' | 'trigger-slot-1' | 'trigger-slot-2' | 'trigger-slot-3'
  | 'trigger-slot-4' | 'trigger-slot-5' | 'trigger-slot-6' | 'trigger-slot-7'
  | 'trigger-slot-8' | 'trigger-slot-9' | 'trigger-slot-10' | 'trigger-slot-11'
  | 'trigger-slot-12' | 'trigger-slot-13' | 'trigger-slot-14' | 'trigger-slot-15'
  | 'pause-resume' | 'toggle-loop' | 'cue-to-continue' | 'jump-cue' | 'stop-all' | 'master-volume'
  | 'select-up' | 'select-down' | 'play-selected' | 'play-next';

// Config stored in midi-config.json
export interface MidiConfig {
  bindings: Record<string, MidiBinding>; // actionId → binding
  preferredDevice?: string;              // preferred MIDI input device name
  preferredOutputDevice?: string;        // preferred MIDI output device name — lighting cues
  masterVolumeMultiplier?: number;       // dB applied per master-volume MIDI step (default 1)
}

// Default dB step applied per master-volume MIDI message (before multiplier).
export const DEFAULT_MASTER_VOLUME_MULTIPLIER = 1;

// All available actions with display metadata
export const MIDI_ACTIONS: { id: MidiActionId; labelKey: string; category: string; continuous: boolean; n?: number }[] = [
  // Cart slots
  ...Array.from({ length: 16 }, (_, i) => ({
    id: `trigger-slot-${i}` as MidiActionId,
    labelKey: 'controls.cartSlot',
    category: 'Cart Slots',
    continuous: false,
    n: i + 1,
  })),
  // Playback
  { id: 'pause-resume',  labelKey: 'controls.pauseResume',  category: 'Playback', continuous: false },
  { id: 'toggle-loop',   labelKey: 'controls.toggleLoop',   category: 'Playback', continuous: false },
  { id: 'cue-to-continue', labelKey: 'controls.cueToContinue', category: 'Playback', continuous: false },
  { id: 'jump-cue',      labelKey: 'controls.jumpCue',      category: 'Playback', continuous: false },
  { id: 'stop-all',      labelKey: 'controls.stopAll',      category: 'Playback', continuous: false },
  { id: 'select-up',     labelKey: 'controls.selectUp',     category: 'Playback', continuous: false },
  { id: 'select-down',   labelKey: 'controls.selectDown',   category: 'Playback', continuous: false },
  { id: 'play-selected', labelKey: 'controls.playSelected', category: 'Playback', continuous: false },
  { id: 'play-next',     labelKey: 'controls.playNext',     category: 'Playback', continuous: false },
  // Volume
  { id: 'master-volume', labelKey: 'controls.masterVolume', category: 'Volume',   continuous: true  },
];

/**
 * Format a MIDI binding for display (e.g., "Ch1 Note 36", "Ch1 CC 9").
 */
export const formatMidiBinding = (binding: MidiBinding): string => {
  const ch = `Ch${binding.channel + 1}`;
  if (binding.type === 'pitchbend') return `${ch} Fader`;
  const type = binding.type === 'note' ? 'Note' : 'CC';
  return `${ch} ${type} ${binding.number}`;
};

/**
 * Check if two MIDI bindings match.
 */
const bindingsMatch = (a: MidiBinding, b: MidiBinding): boolean => {
  return a.channel === b.channel && a.type === b.type && a.number === b.number;
};

/**
 * Parse a raw MIDI message into channel, type, number, value.
 */
const parseMidiMessage = (data: Uint8Array): { channel: number; type: 'note' | 'cc' | 'pitchbend' | 'other'; number: number; value: number } | null => {
  if (data.length < 2) return null;
  const status = data[0];
  const channel = status & 0x0F;
  const messageType = status & 0xF0;

  if (data.length >= 3 && messageType === 0x90 && data[2] > 0) {
    // Note On (velocity > 0)
    return { channel, type: 'note', number: data[1], value: data[2] };
  }
  if (data.length >= 3 && (messageType === 0x80 || (messageType === 0x90 && data[2] === 0))) {
    // Note Off
    return { channel, type: 'note', number: data[1], value: 0 };
  }
  if (data.length >= 3 && messageType === 0xB0) {
    // Control Change
    return { channel, type: 'cc', number: data[1], value: data[2] };
  }
  if (data.length >= 3 && messageType === 0xE0) {
    // Pitchbend: 14-bit value from two 7-bit bytes, scaled to 0-127
    const raw14 = data[1] | (data[2] << 7); // 0-16383
    const value = Math.round(raw14 / 128); // scale to 0-127
    return { channel, type: 'pitchbend', number: 0, value };
  }
  return null;
};

// Shared singleton state (module-level so all useMidiController() calls share it)
const config = ref<MidiConfig>({ bindings: {} });
const midiAccess = ref<MIDIAccess | null>(null);
const connectedDevices = ref<string[]>([]);
const connectedOutputDevices = ref<string[]>([]);
const learning = ref<MidiActionId | null>(null);
const lastMidiMessage = ref<MidiBinding | null>(null);
let onLearnCapture: ((binding: MidiBinding) => void) | null = null;
let mounted = false;
// Last raw master-volume value seen, used to derive movement direction.
let lastMasterVolumeRaw: number | null = null;

const preferredDevice = computed(() => config.value.preferredDevice ?? null);
const preferredOutputDevice = computed(() => config.value.preferredOutputDevice ?? null);

export const useMidiController = () => {
  const { getCartItem } = useCartItems();
  const { playCue, stopCue, pauseCue, resumeCue, stopAllCues, activeCues, setMasterGain, masterGainDb, triggerByUuid, queueLoopContinuation, jumpCue, isItemPlaying, fireItem, stopItemAny } = useAudioEngine();
  const { selectedItem, saveProject } = useProject();
  // The head — see the Head pointer + Cue Advance plan.
  const { selectedItemUuid, selectPrev, selectNext } = useShowControl();

  // Same active-cue-then-selection fallback toggle-loop/pause-resume use
  // above, factored out since cue-to-continue/jump-cue need it too.
  const getLoopTargetItem = (): AudioItem | null => {
    if (activeCues.value.size > 0) {
      const firstUuid = activeCues.value.keys().next().value;
      if (firstUuid) {
        const { findItemByUuid } = useProject();
        const found = findItemByUuid(firstUuid);
        if (found && found.type === 'audio') return found as AudioItem;
        const { getCartOnlyItem } = useCartItems();
        const cartItem = getCartOnlyItem(firstUuid);
        if (cartItem) return cartItem;
      }
    }
    if (selectedItem.value && selectedItem.value.type === 'audio') {
      return selectedItem.value as AudioItem;
    }
    return null;
  };

  /**
   * Dispatch a discrete action.
   */
  const dispatchDiscrete = (actionId: MidiActionId) => {
    if (actionId.startsWith('trigger-slot-')) {
      const slot = parseInt(actionId.replace('trigger-slot-', ''), 10);
      const item = getCartItem(slot);
      if (!item) return;
      if (item.type === 'group') {
        if (isItemPlaying(item)) stopItemAny(item);
        else fireItem(item);
        return;
      }
      if (activeCues.value.has(item.uuid)) {
        const cue = activeCues.value.get(item.uuid);
        if (cue && cue.isPaused) {
          resumeCue(item.uuid);
        } else {
          stopCue(item.uuid);
        }
      } else {
        playCue(item);
      }
      return;
    }

    if (actionId === 'pause-resume') {
      // Same logic as keyboard Space — prefer active cue over selectedItem
      let targetItem: AudioItem | null = null;
      if (activeCues.value.size > 0) {
        const firstUuid = activeCues.value.keys().next().value;
        if (firstUuid) {
          const { findItemByUuid } = useProject();
          const found = findItemByUuid(firstUuid);
          if (found && found.type === 'audio') targetItem = found as AudioItem;
          if (!targetItem) {
            const { getCartOnlyItem } = useCartItems();
            targetItem = getCartOnlyItem(firstUuid);
          }
        }
      }
      if (!targetItem && selectedItem.value && selectedItem.value.type === 'audio') {
        targetItem = selectedItem.value as AudioItem;
      }
      if (!targetItem) return;
      if (activeCues.value.has(targetItem.uuid)) {
        const cue = activeCues.value.get(targetItem.uuid);
        if (cue && cue.isPaused) {
          resumeCue(targetItem.uuid);
        } else {
          pauseCue(targetItem.uuid);
        }
      } else {
        playCue(targetItem);
      }
      return;
    }

    if (actionId === 'toggle-loop') {
      let targetItem: AudioItem | null = null;
      if (activeCues.value.size > 0) {
        const firstUuid = activeCues.value.keys().next().value;
        if (firstUuid) {
          const { findItemByUuid } = useProject();
          const found = findItemByUuid(firstUuid);
          if (found && found.type === 'audio') targetItem = found as AudioItem;
          if (!targetItem) {
            const { getCartOnlyItem } = useCartItems();
            targetItem = getCartOnlyItem(firstUuid);
          }
        }
      }
      if (!targetItem && selectedItem.value && selectedItem.value.type === 'audio') {
        targetItem = selectedItem.value as AudioItem;
      }
      if (!targetItem) return;
      if (targetItem.endBehavior.action === 'loop') {
        targetItem.endBehavior = { action: 'nothing' };
      } else {
        targetItem.endBehavior = { action: 'loop' };
      }
      saveProject();
      return;
    }

    if (actionId === 'cue-to-continue') {
      const item = getLoopTargetItem();
      if (!item) return;
      queueLoopContinuation(item, resolveLoopContinuationTarget(item));
      return;
    }

    if (actionId === 'jump-cue') {
      const item = getLoopTargetItem();
      if (!item) return;
      jumpCue(item);
      return;
    }

    if (actionId === 'stop-all') {
      stopAllCues();
      return;
    }

    // PREV / NEXT: step the server-authoritative head (handles play-first
    // group redirect and empty-cue skip) — not a local array walk.
    if (actionId === 'select-up' || actionId === 'select-down') {
      if (actionId === 'select-up') selectPrev(); else selectNext();
      return;
    }

    // GO, whichever MIDI action fires it: play the head.
    if (actionId === 'play-selected' || actionId === 'play-next') {
      if (!selectedItemUuid.value) return;
      triggerByUuid(selectedItemUuid.value);
      return;
    }
  };

  /**
   * Dispatch a continuous action (CC value 0-127).
   */
  const dispatchContinuous = (actionId: MidiActionId, value: number) => {
    if (actionId === 'master-volume') {
      // Incremental master volume: each MIDI message nudges the gain up or down
      // by `multiplier` dB, derived from the direction of movement vs the last
      // value. This works for both endless wheels (slow ticks) and absolute
      // faders, and lets slow wheels move faster via a larger multiplier.
      if (lastMasterVolumeRaw === null) {
        // First message only establishes a reference point — don't jump.
        lastMasterVolumeRaw = value;
        return;
      }
      const delta = value - lastMasterVolumeRaw;
      lastMasterVolumeRaw = value;
      if (delta === 0) return;
      const multiplier = config.value.masterVolumeMultiplier ?? DEFAULT_MASTER_VOLUME_MULTIPLIER;
      const stepDb = delta > 0 ? multiplier : -multiplier;
      setMasterGain(masterGainDb.value + stepDb);
    }
  };

  /**
   * Handle an incoming MIDI message.
   */
  const handleMidiMessage = (event: MIDIMessageEvent) => {
    const data = event.data;
    if (!data) return;

    // Every MIDI action ends up as a command to the server. While the
    // connection is lost those drop silently, so ignore the surface entirely
    // rather than letting the operator believe a fader move landed. MIDI Learn
    // is exempt below — it only writes local config.
    if (useLiveplayServer().connectionLost && learning.value === null) return;

    // Filter to preferred device if one is selected
    if (config.value.preferredDevice) {
      const inputName = (event.target as any)?.name as string | undefined;
      if (inputName !== config.value.preferredDevice) return;
    }

    const parsed = parseMidiMessage(data);
    if (!parsed || parsed.type === 'other') return;

    const binding: MidiBinding = { channel: parsed.channel, type: parsed.type as MidiBinding['type'], number: parsed.number };
    lastMidiMessage.value = binding;

    // MIDI Learn mode: capture this message
    if (learning.value !== null) {
      if (onLearnCapture) {
        onLearnCapture(binding);
      }
      return;
    }

    // Look up binding in config
    for (const [actionId, configured] of Object.entries(config.value.bindings)) {
      if (bindingsMatch(configured, binding)) {
        const action = MIDI_ACTIONS.find(a => a.id === actionId);
        if (!action) continue;

        if (action.continuous) {
          dispatchContinuous(actionId as MidiActionId, parsed.value);
        } else if (parsed.type === 'pitchbend') {
          // Pitchbend as discrete: trigger at top of range
          if (parsed.value > 63) {
            dispatchDiscrete(actionId as MidiActionId);
          }
        } else {
          // Only trigger on note-on or CC > 63 (button press)
          if (parsed.type === 'note' && parsed.value > 0) {
            dispatchDiscrete(actionId as MidiActionId);
          } else if (parsed.type === 'cc' && parsed.value > 63) {
            dispatchDiscrete(actionId as MidiActionId);
          }
        }
        break;
      }
    }
  };

  /**
   * Update connected device list.
   */
  const updateDeviceList = () => {
    if (!midiAccess.value) {
      connectedDevices.value = [];
      connectedOutputDevices.value = [];
      return;
    }
    const names: string[] = [];
    midiAccess.value.inputs.forEach((input) => {
      if (input.name) names.push(input.name);
    });
    connectedDevices.value = names;

    const outNames: string[] = [];
    midiAccess.value.outputs.forEach((output) => {
      if (output.name) outNames.push(output.name);
    });
    connectedOutputDevices.value = outNames;
  };

  /**
   * Attach listeners to all MIDI input ports.
   */
  const attachListeners = () => {
    if (!midiAccess.value) return;
    midiAccess.value.inputs.forEach((input) => {
      input.onmidimessage = handleMidiMessage;
    });
  };

  /**
   * Request MIDI access and set up listeners.
   */
  const initMidi = async () => {
    if (!navigator.requestMIDIAccess) {
      console.warn('[MIDI] Web MIDI API not available');
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      midiAccess.value = access;

      attachListeners();
      updateDeviceList();

      // Handle hot-plug
      access.onstatechange = () => {
        attachListeners();
        updateDeviceList();
      };
    } catch (err) {
      console.error('[MIDI] Failed to request MIDI access:', err);
    }
  };

  /**
   * Load config from main process.
   */
  const loadConfig = async () => {
    if (import.meta.client && window.electronAPI) {
      const data = await window.electronAPI.readMidiConfig();
      if (data) {
        config.value = { bindings: {}, ...data } as MidiConfig;
      }
    }
  };

  /**
   * Set (or clear) the preferred MIDI input device.
   */
  const setPreferredDevice = (deviceName: string | null) => {
    if (deviceName) {
      config.value.preferredDevice = deviceName;
    } else {
      delete config.value.preferredDevice;
    }
    saveConfig();
  };

  /**
   * Set (or clear) the preferred MIDI OUTPUT device — where lighting cues
   * (ActionItem, kind 'midi-trigger') send their Note-On. A machine setting,
   * same as the input device: which physical/virtual (e.g. loopMIDI) port
   * this rig is wired to, not something that travels with the show.
   */
  const setPreferredOutputDevice = (deviceName: string | null) => {
    if (deviceName) {
      config.value.preferredOutputDevice = deviceName;
    } else {
      delete config.value.preferredOutputDevice;
    }
    saveConfig();
  };

  /**
   * Send a plain 3-byte MIDI Note-On to the configured output device — the
   * actual send behind a lighting cue's GO. No separate Web MIDI permission
   * is needed: requestMIDIAccess() above already grants both `.inputs` and
   * `.outputs` on the one MIDIAccess object (confirmed via the Web MIDI
   * spec; there's no distinct "output" permission). Best-effort: if no
   * output device is configured, or the configured one isn't connected,
   * this logs and does nothing rather than throwing — a disconnected
   * lighting rig shouldn't be able to break GO for the rest of the cue.
   */
  const sendMidiNote = (channel: number, note: number, velocity = 127) => {
    if (!midiAccess.value) {
      console.warn('[MIDI] sendMidiNote: no MIDI access');
      return;
    }
    const wanted = config.value.preferredOutputDevice;
    if (!wanted) {
      console.warn('[MIDI] sendMidiNote: no output device configured (Settings > Controls)');
      return;
    }
    let target: MIDIOutput | null = null;
    midiAccess.value.outputs.forEach((output) => {
      if (!target && output.name === wanted) target = output;
    });
    if (!target) {
      console.warn(`[MIDI] sendMidiNote: output device "${wanted}" not connected`);
      return;
    }
    // Status byte: 0x90 (Note On) | channel nibble. channel here is the
    // user-facing 1-16; the wire format's low nibble is 0-based.
    const statusByte = 0x90 | (Math.max(1, Math.min(16, channel)) - 1);
    const noteByte = Math.max(0, Math.min(127, note));
    const velByte = Math.max(0, Math.min(127, velocity));
    (target as MIDIOutput).send([statusByte, noteByte, velByte]);
  };

  /**
   * Set the master-volume step multiplier (dB applied per MIDI message).
   * Clamped to a sane positive range.
   */
  const setMasterVolumeMultiplier = (value: number) => {
    const clamped = Math.max(0.1, Math.min(60, value));
    config.value.masterVolumeMultiplier = clamped;
    saveConfig();
  };

  /**
   * Save config to main process.
   */
  const saveConfig = async () => {
    if (import.meta.client && window.electronAPI) {
      await window.electronAPI.writeMidiConfig(config.value);
    }
  };

  /**
   * Start MIDI Learn mode for an action.
   */
  const startLearn = (actionId: MidiActionId, callback: (binding: MidiBinding) => void) => {
    learning.value = actionId;
    onLearnCapture = callback;
  };

  /**
   * Stop MIDI Learn mode.
   */
  const stopLearn = () => {
    learning.value = null;
    onLearnCapture = null;
  };

  /**
   * Update a binding. Returns conflict action ID or null.
   */
  const updateBinding = (actionId: MidiActionId, binding: MidiBinding): { conflict: string | null } => {
    // Check for conflicts
    for (const [existingAction, existingBinding] of Object.entries(config.value.bindings)) {
      if (existingAction !== actionId && bindingsMatch(existingBinding, binding)) {
        return { conflict: existingAction };
      }
    }
    config.value.bindings[actionId] = binding;
    saveConfig();
    return { conflict: null };
  };

  /**
   * Clear a binding.
   */
  const clearBinding = (actionId: MidiActionId) => {
    delete config.value.bindings[actionId];
    saveConfig();
  };

  /**
   * Clear all bindings.
   */
  const clearAllBindings = () => {
    config.value.bindings = {};
    saveConfig();
  };

  /**
   * Mount: init MIDI and load config.
   */
  const mount = async () => {
    if (mounted) return;
    mounted = true;
    await loadConfig();
    await initMidi();
  };

  /**
   * Unmount: detach listeners.
   */
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    if (midiAccess.value) {
      midiAccess.value.inputs.forEach((input) => {
        input.onmidimessage = null;
      });
    }
  };

  return {
    config,
    connectedDevices,
    connectedOutputDevices,
    preferredDevice,
    preferredOutputDevice,
    learning,
    lastMidiMessage,
    mount,
    unmount,
    startLearn,
    stopLearn,
    updateBinding,
    clearBinding,
    clearAllBindings,
    setPreferredDevice,
    setPreferredOutputDevice,
    sendMidiNote,
    setMasterVolumeMultiplier,
  };
};
