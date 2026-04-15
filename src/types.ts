export interface ImageEntry {
  nodeId: string;
  name: string;
}

// ── Messages: UI → Code ──────────────────────────────────────────────────────

export type UIToCode =
  | { type: 'getState' }
  | { type: 'mark'; name: string }
  | { type: 'unmark'; nodeId: string }
  | { type: 'rename'; nodeId: string; newName: string }
  | { type: 'focus'; nodeId: string }
  | { type: 'export' };

// ── Messages: Code → UI ──────────────────────────────────────────────────────

export interface PluginState {
  images: ImageEntry[];
  selectionCount: number;
  selectedNodeId: string | null;
  selectedLayerName: string | null;
  isMarked: boolean;
  markedName: string | null;
  /** Number of tagged images on the currently active page */
  currentPageCount: number;
}

export type CodeToUI =
  | ({ type: 'state' } & PluginState)
  | { type: 'exportFile'; fileName: string; bytes: number[] }
  | { type: 'exportDone'; exported: number; failed: number }
  | { type: 'error'; message: string };
