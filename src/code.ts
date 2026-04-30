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

/**
 * Stricter sanitization for page-export mode: only [A-Za-z0-9] preserved.
 * Used for both image names and folder names in the hierarchical output.
 */
function sanitizePagePart(name: string): string {
  const s = name.replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return s || 'unnamed';
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

// ── PNG header parsing & size validation ─────────────────────────────────────

/** Read width/height from a PNG's IHDR chunk (offsets 16/20, big-endian uint32). */
function readPngDims(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

interface ImagesetBuffer {
  imageName: string;       // sanitized name used in filenames
  dir: string;             // ZIP folder including trailing '/'
  light1x: Uint8Array;
  light2x: Uint8Array;
  dark1x: Uint8Array | null;
  dark2x: Uint8Array | null;
  lightPath: string;       // human-readable hierarchy path for error messages
  darkPath: string | null; // null when dark came from variable-swap (clone of light)
}

/**
 * Returns a list of human-readable error messages (empty if all sizes are valid).
 * Each PNG must satisfy: 2x dims === 1x dims × 2; light dims === dark dims.
 */
function validateImagesetSizes(b: ImagesetBuffer): string[] {
  const errors: string[] = [];
  const l1 = readPngDims(b.light1x);
  const l2 = readPngDims(b.light2x);

  if (l2.width !== l1.width * 2 || l2.height !== l1.height * 2) {
    errors.push(
      `  ${b.lightPath} (light): 1x is ${l1.width}×${l1.height}, ` +
      `2x is ${l2.width}×${l2.height} (expected ${l1.width * 2}×${l1.height * 2})`,
    );
  }

  if (b.dark1x && b.dark2x) {
    const d1 = readPngDims(b.dark1x);
    const d2 = readPngDims(b.dark2x);
    const darkLabel = b.darkPath ? `${b.darkPath} (dark)` : `${b.lightPath} (dark variant)`;

    if (d2.width !== d1.width * 2 || d2.height !== d1.height * 2) {
      errors.push(
        `  ${darkLabel}: 1x is ${d1.width}×${d1.height}, ` +
        `2x is ${d2.width}×${d2.height} (expected ${d1.width * 2}×${d1.height * 2})`,
      );
    }
    if (d1.width !== l1.width || d1.height !== l1.height) {
      errors.push(
        `  ${b.lightPath}: light is ${l1.width}×${l1.height} but dark is ${d1.width}×${d1.height}` +
        (b.darkPath ? ` (dark from ${b.darkPath})` : ''),
      );
    }
  }

  return errors;
}

function emitImageset(b: ImagesetBuffer): void {
  const safe = b.imageName;
  const dir  = b.dir;
  sendFile(dir + `${safe}.png`,    b.light1x);
  sendFile(dir + `${safe}@2x.png`, b.light2x);
  const hasDark = b.dark1x !== null;
  if (hasDark) {
    sendFile(dir + `${safe}~dark.png`,    b.dark1x!);
    sendFile(dir + `${safe}~dark@2x.png`, b.dark2x!);
  }
  sendFile(dir + 'Contents.json', buildContentsJson(safe, hasDark));
}

// ── Dark variant via variable-swap (shared by both export modes) ─────────────

/**
 * Render a node's dark variant by cloning, switching its variable bindings to
 * dark, exporting, and removing the clone. Returns null if the file has no
 * dark variables at all OR if the dark render is bit-identical to the light.
 */
async function renderDarkViaVariables(
  node: SceneNode,
  light1x: Uint8Array,
): Promise<{ dark1x: Uint8Array; dark2x: Uint8Array } | null> {
  const darkCollection = findDarkModeCollection();
  const usesNamedDark  = hasDarkPrefixVariables();

  if ((!darkCollection && !usesNamedDark) || !('clone' in node)) return null;

  const clone = (node as SceneNode & { clone(): SceneNode }).clone();
  try {
    let darkReady = false;

    if (darkCollection && 'setExplicitVariableModeForCollection' in clone) {
      (clone as FrameNode).setExplicitVariableModeForCollection(
        darkCollection.collection,
        darkCollection.darkModeId,
      );
      darkReady = true;
    } else if (usesNamedDark) {
      darkReady = applyDarkBindings(clone);
    }

    if (!darkReady) return null;

    const d1x = await clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    const d2x = await clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
    if (bytesEqual(light1x, d1x)) return null;

    return { dark1x: d1x, dark2x: d2x };
  } finally {
    clone.remove();
  }
}

// ── Build one imageset (tagged mode — flat output) ───────────────────────────

async function buildTaggedImageset(node: SceneNode, imageName: string): Promise<ImagesetBuffer> {
  const safe = sanitizeName(imageName);
  const light1x = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  const light2x = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
  const dark = await renderDarkViaVariables(node, light1x);
  return {
    imageName: safe,
    dir: `${safe}.imageset/`,
    light1x, light2x,
    dark1x: dark?.dark1x ?? null,
    dark2x: dark?.dark2x ?? null,
    lightPath: getNodeFullPath(node),
    darkPath: null, // dark came from a variable-swap clone of `node`
  };
}

// ── Page-export mode ─────────────────────────────────────────────────────────

const PAGE_EXPORT_PREFIX = 'img_exp/';
const DARK_SUFFIX = '-dark';

interface PageExportCandidate {
  node: SceneNode;
  fullName: string;  // e.g. "img_exp/icon_back" — exact node name as in Figma
  baseName: string;  // e.g. "icon_back" — fullName with PAGE_EXPORT_PREFIX stripped
}

/**
 * Walk the current page and collect every node whose name starts with the
 * `img_exp/` prefix. Do NOT recurse into matching nodes — they are leaves.
 */
function collectPageExportCandidates(): PageExportCandidate[] {
  const out: PageExportCandidate[] = [];
  function walk(parent: BaseNode & ChildrenMixin): void {
    for (const child of parent.children) {
      if (child.name.startsWith(PAGE_EXPORT_PREFIX)) {
        out.push({
          node: child,
          fullName: child.name,
          baseName: child.name.slice(PAGE_EXPORT_PREFIX.length),
        });
      } else if ('children' in child) {
        walk(child as BaseNode & ChildrenMixin);
      }
    }
  }
  walk(figma.currentPage);
  return out;
}

/**
 * Search the entire current-page subtree for the first node whose name is
 * an exact match. Used to look up a `-dark` sibling — the spec says
 * "anywhere on the page with that exact name", so traversal is unrestricted.
 */
function findPageNodeByExactName(name: string): SceneNode | null {
  function walk(parent: BaseNode & ChildrenMixin): SceneNode | null {
    for (const child of parent.children) {
      if (child.name === name) return child;
      if ('children' in child) {
        const found = walk(child as BaseNode & ChildrenMixin);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(figma.currentPage);
}

/**
 * Build the folder-path segments from the node's parent chain up to (but not
 * including) the page. Innermost ancestor → innermost (last) segment.
 */
function getPagePath(node: SceneNode): string[] {
  const parts: string[] = [];
  let cur: BaseNode | null = node.parent;
  while (cur && cur.type !== 'PAGE') {
    parts.unshift(sanitizePagePart(cur.name));
    cur = cur.parent;
  }
  return parts;
}

/**
 * Build a human-readable hierarchy path used in error messages: includes the
 * page, every ancestor, and the node's own name (raw, not sanitized).
 *   e.g. "Settings > Mobile > Toolbar > img_exp/icon_back"
 */
function getNodeFullPath(node: BaseNode): string {
  const parts: string[] = [];
  let cur: BaseNode | null = node;
  while (cur && cur.type !== 'DOCUMENT') {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join(' > ');
}

async function buildPageImageset(
  lightNode: SceneNode,
  darkNode: SceneNode | null,
  imageName: string,
  folderPath: string[],
): Promise<ImagesetBuffer> {
  const safe = sanitizePagePart(imageName);
  const dir  = [...folderPath, `${safe}.imageset`].join('/') + '/';

  const light1x = await lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
  const light2x = await lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });

  let dark1x: Uint8Array | null = null;
  let dark2x: Uint8Array | null = null;

  if (darkNode) {
    dark1x = await darkNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    dark2x = await darkNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
  } else {
    const dark = await renderDarkViaVariables(lightNode, light1x);
    if (dark) { dark1x = dark.dark1x; dark2x = dark.dark2x; }
  }

  return {
    imageName: safe,
    dir,
    light1x, light2x,
    dark1x, dark2x,
    lightPath: getNodeFullPath(lightNode),
    darkPath: darkNode ? getNodeFullPath(darkNode) : null,
  };
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

      const buffers: ImagesetBuffer[] = [];
      let failed = 0;

      for (const entry of toExport) {
        try {
          const node = figma.getNodeById(entry.nodeId) as SceneNode;
          buffers.push(await buildTaggedImageset(node, entry.name));
        } catch (err) {
          console.error(`Export failed for "${entry.name}":`, err);
          failed++;
        }
      }

      const sizeErrors: string[] = [];
      for (const b of buffers) sizeErrors.push(...validateImagesetSizes(b));
      if (sizeErrors.length > 0) {
        figma.ui.postMessage({
          type: 'exportError',
          message: ['Image size validation failed:', ...sizeErrors].join('\n'),
        } as CodeToUI);
        break;
      }

      for (const b of buffers) emitImageset(b);
      figma.ui.postMessage({ type: 'exportDone', exported: buffers.length, failed, mode: 'tagged' } as CodeToUI);
      break;
    }

    case 'exportPage': {
      const candidates = collectPageExportCandidates();

      // Orphan-dark check — a candidate ending in -dark must have a matching light counterpart.
      const allFullNames = new Set(candidates.map(c => c.fullName));
      const orphans: SceneNode[] = [];
      for (const c of candidates) {
        if (!c.fullName.endsWith(DARK_SUFFIX)) continue;
        const lightFullName = c.fullName.slice(0, -DARK_SUFFIX.length);
        if (!allFullNames.has(lightFullName)) orphans.push(c.node);
      }
      if (orphans.length > 0) {
        const lines = ['Dark layers without a light counterpart:'];
        for (const n of orphans) lines.push(`  ${getNodeFullPath(n)}`);
        figma.ui.postMessage({
          type: 'exportError',
          message: lines.join('\n'),
        } as CodeToUI);
        break;
      }

      // Resolve dark sibling for each candidate (by full-name match anywhere on page).
      // Dark siblings are then excluded from being exported as their own light image.
      interface Job {
        light: SceneNode;
        dark: SceneNode | null;
        finalName: string;
        folder: string[];
      }
      const consumedAsDark = new Set<string>();
      const jobs: Job[] = [];
      for (const c of candidates) {
        const darkSibling = findPageNodeByExactName(c.fullName + DARK_SUFFIX);
        if (darkSibling) consumedAsDark.add(darkSibling.id);
        jobs.push({
          light: c.node,
          dark: darkSibling,
          finalName: sanitizePagePart(c.baseName),
          folder: getPagePath(c.node),
        });
      }
      const finalJobs = jobs.filter(j => !consumedAsDark.has(j.light.id));

      // Duplicate detection — by final imageset name only (folder-agnostic).
      const byFinalName = new Map<string, SceneNode[]>();
      for (const j of finalJobs) {
        const arr = byFinalName.get(j.finalName) ?? [];
        arr.push(j.light);
        byFinalName.set(j.finalName, arr);
      }
      const dupeEntries = [...byFinalName.entries()].filter(([, nodes]) => nodes.length > 1);
      if (dupeEntries.length > 0) {
        const lines = ['Duplicate image names:'];
        for (const [name, nodes] of dupeEntries) {
          lines.push(`  "${name}":`);
          for (const n of nodes) lines.push(`    ${getNodeFullPath(n)}`);
        }
        figma.ui.postMessage({
          type: 'exportError',
          message: lines.join('\n'),
        } as CodeToUI);
        break;
      }

      const buffers: ImagesetBuffer[] = [];
      let failed = 0;
      for (const job of finalJobs) {
        try {
          buffers.push(await buildPageImageset(job.light, job.dark, job.finalName, job.folder));
        } catch (err) {
          console.error(`Page export failed for "${job.finalName}":`, err);
          failed++;
        }
      }

      const sizeErrors: string[] = [];
      for (const b of buffers) sizeErrors.push(...validateImagesetSizes(b));
      if (sizeErrors.length > 0) {
        figma.ui.postMessage({
          type: 'exportError',
          message: ['Image size validation failed:', ...sizeErrors].join('\n'),
        } as CodeToUI);
        break;
      }

      for (const b of buffers) emitImageset(b);
      // Page mode always produces a ZIP, even when empty (per spec).
      figma.ui.postMessage({ type: 'exportDone', exported: buffers.length, failed, mode: 'page' } as CodeToUI);
      break;
    }
  }
};
