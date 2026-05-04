import { zlibSync, unzlibSync } from 'fflate';
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
  collection: VariableCollection;
  darkModeId: string;
}

/**
 * Approach A: return ALL variable collections that have a dark-named mode.
 */
function findAllDarkModeCollections(): DarkModeInfo[] {
  const result: DarkModeInfo[] = [];
  try {
    for (const col of figma.variables.getLocalVariableCollections()) {
      const dark = col.modes.find(m => /dark/i.test(m.name));
      if (dark) result.push({ collection: col, darkModeId: dark.modeId });
    }
  } catch { /* Variables API unavailable */ }
  return result;
}

/**
 * Approach B: any paint style or variable starting with 'Dark/' signals a
 * name-based dark scheme exists.
 */
function hasDarkScheme(): boolean {
  try {
    if (figma.getLocalPaintStyles().some(s => s.name.startsWith('Dark/'))) return true;
    if (figma.variables.getLocalVariables().some(v => v.name.startsWith('Dark/'))) return true;
  } catch { /* ignore */ }
  return false;
}

// ── Dark style/binding swap (Approach B) ─────────────────────────────────────

/**
 * Swap every `Light/…` paint style or variable binding → `Dark/…` on the clone.
 *
 * Two mechanisms per node:
 *   1. fillStyleId / strokeStyleId — local paint styles named "Light/…"
 *   2. paint.boundVariables.color  — variable-bound solid fills/strokes
 *
 * For instances with no explicit paint override we fall back to the master
 * component to create a Dark/ override on the clone.
 */
function applyDarkBindings(root: SceneNode): boolean {
  let paintStyles: PaintStyle[] = [];
  try { paintStyles = figma.getLocalPaintStyles(); } catch { /* ignore */ }
  const styleByName = new Map(paintStyles.map(s => [s.name, s]));

  let allVars: Variable[] = [];
  try { allVars = figma.variables.getLocalVariables(); } catch { /* ignore */ }
  const varById = new Map(allVars.map(v => [v.id, v]));

  let changed = false;

  function swapStyleId(node: SceneNode, prop: 'fillStyleId' | 'strokeStyleId'): void {
    if (!(prop in node)) return;
    const styleId = (node as any)[prop];
    if (!styleId || styleId === figma.mixed) return;
    const style = figma.getStyleById(styleId as string) as PaintStyle | null;
    if (!style?.name.startsWith('Light/')) return;
    const darkStyle = styleByName.get('Dark/' + style.name.slice(6));
    if (!darkStyle) return;
    (node as any)[prop] = darkStyle.id;
    changed = true;
  }

  function swapPaints(paints: ReadonlyArray<Paint>): { result: ReadonlyArray<Paint>; swapped: boolean } {
    let swapped = false;
    const result = paints.map(paint => {
      if (paint.type !== 'SOLID') return paint;
      const colorBinding = (paint.boundVariables as Record<string, VariableAlias> | undefined)?.color;
      if (!colorBinding) return paint;
      const lightVar = varById.get(colorBinding.id);
      if (!lightVar?.name.startsWith('Light/')) return paint;
      const darkVar = allVars.find(v => v.name === 'Dark/' + lightVar.name.slice(6));
      if (!darkVar) return paint;
      changed = true;
      swapped = true;
      return figma.variables.setBoundVariableForPaint(paint, 'color', darkVar);
    });
    return { result, swapped };
  }

  function effectivePaints(node: SceneNode, prop: 'fills' | 'strokes'): ReadonlyArray<Paint> | null {
    if (!(prop in node)) return null;
    const own = (node as GeometryMixin)[prop] as ReadonlyArray<Paint>;
    if (Array.isArray(own) && own.length > 0) return own;
    if (node.type === 'INSTANCE') {
      const master = (node as InstanceNode).mainComponent;
      if (master && prop in master) {
        const mf = (master as GeometryMixin)[prop] as ReadonlyArray<Paint>;
        if (Array.isArray(mf) && mf.length > 0) return mf;
      }
    }
    return null;
  }

  function processNode(node: SceneNode): void {
    swapStyleId(node, 'fillStyleId');
    swapStyleId(node, 'strokeStyleId');

    for (const prop of ['fills', 'strokes'] as const) {
      const paints = effectivePaints(node, prop);
      if (paints) {
        const { result, swapped } = swapPaints(paints);
        if (swapped) (node as GeometryMixin)[prop] = result as Paint[];
      }
    }

    if ('children' in node) {
      for (const child of (node as ChildrenMixin).children as SceneNode[]) {
        processNode(child);
      }
    }
  }

  processNode(root);
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
  const bytes = new Uint8Array(json.length);
  for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i);
  return bytes;
}

