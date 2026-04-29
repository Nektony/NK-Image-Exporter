import { ImageEntry, UIToCode, CodeToUI, PluginState } from './types';

const REGISTRY_KEY = 'imageRegistry';
const NODE_NAME_KEY = 'imageName';

// ── Registry ─────────────────────────────────────────────────────────────────

function getRegistry(): ImageEntry[] {
  const raw = figma.root.getPluginData(REGISTRY_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as ImageEntry[]; } catch { return []; }
}

function setRegistry(entries: ImageEntry[]): void {
  figma.root.setPluginData(REGISTRY_KEY, JSON.stringify(entries));
}

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

// ── Core operations ───────────────────────────────────────────────────────────

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
  if (node && 'setPluginData' in node) (node as SceneNode).setPluginData(NODE_NAME_KEY, '');
  setRegistry(getRegistry().filter(e => e.nodeId !== nodeId));
}

function renameEntry(nodeId: string, newName: string): void {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Name cannot be empty');
  if (isNameTaken(trimmed, nodeId)) throw new Error(`Name "${trimmed}" is already used`);
  const node = figma.getNodeById(nodeId);
  if (node && 'setPluginData' in node) (node as SceneNode).setPluginData(NODE_NAME_KEY, trimmed);
  const registry = getRegistry();
  const entry = registry.find(e => e.nodeId === nodeId);
  if (entry) { entry.name = trimmed; setRegistry(registry); }
}

// ── Page helpers ──────────────────────────────────────────────────────────────

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

// ── State ─────────────────────────────────────────────────────────────────────

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

  return { images, selectionCount: selection.length, selectedNodeId, selectedLayerName, isMarked, markedName, currentPageCount };
}

function sendState(): void {
  figma.ui.postMessage({ type: 'state', ...buildState() } as CodeToUI);
}

function sendError(message: string): void {
  figma.ui.postMessage({ type: 'error', message } as CodeToUI);
}

// ── Filename sanitization ─────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  const s = name.replace(/[^\w\-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'image';
}

// ── Dark mode detection ───────────────────────────────────────────────────────

interface DarkModeInfo {
  type: 'mode';
  collection: VariableCollection;
  darkModeId: string;
}

/**
 * Approach A: find a variable collection that has both a light-named and
 * dark-named mode (case-insensitive).
 */
function findDarkModeCollection(): DarkModeInfo | null {
  try {
    for (const col of figma.variables.getLocalVariableCollections()) {
      const dark = col.modes.find(m => /dark/i.test(m.name));
      if (dark) return { type: 'mode', collection: col, darkModeId: dark.modeId };
    }
  } catch { /* Variables API unavailable or no collections */ }
  return null;
}

/**
 * Approach B: any variable whose name starts with 'Dark/' signals that a
 * name-based dark scheme exists.
 */
function hasDarkPrefixVariables(): boolean {
  try {
    return figma.variables.getLocalVariables().some(v => v.name.startsWith('Dark/'));
  } catch { return false; }
}

// ── Dark binding swap (Approach B) ───────────────────────────────────────────

/**
 * Recursively walk a cloned node tree and swap every `Light/…` colour
 * variable binding → the matching `Dark/…` variable.  Only touches fills
 * and strokes (SOLID paints).  Returns true if at least one swap was made.
 */
function applyDarkBindings(root: SceneNode): boolean {
  try { figma.variables.getLocalVariables(); } catch { return false; }

  const allVars = figma.variables.getLocalVariables();
  const varById = new Map(allVars.map(v => [v.id, v]));
  let changed = false;

  function swapPaints(paints: ReadonlyArray<Paint>): ReadonlyArray<Paint> {
    return paints.map(paint => {
      if (paint.type !== 'SOLID') return paint;
      const colorBinding = (paint.boundVariables as Record<string, VariableAlias> | undefined)?.color;
      if (!colorBinding) return paint;
      const lightVar = varById.get(colorBinding.id);
      if (!lightVar?.name.startsWith('Light/')) return paint;
      const darkVar = allVars.find(
        v => v.name === 'Dark/' + lightVar.name.slice(6) && v.resolvedType === lightVar.resolvedType,
      );
      if (!darkVar) return paint;
      changed = true;
      return figma.variables.setBoundVariableForPaint(paint, 'color', darkVar);
    });
  }

  function traverse(node: SceneNode): void {
    if ('fills' in node) {
      const fills = (node as GeometryMixin).fills;
      if (Array.isArray(fills)) (node as GeometryMixin).fills = swapPaints(fills) as Paint[];
    }
    if ('strokes' in node) {
      const strokes = (node as GeometryMixin).strokes;
      if (Array.isArray(strokes)) (node as GeometryMixin).strokes = swapPaints(strokes) as Paint[];
    }
    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children) traverse(child as SceneNode);
    }
  }

  traverse(root);
  return changed;
}

