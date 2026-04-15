import { ImageEntry, UIToCode, CodeToUI, PluginState } from './types';

const REGISTRY_KEY = 'imageRegistry';
const NODE_NAME_KEY = 'imageName';

// ── Registry helpers ─────────────────────────────────────────────────────────

function getRegistry(): ImageEntry[] {
  const raw = figma.root.getPluginData(REGISTRY_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ImageEntry[];
  } catch {
    return [];
  }
}

function setRegistry(entries: ImageEntry[]): void {
  figma.root.setPluginData(REGISTRY_KEY, JSON.stringify(entries));
}

/** Remove entries whose nodes no longer exist in the document. */
function syncRegistry(): ImageEntry[] {
  const registry = getRegistry();
  const valid = registry.filter(e => figma.getNodeById(e.nodeId) !== null);
  if (valid.length !== registry.length) setRegistry(valid);
  return valid;
}

function isNameTaken(name: string, excludeNodeId?: string): boolean {
  return getRegistry().some(
    e => e.name.toLowerCase() === name.toLowerCase() && e.nodeId !== excludeNodeId,
  );
}

// ── Core operations ──────────────────────────────────────────────────────────

function markNode(node: SceneNode, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  if (isNameTaken(trimmed)) throw new Error(`Name "${trimmed}" is already used`);

  const registry = getRegistry().filter(e => e.nodeId !== node.id);
  node.setPluginData(NODE_NAME_KEY, trimmed);
  registry.push({ nodeId: node.id, name: trimmed });
  setRegistry(registry);
}

function unmarkNode(nodeId: string): void {
  const node = figma.getNodeById(nodeId);
  if (node && 'setPluginData' in node) {
    (node as SceneNode).setPluginData(NODE_NAME_KEY, '');
  }
  setRegistry(getRegistry().filter(e => e.nodeId !== nodeId));
}

function renameEntry(nodeId: string, newName: string): void {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  if (isNameTaken(trimmed, nodeId)) throw new Error(`Name "${trimmed}" is already used`);

  const node = figma.getNodeById(nodeId);
  if (node && 'setPluginData' in node) {
    (node as SceneNode).setPluginData(NODE_NAME_KEY, trimmed);
  }
  const registry = getRegistry();
  const entry = registry.find(e => e.nodeId === nodeId);
  if (entry) {
    entry.name = trimmed;
    setRegistry(registry);
  }
}

// ── Page helpers ─────────────────────────────────────────────────────────────

function getNodePage(node: BaseNode): PageNode | null {
  let cur: BaseNode | null = node;
  while (cur) {
    if (cur.type === 'PAGE') return cur as PageNode;
    cur = cur.parent;
  }
  return null;
}

function isOnCurrentPage(node: BaseNode): boolean {
  return getNodePage(node)?.id === figma.currentPage.id;
}

// ── State ────────────────────────────────────────────────────────────────────

function buildState(): PluginState {
  const images = syncRegistry();
  const selection = figma.currentPage.selection;

  let selectedNodeId: string | null = null;
  let selectedLayerName: string | null = null;
  let isMarked = false;
  let markedName: string | null = null;

  if (selection.length === 1) {
    const node = selection[0];
    selectedNodeId = node.id;
    selectedLayerName = node.name;
    const stored = node.getPluginData(NODE_NAME_KEY);
    isMarked = !!stored;
    markedName = stored || null;
  }

  const currentPageCount = images.filter(e => {
    const n = figma.getNodeById(e.nodeId);
    return n && isOnCurrentPage(n);
  }).length;

  return {
    images,
    selectionCount: selection.length,
    selectedNodeId,
    selectedLayerName,
    isMarked,
    markedName,
    currentPageCount,
  };
}

function sendState(): void {
  const state = buildState();
  figma.ui.postMessage({ type: 'state', ...state } as CodeToUI);
}

function sendError(message: string): void {
  figma.ui.postMessage({ type: 'error', message } as CodeToUI);
}

// ── Filename sanitization ────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  const s = name
    .replace(/[^\w\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return s || 'image';
}

// ── Plugin bootstrap ─────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 340, height: 520, title: 'NK Image Exporter' });

figma.on('selectionchange', sendState);
figma.on('currentpagechange', sendState);

sendState();

// ── Message handler ──────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: UIToCode) => {
  switch (msg.type) {
    case 'getState':
      sendState();
      break;

    case 'mark': {
      const selection = figma.currentPage.selection;
      if (selection.length !== 1) {
        sendError('Select exactly one layer');
        return;
      }
      try {
        markNode(selection[0], msg.name);
        sendState();
      } catch (e) {
        sendError((e as Error).message);
      }
      break;
    }

    case 'unmark':
      unmarkNode(msg.nodeId);
      sendState();
      break;

    case 'rename':
      try {
        renameEntry(msg.nodeId, msg.newName);
        sendState();
      } catch (e) {
        sendError((e as Error).message);
      }
      break;

    case 'focus': {
      const node = figma.getNodeById(msg.nodeId);
      if (!node) return;
      const page = getNodePage(node);
      if (page && page.id !== figma.currentPage.id) {
        figma.currentPage = page;
      }
      figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
      break;
    }

    case 'export': {
      const images = syncRegistry();
      const toExport = images.filter(e => {
        const n = figma.getNodeById(e.nodeId);
        return n && isOnCurrentPage(n);
      });

      let exported = 0;
      let failed = 0;

      for (const entry of toExport) {
        const node = figma.getNodeById(entry.nodeId) as SceneNode;
        try {
          const bytes = await node.exportAsync({
            format: 'PNG',
            constraint: { type: 'SCALE', value: 1 },
          });
          figma.ui.postMessage({
            type: 'exportFile',
            fileName: sanitizeName(entry.name) + '.png',
            bytes: Array.from(bytes),
          } as CodeToUI);
          exported++;
        } catch (err) {
          console.error(`Export failed for "${entry.name}":`, err);
          failed++;
        }
      }

      figma.ui.postMessage({ type: 'exportDone', exported, failed } as CodeToUI);
      break;
    }
  }
};