// ── Clone tracking ────────────────────────────────────────────────────────────

const orphanCloneIds: string[] = [];

function purgeOrphanClones(): void {
  for (const id of orphanCloneIds) {
    const n = figma.getNodeById(id);
    if (n) try { n.remove(); } catch { /* best effort */ }
  }
  orphanCloneIds.length = 0;
}

function removeClone(id: string): void {
  const n = figma.getNodeById(id);
  if (n) try { n.remove(); } catch { /* best effort */ }
  const idx = orphanCloneIds.indexOf(id);
  if (idx >= 0) orphanCloneIds.splice(idx, 1);
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

// ── Off-by-1 retina auto-fix ─────────────────────────────────────────────────
//
// Figma rounds sub-pixel-sized nodes independently for `SCALE: 1` and `SCALE: 2`,
// so a 24.5 px source can yield 24×N at 1x but 49×N at 2x (or vice-versa).
// `validateImagesetSizes` would reject that mismatch. Before validation we run
// a normalization pass: if a 2x PNG is exactly 1 pixel off the expected
// 1x×2 size in either axis, we crop or pad the 2x image with transparent
// pixels on its right/bottom edge to bring it into spec, then re-validate.

const PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

let _crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!_crcTable) {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    _crcTable = t;
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function readU32BE(b: Uint8Array, o: number): number {
  return (b[o] * 0x1000000) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
}
function writeU32BE(b: Uint8Array, o: number, v: number): void {
  b[o]     = (v >>> 24) & 0xFF;
  b[o + 1] = (v >>> 16) & 0xFF;
  b[o + 2] = (v >>> 8)  & 0xFF;
  b[o + 3] =  v         & 0xFF;
}

interface PngChunk { type: string; data: Uint8Array; }
interface ParsedPng {
  width: number; height: number;
  bitDepth: number; colorType: number; interlace: number;
  idat: Uint8Array;             // concatenated IDAT payload (still zlib-compressed)
  ancillary: PngChunk[];        // every non-IHDR/IDAT/IEND chunk in original order
}

function parsePng(bytes: Uint8Array): ParsedPng | null {
  if (bytes.length < 8 + 12) return null;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIG[i]) return null;
  let pos = 8;
  let ihdr: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  const ancillary: PngChunk[] = [];
  let sawIend = false;
  while (pos + 12 <= bytes.length) {
    const len = readU32BE(bytes, pos);
    if (pos + 8 + len + 4 > bytes.length) return null;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') { sawIend = true; break; }
    else ancillary.push({ type, data: new Uint8Array(data) });
  }
  if (!ihdr || ihdr.length !== 13 || !sawIend || idatParts.length === 0) return null;
  let total = 0;
  for (const p of idatParts) total += p.length;
  const idat = new Uint8Array(total);
  let off = 0;
  for (const p of idatParts) { idat.set(p, off); off += p.length; }
  return {
    width:     readU32BE(ihdr, 0),
    height:    readU32BE(ihdr, 4),
    bitDepth:  ihdr[8],
    colorType: ihdr[9],
    interlace: ihdr[12],
    idat,
    ancillary,
  };
}

/** Reverse PNG per-scanline filtering. Assumes 8-bit RGBA, no interlace. */
function unfilterRgba8(filtered: Uint8Array, width: number, height: number): Uint8Array | null {
  const bpp = 4;
  const stride = width * bpp;
  if (filtered.length !== height * (1 + stride)) return null;
  const raw = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filterType = filtered[src++];
    const rowOff = y * stride;
    const prevRowOff = rowOff - stride;
    for (let x = 0; x < stride; x++) {
      const byte = filtered[src++];
      const left  = x >= bpp                ? raw[rowOff + x - bpp]      : 0;
      const up    = y > 0                   ? raw[prevRowOff + x]        : 0;
      const upLft = (y > 0 && x >= bpp)     ? raw[prevRowOff + x - bpp]  : 0;
      let recon: number;
      switch (filterType) {
        case 0: recon = byte; break;
        case 1: recon = (byte + left) & 0xFF; break;
        case 2: recon = (byte + up) & 0xFF; break;
        case 3: recon = (byte + ((left + up) >>> 1)) & 0xFF; break;
        case 4: {
          const p = left + up - upLft;
          const pa = p < left ? left - p : p - left;
          const pb = p < up   ? up - p   : p - up;
          const pc = p < upLft ? upLft - p : p - upLft;
          const pred = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upLft);
          recon = (byte + pred) & 0xFF;
          break;
        }
        default: return null;
      }
      raw[rowOff + x] = recon;
    }
  }
  return raw;
}