// ── Byte comparison ───────────────────────────────────────────────────────────

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ── Contents.json builder ─────────────────────────────────────────────────────

function buildContentsJson(name: string, hasDark: boolean): Uint8Array {
  const images: object[] = [
    { filename: `${name}.png`,    idiom: 'mac', scale: '1x' },
    { filename: `${name}@2x.png`, idiom: 'mac', scale: '2x' },
  ];
  if (hasDark) {
    images.push(
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: `${name}~dark.png`,    idiom: 'mac', scale: '1x' },
      { appearances: [{ appearance: 'luminosity', value: 'dark' }], filename: `${name}~dark@2x.png`, idiom: 'mac', scale: '2x' },
    );
  }
  const json = JSON.stringify({ images, info: { author: 'xcode', version: 1 } }, null, 2);
  // TextEncoder is NOT available in the Figma plugin sandbox — encode manually.
  // JSON output is guaranteed ASCII so charCodeAt is safe.
  const bytes = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i);
  return bytes;
}

// ── Send a file to the UI ─────────────────────────────────────────────────────

function sendFile(path: string, bytes: Uint8Array): void {
  figma.ui.postMessage({ type: 'exportFile', fileName: path, bytes: Array.from(bytes) } as CodeToUI);
}

// ── Export one node as imageset ───────────────────────────────────────────────

async function exportImageset(node: SceneNode, imageName: string): Promise<void> {
  const safe = sanitizeName(imageName);
  const dir  = `${safe}.imageset/`;

  // ── Light variants ────────────────────────────────────────────────────────
  const light1x = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  const light2x = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });

  // ── Dark variants via clone ───────────────────────────────────────────────
  let dark1x: Uint8Array | null = null;
  let dark2x: Uint8Array | null = null;

  const darkCollection = findDarkModeCollection();
  const usesNamedDark  = hasDarkPrefixVariables();

  if ((darkCollection || usesNamedDark) && 'clone' in node) {
    const clone = (node as SceneNode & { clone(): SceneNode }).clone();
    try {
      let darkReady = false;

      if (darkCollection && 'setExplicitVariableModeForCollection' in clone) {
        // Approach A — switch the collection to its Dark mode
        (clone as FrameNode).setExplicitVariableModeForCollection(
          darkCollection.collection,
          darkCollection.darkModeId,
        );
        darkReady = true;
      } else if (usesNamedDark) {
        // Approach B — swap Light/… → Dark/… colour bindings in place on the clone
        darkReady = applyDarkBindings(clone);
      }

      if (darkReady) {
        const d1x = await clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
        const d2x = await clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
        // Only treat as real dark if the pixels actually differ
        if (!bytesEqual(light1x, d1x)) {
          dark1x = d1x;
          dark2x = d2x;
        }
      }
    } finally {
      clone.remove();
    }
  }

  // ── Emit files ────────────────────────────────────────────────────────────
  const hasDark = dark1x !== null;

  sendFile(dir + `${safe}.png`,    light1x);
  sendFile(dir + `${safe}@2x.png`, light2x);
  if (hasDark) {
    sendFile(dir + `${safe}~dark.png`,    dark1x!);
    sendFile(dir + `${safe}~dark@2x.png`, dark2x!);
  }
  sendFile(dir + 'Contents.json', buildContentsJson(safe, hasDark));
}

// ── Plugin bootstrap ──────────────────────────────────────────────────────────

figma.showUI(__html__, { width: 340, height: 520, title: 'NK Image Exporter' });

figma.on('selectionchange', sendState);
figma.on('currentpagechange', sendState);

sendState();

// ── Message handler ───────────────────────────────────────────────────────────

figma.ui.onmessage = async (msg: UIToCode) => {
  switch (msg.type) {
    case 'getState':
      sendState();
      break;

    case 'mark': {
      const selection = figma.currentPage.selection;
      if (selection.length !== 1) { sendError('Select exactly one layer'); return; }
      try { markNode(selection[0], msg.name); sendState(); }
      catch (e) { sendError((e as Error).message); }
      break;
    }

    case 'unmark':
      unmarkNode(msg.nodeId);
      sendState();
      break;

    case 'rename':
      try { renameEntry(msg.nodeId, msg.newName); sendState(); }
      catch (e) { sendError((e as Error).message); }
      break;

    case 'focus': {
      const node = figma.getNodeById(msg.nodeId);
      if (!node) return;
      const page = getNodePage(node);
      if (page && page.id !== figma.currentPage.id) figma.currentPage = page;
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
        try {
          const node = figma.getNodeById(entry.nodeId) as SceneNode;
          await exportImageset(node, entry.name);
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
