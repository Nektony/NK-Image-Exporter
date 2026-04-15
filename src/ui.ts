import { ImageEntry, UIToCode, CodeToUI, PluginState } from './types';

// ── SVG icons ────────────────────────────────────────────────────────────────

const ICON_FOCUS = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/>
  <circle cx="7" cy="7" r="1.5" fill="currentColor"/>
  <line x1="7" y1="0.5" x2="7" y2="2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="7" y1="11.8" x2="7" y2="13.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="0.5" y1="7" x2="2.2" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="11.8" y1="7" x2="13.5" y2="7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

const ICON_REMOVE = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
  <line x1="1.5" y1="1.5" x2="10.5" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <line x1="10.5" y1="1.5" x2="1.5" y2="10.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

// ── State ────────────────────────────────────────────────────────────────────

let state: PluginState = {
  images: [],
  selectionCount: 0,
  selectedNodeId: null,
  selectedLayerName: null,
  isMarked: false,
  markedName: null,
  currentPageCount: 0,
};

let searchQuery = '';
let renamingNodeId: string | null = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────

const noSelection     = document.getElementById('no-selection')!;
const multiSelection  = document.getElementById('multi-selection')!;
const selectionContent = document.getElementById('selection-content')!;
const layerNameEl     = document.getElementById('layer-name')!;
const imageNameInput  = document.getElementById('image-name-input') as HTMLInputElement;
const markBtn         = document.getElementById('mark-btn') as HTMLButtonElement;
const unmarkBtn       = document.getElementById('unmark-btn') as HTMLButtonElement;
const selectionError  = document.getElementById('selection-error')!;

const listTitle   = document.getElementById('list-title')!;
const searchInput = document.getElementById('search-input') as HTMLInputElement;
const imageList   = document.getElementById('image-list')!;
const emptyList   = document.getElementById('empty-list')!;

const exportBtn    = document.getElementById('export-btn') as HTMLButtonElement;
const exportStatus = document.getElementById('export-status')!;

// ── Messaging ────────────────────────────────────────────────────────────────

function send(msg: UIToCode): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

window.onmessage = (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as CodeToUI | undefined;
  if (!msg) return;

  switch (msg.type) {
    case 'state':
      applyState(msg);
      break;
    case 'exportFile':
      downloadFile(msg.fileName, msg.bytes);
      break;
    case 'exportDone':
      onExportDone(msg.exported, msg.failed);
      break;
    case 'error':
      showError(msg.message);
      break;
  }
};

// ── State application ────────────────────────────────────────────────────────

function applyState(newState: PluginState & { type: 'state' }): void {
  state = newState;
  renderSelection();
  renderList();
  renderFooter();
}

// ── Selection panel ───────────────────────────────────────────────────────────

function renderSelection(): void {
  clearError();

  const { selectionCount, selectedLayerName, isMarked, markedName } = state;

  noSelection.classList.toggle('hidden', selectionCount !== 0);
  multiSelection.classList.toggle('hidden', selectionCount <= 1);
  selectionContent.classList.toggle('hidden', selectionCount !== 1);

  if (selectionCount !== 1) return;

  layerNameEl.textContent = selectedLayerName ?? '';

  if (isMarked) {
    imageNameInput.value = markedName ?? '';
    markBtn.textContent = 'Update Name';
    unmarkBtn.classList.remove('hidden');
  } else {
    imageNameInput.value = selectedLayerName ?? '';
    markBtn.textContent = 'Mark as Image';
    unmarkBtn.classList.add('hidden');
  }
}

function showError(msg: string): void {
  selectionError.textContent = msg;
  selectionError.classList.remove('hidden');
}

function clearError(): void {
  selectionError.textContent = '';
  selectionError.classList.add('hidden');
}

// ── Image list ────────────────────────────────────────────────────────────────

function renderList(): void {
  const q = searchQuery.toLowerCase();
  const filtered = state.images.filter(img => img.name.toLowerCase().includes(q));

  const count = state.images.length;
  listTitle.textContent = `Images${count > 0 ? ` (${count})` : ''}`;

  if (count === 0) {
    imageList.innerHTML = '';
    imageList.classList.add('hidden');
    emptyList.classList.remove('hidden');
    return;
  }

  emptyList.classList.add('hidden');
  imageList.classList.remove('hidden');

  if (filtered.length === 0) {
    imageList.innerHTML = '<div class="hint">No results</div>';
    return;
  }

  // Rebuild DOM
  imageList.innerHTML = '';
  for (const img of filtered) {
    imageList.appendChild(buildListItem(img));
  }
}