/** Apply PNG filter type 0 (None) to every scanline — simplest valid encoding. */
function filterNoneRgba8(raw: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(height * (1 + stride));
  let dst = 0;
  for (let y = 0; y < height; y++) {
    out[dst++] = 0;
    out.set(raw.subarray(y * stride, y * stride + stride), dst);
    dst += stride;
  }
  return out;
}

function buildPng(width: number, height: number, bitDepth: number, colorType: number,
                  ancillary: PngChunk[], idat: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, 0, width);
  writeU32BE(ihdr, 4, height);
  ihdr[8]  = bitDepth;
  ihdr[9]  = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks: PngChunk[] = [{ type: 'IHDR', data: ihdr }];
  for (const c of ancillary) chunks.push(c);
  chunks.push({ type: 'IDAT', data: idat });
  chunks.push({ type: 'IEND', data: new Uint8Array(0) });

  let total = 8;
  for (const c of chunks) total += 12 + c.data.length;
  const out = new Uint8Array(total);
  for (let i = 0; i < 8; i++) out[i] = PNG_SIG[i];
  let pos = 8;
  for (const c of chunks) {
    writeU32BE(out, pos, c.data.length);
    out[pos + 4] = c.type.charCodeAt(0);
    out[pos + 5] = c.type.charCodeAt(1);
    out[pos + 6] = c.type.charCodeAt(2);
    out[pos + 7] = c.type.charCodeAt(3);
    out.set(c.data, pos + 8);
    const crcInput = new Uint8Array(4 + c.data.length);
    crcInput[0] = c.type.charCodeAt(0);
    crcInput[1] = c.type.charCodeAt(1);
    crcInput[2] = c.type.charCodeAt(2);
    crcInput[3] = c.type.charCodeAt(3);
    crcInput.set(c.data, 4);
    writeU32BE(out, pos + 8 + c.data.length, crc32(crcInput));
    pos += 12 + c.data.length;
  }
  return out;
}

/**
 * Resize a PNG to (targetW × targetH) by cropping or transparent-padding the
 * right and/or bottom edge. Used only for off-by-1 retina nudges, so the
 * delta in each axis is expected to be in {-1, 0, +1}.
 *
 * Returns the rebuilt PNG bytes, or `null` if the source isn't 8-bit RGBA
 * non-interlaced (the only format Figma's PNG export produces in practice).
 */
function resizePngByEdge(bytes: Uint8Array, targetW: number, targetH: number): Uint8Array | null {
  const png = parsePng(bytes);
  if (!png) return null;
  if (png.bitDepth !== 8 || png.colorType !== 6 || png.interlace !== 0) return null;
  if (targetW === png.width && targetH === png.height) return bytes;

  let inflated: Uint8Array;
  try { inflated = unzlibSync(png.idat); } catch { return null; }
  const raw = unfilterRgba8(inflated, png.width, png.height);
  if (!raw) return null;

  const newRaw = new Uint8Array(targetH * targetW * 4); // zero-filled = transparent
  const copyW  = Math.min(png.width,  targetW);
  const copyH  = Math.min(png.height, targetH);
  const oldStride = png.width  * 4;
  const newStride = targetW    * 4;
  const copyBytes = copyW * 4;
  for (let y = 0; y < copyH; y++) {
    newRaw.set(raw.subarray(y * oldStride, y * oldStride + copyBytes), y * newStride);
  }

  const refiltered = filterNoneRgba8(newRaw, targetW, targetH);
  let recompressed: Uint8Array;
  try { recompressed = zlibSync(refiltered); } catch { return null; }
  return buildPng(targetW, targetH, png.bitDepth, png.colorType, png.ancillary, recompressed);
}

/**
 * If a 2x PNG is exactly 1 pixel off the expected `1x×2` size in either axis
 * (or both), pad/crop the right/bottom edge so the dims match, and return the
 * fixed bytes. Returns the original bytes if no fix is needed; returns `null`
 * if the mismatch is larger than 1 px on either axis (validator will report it)
 * or if the PNG isn't in a format we can rewrite.
 */
function fixRetinaOffByOne(retina2x: Uint8Array, expectedW: number, expectedH: number): Uint8Array | null {
  const dims = readPngDims(retina2x);
  const dW = expectedW - dims.width;
  const dH = expectedH - dims.height;
  if (dW === 0 && dH === 0) return retina2x;
  if (dW < -1 || dW > 1 || dH < -1 || dH > 1) return null;
  return resizePngByEdge(retina2x, expectedW, expectedH);
}

/**
 * Mutate `b.light2x` and (if present) `b.dark2x` in place to fix off-by-1
 * mismatches against their respective 1x dimensions. Returns one human-
 * readable line per variant that was actually rewritten; an empty array
 * means no correction was needed (or the mismatch was too large to fix and
 * `validateImagesetSizes` will reject it).
 */
function normalizeImagesetRetina(b: ImagesetBuffer): string[] {
  const fixes: string[] = [];

  const l1 = readPngDims(b.light1x);
  const oldL2 = readPngDims(b.light2x);
  const fixedLight2x = fixRetinaOffByOne(b.light2x, l1.width * 2, l1.height * 2);
  if (fixedLight2x !== null && fixedLight2x !== b.light2x) {
    fixes.push(
      `  ${b.lightPath} (light): 2x was ${oldL2.width}×${oldL2.height}, ` +
      `corrected to ${l1.width * 2}×${l1.height * 2}`,
    );
    b.light2x = fixedLight2x;
  }

  if (b.dark1x && b.dark2x) {
    const d1 = readPngDims(b.dark1x);
    const oldD2 = readPngDims(b.dark2x);
    const fixedDark2x = fixRetinaOffByOne(b.dark2x, d1.width * 2, d1.height * 2);
    if (fixedDark2x !== null && fixedDark2x !== b.dark2x) {
      const darkLabel = b.darkPath ? `${b.darkPath} (dark)` : `${b.lightPath} (dark variant)`;
      fixes.push(
        `  ${darkLabel}: 2x was ${oldD2.width}×${oldD2.height}, ` +
        `corrected to ${d1.width * 2}×${d1.height * 2}`,
      );
      b.dark2x = fixedDark2x;
    }
  }

  return fixes;
}

// ── ASCII-only encoder (TextEncoder is unavailable in Figma's plugin sandbox) ─

function asciiBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// ── Swift codegen helpers ────────────────────────────────────────────────────

/** snake_case / kebab-case → lowerCamelCase. Empty → "unnamed". */
function toLowerCamel(s: string): string {
  const parts = s.split(/[_\-]+/).filter(p => p.length > 0);
  if (parts.length === 0) return 'unnamed';
  const head = parts[0].toLowerCase();
  const tail = parts.slice(1)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('');
  return head + tail;
}

/** Folder-name → Swift case-name path segment: alphanumerics only, lowercased. */
function toCasePathSegment(s: string): string {
  const t = s.replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return t || 'unnamed';
}

/** Prepend "_" if the identifier starts with a digit (Swift identifier rules). */
function safeSwiftIdent(s: string): string {
  return /^[0-9]/.test(s) ? '_' + s : s;
}

function buildSwiftCaseName(pathSegments: string[], leafCamel: string): string {
  const parts = [...pathSegments, leafCamel].filter(p => p.length > 0);
  return safeSwiftIdent(parts.join('_'));
}

interface SwiftEnumEntry { caseName: string; rawValue: string; }