function buildListItem(img: ImageEntry): HTMLElement {
  const item = document.createElement('div');
  item.className = 'list-item';
  item.dataset.id = img.nodeId;

  // Name / rename input
  const nameWrap = document.createElement('div');
  nameWrap.className = 'item-name-wrap';

  if (renamingNodeId === img.nodeId) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'item-rename-input';
    input.value = img.name;

    let committed = false;

    const commit = () => {
      if (committed) return;
      committed = true;
      commitRename(img.nodeId, input.value);
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
    });
    input.addEventListener('blur', commit);

    nameWrap.appendChild(input);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  } else {
    const span = document.createElement('span');
    span.className = 'item-name';
    span.textContent = img.name;
    span.title = 'Click to rename';
    span.addEventListener('click', () => startRename(img.nodeId));
    nameWrap.appendChild(span);
  }

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'item-actions';

  const focusBtn = document.createElement('button');
  focusBtn.className = 'icon-btn';
  focusBtn.title = 'Scroll to layer';
  focusBtn.innerHTML = ICON_FOCUS;
  focusBtn.addEventListener('mousedown', (e) => e.preventDefault()); // prevent blur on rename input
  focusBtn.addEventListener('click', () => send({ type: 'focus', nodeId: img.nodeId }));

  const removeBtn = document.createElement('button');
  removeBtn.className = 'icon-btn danger';
  removeBtn.title = 'Remove from images';
  removeBtn.innerHTML = ICON_REMOVE;
  removeBtn.addEventListener('mousedown', (e) => e.preventDefault());
  removeBtn.addEventListener('click', () => send({ type: 'unmark', nodeId: img.nodeId }));

  actions.appendChild(focusBtn);
  actions.appendChild(removeBtn);

  item.appendChild(nameWrap);
  item.appendChild(actions);

  return item;
}

function startRename(nodeId: string): void {
  renamingNodeId = nodeId;
  renderList();
}

function cancelRename(): void {
  renamingNodeId = null;
  renderList();
}

function commitRename(nodeId: string, raw: string): void {
  renamingNodeId = null;
  const trimmed = raw.trim();

  if (!trimmed) { renderList(); return; }

  const existing = state.images.find(img => img.nodeId === nodeId);
  if (existing && existing.name === trimmed) { renderList(); return; }

  // Optimistic update so the UI doesn't flash the old name
  if (existing) existing.name = trimmed;
  renderList();

  send({ type: 'rename', nodeId, newName: trimmed });
}

// ── Footer ────────────────────────────────────────────────────────────────────

function renderFooter(): void {
  const n = state.currentPageCount;
  exportBtn.disabled = n === 0;
  exportBtn.textContent = n > 0
    ? `Export ${n} image${n !== 1 ? 's' : ''} from this page`
    : 'No images on this page';
}

// ── Export / download ─────────────────────────────────────────────────────────

function downloadFile(fileName: string, bytes: number[]): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function onExportDone(exported: number, failed: number): void {
  renderFooter(); // restore button text
  exportBtn.disabled = state.currentPageCount === 0;

  exportStatus.classList.remove('hidden', 'success', 'warning');

  if (failed > 0) {
    exportStatus.textContent = `Done — ${exported} exported, ${failed} failed`;
    exportStatus.classList.add('warning');
  } else {
    exportStatus.textContent = `${exported} image${exported !== 1 ? 's' : ''} saved to Downloads`;
    exportStatus.classList.add('success');
  }

  setTimeout(() => exportStatus.classList.add('hidden'), 4000);
}

// ── Event listeners ───────────────────────────────────────────────────────────

markBtn.addEventListener('click', () => {
  const name = imageNameInput.value.trim();
  if (!name) { showError('Please enter an image name'); return; }

  if (state.isMarked && state.selectedNodeId) {
    send({ type: 'rename', nodeId: state.selectedNodeId, newName: name });
  } else {
    send({ type: 'mark', name });
  }
});

unmarkBtn.addEventListener('click', () => {
  if (state.selectedNodeId) send({ type: 'unmark', nodeId: state.selectedNodeId });
});

imageNameInput.addEventListener('input', clearError);

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value;
  renderList();
});

exportBtn.addEventListener('click', () => {
  exportBtn.disabled = true;
  exportBtn.textContent = 'Exporting…';
  exportStatus.classList.add('hidden');
  send({ type: 'export' });
});

// ── Init ──────────────────────────────────────────────────────────────────────

send({ type: 'getState' });