function buildSwiftFile(setName: string, entries: SwiftEnumEntry[]): Uint8Array {
  const enumName = `${setName}FigmaImageAssets`;
  // Namespace prefix is lowercased so disk filenames look like nk_common_aiState
  // even when the SetName is "Common". Must match diskLeafPrefix in emitOutputBundle.
  const imageNameBody = setName
    ? `"nk_${setName.toLowerCase()}_\\(rawValue)"`
    : `"nk_\\(rawValue)"`;
  const lines: string[] = [];
  lines.push('import AppKit');
  lines.push('');
  lines.push(`enum ${enumName}: String, CaseIterable {`);
  lines.push('');
  for (const e of entries) lines.push(`    case ${e.caseName} = "${e.rawValue}"`);
  if (entries.length > 0) lines.push('');
  lines.push(`    var imageName: String { ${imageNameBody} }`);
  lines.push('');
  lines.push('    var image: NSImage? {');
  lines.push('        if let url = Bundle.main.url(forResource: self.imageName, withExtension: "png") {');
  lines.push('            return NSImage(contentsOf: url)');
  lines.push('        }');
  lines.push('        return NSImage(named: self.imageName)');
  lines.push('    }');
  lines.push('');
  lines.push('    static func debugExistanceCheck() {');
  lines.push('        Self.allCases.forEach {');
  lines.push('            assert($0.image != nil)');
  lines.push('        }');
  lines.push('    }');
  lines.push('');
  lines.push('}');
  lines.push('');
  return asciiBytes(lines.join('\n'));
}

// ── Imageset buffers ─────────────────────────────────────────────────────────

interface ImagesetBuffer {
  leafCamel: string;       // lowerCamelCase form of original leaf — Swift raw value & disk-leaf base
  pathSegments: string[];  // lowercased Figma-ancestor names for Swift case name; empty in tagged mode
  folderPath: string[];    // case-preserving sanitized folder names for placement INSIDE .xcassets; empty in tagged mode
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

/**
 * Emit the full output bundle: wrapper folder + .swift file + .xcassets bundle
 * with all imagesets (flat at the bundle root, prefixed with `nk_<SetName>_`).
 *
 * When setName is empty: wrapper / file / enum drop the prefix; disk-leaf prefix
 * collapses to just `nk_` (no double underscore).
 */
function emitOutputBundle(buffers: ImagesetBuffer[], setName: string): void {
  const bundleName     = `${setName}FigmaImageAssets`;
  const wrapperPath    = `${bundleName}/`;
  const xcassetsPath   = `${wrapperPath}${bundleName}.xcassets/`;
  const swiftPath      = `${wrapperPath}${bundleName}.swift`;
  // SetName is lowercased in the namespace prefix (e.g. SetName "Common" → "nk_common_<leaf>").
  // The wrapper folder, .swift filename, and enum name keep the original case.
  const diskLeafPrefix = setName ? `nk_${setName.toLowerCase()}_` : 'nk_';

  const groupJson = asciiBytes(JSON.stringify({ info: { author: 'xcode', version: 1 } }, null, 2));

  // Collect every unique folder under .xcassets (root + every prefix path) so
  // each gets its own group-level Contents.json. Folders default to no
  // namespace, so NSImage(named: leaf) still resolves the imageset regardless
  // of which folder it's in.
  const folderPaths = new Set<string>(['']); // '' = .xcassets root
  for (const b of buffers) {
    const accum: string[] = [];
    for (const seg of b.folderPath) {
      accum.push(seg);
      folderPaths.add(accum.join('/'));
    }
  }
  for (const f of folderPaths) {
    sendFile(`${xcassetsPath}${f}${f ? '/' : ''}Contents.json`, groupJson);
  }

  // Each imageset placed under its folderPath inside .xcassets.
  for (const b of buffers) {
    const diskLeaf = diskLeafPrefix + b.leafCamel;
    const folder   = b.folderPath.length > 0 ? b.folderPath.join('/') + '/' : '';
    const dir      = `${xcassetsPath}${folder}${diskLeaf}.imageset/`;
    const hasDark  = b.dark1x !== null;
    sendFile(dir + `${diskLeaf}.png`,    b.light1x);
    sendFile(dir + `${diskLeaf}@2x.png`, b.light2x);
    if (hasDark) {
      sendFile(dir + `${diskLeaf}~dark.png`,    b.dark1x!);
      sendFile(dir + `${diskLeaf}~dark@2x.png`, b.dark2x!);
    }
    sendFile(dir + 'Contents.json', buildContentsJson(diskLeaf, hasDark));
  }

  // Swift enum file (always emitted, even if entries is empty).
  const entries: SwiftEnumEntry[] = buffers.map(b => ({
    caseName: buildSwiftCaseName(b.pathSegments, b.leafCamel),
    rawValue: b.leafCamel,
  }));
  sendFile(swiftPath, buildSwiftFile(setName, entries));

  // Cached image sizes — sibling to the .xcassets. Keyed by lowercased Swift
  // case name → light-1x { width, height }. Sorted by key, pretty-printed.
  const cachePath = `${wrapperPath}${bundleName}_images_sizes.json`;
  const sizeByKey: Record<string, { width: number; height: number }> = {};
  for (let i = 0; i < buffers.length; i++) {
    const dims = readPngDims(buffers[i].light1x);
    sizeByKey[entries[i].caseName.toLowerCase()] = { width: dims.width, height: dims.height };
  }
  const sortedSizes: Record<string, { width: number; height: number }> = {};
  for (const k of Object.keys(sizeByKey).sort()) sortedSizes[k] = sizeByKey[k];
  sendFile(cachePath, asciiBytes(JSON.stringify(sortedSizes, null, 2)));
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
  const darkCollections = findAllDarkModeCollections();
  const usesDarkScheme  = hasDarkScheme();

  if ((darkCollections.length === 0 && !usesDarkScheme) || !('clone' in node)) return null;

  const clone = (node as SceneNode & { clone(): SceneNode }).clone();
  const cloneId = clone.id;
  orphanCloneIds.push(cloneId);

  try {
    let darkReady = false;

    // Approach A — switch every variable collection to its Dark mode
    if (darkCollections.length > 0 && 'setExplicitVariableModeForCollection' in clone) {
      for (const info of darkCollections) {
        (clone as FrameNode).setExplicitVariableModeForCollection(info.collection, info.darkModeId);
      }
      darkReady = true;
    }

    // Approach B — swap Light/… paint styles and variable bindings → Dark/… (additive with A)
    if (usesDarkScheme) {
      const swapped = applyDarkBindings(clone);
      if (swapped) darkReady = true;
    }

    if (!darkReady) return null;

    const [d1x, d2x] = await Promise.all([
      clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
      clone.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } }),
    ]);
    if (bytesEqual(light1x, d1x)) return null;

    return { dark1x: d1x, dark2x: d2x };
  } finally {
    removeClone(cloneId);
  }
}

// ── Build one imageset (tagged mode — flat output) ───────────────────────────

async function buildTaggedImageset(node: SceneNode, imageName: string): Promise<ImagesetBuffer> {
  const leafCamel = toLowerCamel(sanitizeName(imageName));
  const [light1x, light2x] = await Promise.all([
    node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
    node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } }),
  ]);
  const dark = await renderDarkViaVariables(node, light1x);
  return {
    leafCamel,
    pathSegments: [], // tagged mode has no folder hierarchy
    folderPath: [],
    light1x, light2x,
    dark1x: dark?.dark1x ?? null,
    dark2x: dark?.dark2x ?? null,
    lightPath: getNodeFullPath(node),
    darkPath: null, // dark came from a variable-swap clone of `node`
  };
}

// ── Page-export mode ─────────────────────────────────────────────────────────

const PAGE_EXPORT_PREFIX = 'img_exp/';
const DARK_SUFFIX  = '-dark';
const LIGHT_SUFFIX = '-light';

/**
 * Naming scheme for an `img_exp/` candidate:
 *   - `light-implicit` — no suffix (e.g. `img_exp/foo`); dark is optional, may
 *     fall back to variable-swap if no `-dark` sibling exists.
 *   - `light-explicit` — `-light` suffix (e.g. `img_exp/foo-light`); a `-dark`
 *     sibling is REQUIRED — no fallback.
 *   - `dark`           — `-dark` suffix; must have a matching light counterpart
 *     (either implicit or explicit).
 *
 * `coreName` is the node name with the `img_exp/` prefix and the kind-suffix
 * (if any) both stripped. It's the key that pairs lights with darks and
 * defines the final imageset name (after sanitization).
 */
type CandidateKind = 'light-implicit' | 'light-explicit' | 'dark';

interface PageExportCandidate {
  node: SceneNode;
  fullName: string;  // e.g. "img_exp/foo-light" — exact node name as in Figma
  kind: CandidateKind;
  coreName: string;  // e.g. "foo" — pairing key & basis for final imageset name
}

function classifyCandidate(node: SceneNode): PageExportCandidate {
  const fullName = node.name;
  const afterPrefix = fullName.slice(PAGE_EXPORT_PREFIX.length);
  if (afterPrefix.endsWith(DARK_SUFFIX)) {
    return { node, fullName, kind: 'dark',
             coreName: afterPrefix.slice(0, -DARK_SUFFIX.length) };
  }
  if (afterPrefix.endsWith(LIGHT_SUFFIX)) {
    return { node, fullName, kind: 'light-explicit',
             coreName: afterPrefix.slice(0, -LIGHT_SUFFIX.length) };
  }
  return { node, fullName, kind: 'light-implicit', coreName: afterPrefix };
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
        out.push(classifyCandidate(child));
      } else if ('children' in child) {
        walk(child as BaseNode & ChildrenMixin);
      }
    }
  }
  walk(figma.currentPage);
  return out;
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
  const leafCamel    = toLowerCamel(sanitizePagePart(imageName));
  const pathSegments = folderPath.map(toCasePathSegment); // lowercased — for Swift case name

  let light1x: Uint8Array;
  let light2x: Uint8Array;
  let dark1x: Uint8Array | null = null;
  let dark2x: Uint8Array | null = null;

  if (darkNode) {
    // Explicit -dark sibling — all four exports are independent, so kick them
    // off together.
    [light1x, light2x, dark1x, dark2x] = await Promise.all([
      lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
      lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } }),
      darkNode.exportAsync({  format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
      darkNode.exportAsync({  format: 'PNG', constraint: { type: 'SCALE', value: 2 } }),
    ]);
  } else {
    [light1x, light2x] = await Promise.all([
      lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }),
      lightNode.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } }),
    ]);
    const dark = await renderDarkViaVariables(lightNode, light1x);
    if (dark) { dark1x = dark.dark1x; dark2x = dark.dark2x; }
  }

  return {
    leafCamel,
    pathSegments,
    folderPath, // case-preserving — for placement inside .xcassets
    light1x, light2x,
    dark1x, dark2x,
    lightPath: getNodeFullPath(lightNode),
    darkPath: darkNode ? getNodeFullPath(darkNode) : null,
  };
}

// ── Bounded-concurrency map ──────────────────────────────────────────────────
//
// Process `items` with up to `limit` async invocations of `fn` running
// concurrently. Returns a results array in the same order as the input. Used
// to fan out per-imageset export jobs without overwhelming Figma's renderer
// with hundreds of simultaneous exportAsync + clone operations.
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return results;
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
      purgeOrphanClones();
      const images = syncRegistry();
      const toExport = images.filter(e => {
        const n = figma.getNodeById(e.nodeId);
        return n && isOnCurrentPage(n);
      });

      let failed = 0;
      const settled = await mapWithConcurrency(toExport, 8, async (entry) => {
        try {
          const node = figma.getNodeById(entry.nodeId) as SceneNode;
          return await buildTaggedImageset(node, entry.name);
        } catch (err) {
          console.error(`Export failed for "${entry.name}":`, err);
          failed++;
          return null;
        }
      });
      const buffers: ImagesetBuffer[] = settled.filter((b): b is ImagesetBuffer => b !== null);

      const retinaFixes: string[] = [];
      for (const b of buffers) retinaFixes.push(...normalizeImagesetRetina(b));
      const sizeErrors: string[] = [];
      for (const b of buffers) sizeErrors.push(...validateImagesetSizes(b));
      if (sizeErrors.length > 0) {
        figma.ui.postMessage({
          type: 'exportError',
          message: ['Image size validation failed:', ...sizeErrors].join('\n'),
        } as CodeToUI);
        break;
      }

      emitOutputBundle(buffers, msg.setName);
      figma.ui.postMessage({
        type: 'exportDone', exported: buffers.length, failed, mode: 'tagged',
        retinaFixes,
      } as CodeToUI);
      break;
    }

    case 'exportPage': {
      purgeOrphanClones();
      const candidates = collectPageExportCandidates();

      // Group candidates by their pairing key (coreName) so we can validate
      // light/dark companionship and build jobs in a single pass.
      interface Group { lights: PageExportCandidate[]; darks: PageExportCandidate[]; }
      const byCore = new Map<string, Group>();
      for (const c of candidates) {
        let g = byCore.get(c.coreName);
        if (!g) { g = { lights: [], darks: [] }; byCore.set(c.coreName, g); }
        if (c.kind === 'dark') g.darks.push(c);
        else g.lights.push(c);
      }

      // Orphan-dark check — a -dark candidate must have at least one light
      // counterpart (implicit OR -light explicit) sharing its coreName.
      const darkOrphans: SceneNode[] = [];
      // Orphan-light check — a -light candidate must have a -dark counterpart.
      const lightOrphans: SceneNode[] = [];
      for (const g of byCore.values()) {
        if (g.darks.length > 0 && g.lights.length === 0) {
          for (const d of g.darks) darkOrphans.push(d.node);
        }
        if (g.darks.length === 0) {
          for (const l of g.lights) {
            if (l.kind === 'light-explicit') lightOrphans.push(l.node);
          }
        }
      }
      if (darkOrphans.length > 0) {
        const lines = ['Dark layers without a light counterpart:'];
        for (const n of darkOrphans) lines.push(`  ${getNodeFullPath(n)}`);
        figma.ui.postMessage({ type: 'exportError', message: lines.join('\n') } as CodeToUI);
        break;
      }
      if (lightOrphans.length > 0) {
        const lines = ['Light layers without a dark counterpart:'];
        for (const n of lightOrphans) lines.push(`  ${getNodeFullPath(n)}`);
        figma.ui.postMessage({ type: 'exportError', message: lines.join('\n') } as CodeToUI);
        break;
      }

      // Build jobs from light candidates only. Each light is paired with the
      // -dark in its group (if any). Dark candidates never become jobs themselves.
      interface Job {
        light: SceneNode;
        dark: SceneNode | null;
        finalName: string;
        folder: string[];
      }
      const jobs: Job[] = [];
      for (const g of byCore.values()) {
        const darkNode = g.darks[0]?.node ?? null; // grouping guarantees ≤ 1 dark per coreName in well-formed input; if more, dupe-check fires below
        for (const l of g.lights) {
          jobs.push({
            light: l.node,
            dark: darkNode,
            finalName: sanitizePagePart(l.coreName),
            folder: getPagePath(l.node),
          });
        }
      }

      // Duplicate detection — by leafCamel (the actual on-disk imageset key,
      // before the nk_<SetName>_ prefix). This catches: (a) `foo` and `foo-light`
      // co-existing, (b) any two unrelated candidates collapsing to the same
      // camelCase, (c) two -dark variants for one core.
      const byLeafCamel = new Map<string, SceneNode[]>();
      const keyFor = (coreName: string) => toLowerCamel(sanitizePagePart(coreName));
      for (const j of jobs) {
        const k = keyFor(j.finalName);
        const arr = byLeafCamel.get(k) ?? [];
        arr.push(j.light);
        byLeafCamel.set(k, arr);
      }
      // Also surface "two -dark candidates for the same core" as a duplicate.
      for (const g of byCore.values()) {
        if (g.darks.length > 1) {
          const k = keyFor(g.darks[0].coreName);
          const arr = byLeafCamel.get(k) ?? [];
          for (let i = 1; i < g.darks.length; i++) arr.push(g.darks[i].node);
          byLeafCamel.set(k, arr);
        }
      }
      const dupeEntries = [...byLeafCamel.entries()].filter(([, nodes]) => nodes.length > 1);
      if (dupeEntries.length > 0) {
        const lines = ['Duplicate image names:'];
        for (const [name, nodes] of dupeEntries) {
          lines.push(`  "${name}":`);
          for (const n of nodes) lines.push(`    ${getNodeFullPath(n)}`);
        }
        figma.ui.postMessage({ type: 'exportError', message: lines.join('\n') } as CodeToUI);
        break;
      }

      let failed = 0;
      const settled = await mapWithConcurrency(jobs, 8, async (job) => {
        try {
          return await buildPageImageset(job.light, job.dark, job.finalName, job.folder);
        } catch (err) {
          console.error(`Page export failed for "${job.finalName}":`, err);
          failed++;
          return null;
        }
      });
      const buffers: ImagesetBuffer[] = settled.filter((b): b is ImagesetBuffer => b !== null);

      const retinaFixes: string[] = [];
      for (const b of buffers) retinaFixes.push(...normalizeImagesetRetina(b));
      const sizeErrors: string[] = [];
      for (const b of buffers) sizeErrors.push(...validateImagesetSizes(b));
      if (sizeErrors.length > 0) {
        figma.ui.postMessage({
          type: 'exportError',
          message: ['Image size validation failed:', ...sizeErrors].join('\n'),
        } as CodeToUI);
        break;
      }

      emitOutputBundle(buffers, msg.setName);
      // Page mode always produces a ZIP, even when empty (per spec).
      figma.ui.postMessage({
        type: 'exportDone', exported: buffers.length, failed, mode: 'page',
        retinaFixes,
      } as CodeToUI);
      break;
    }

  }
};
