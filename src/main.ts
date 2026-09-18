import './style.css';
import type { ConvertOptions, ConvertStats, EntityKind, UnitName } from './convert.ts';
import type { ConvertRequest, ConvertResponse } from './worker.ts';

const fileInput = element<HTMLInputElement>('file');
const zUpInput = element<HTMLInputElement>('zup');
const statusLine = element<HTMLParagraphElement>('status');
const titleBlock = element<HTMLTableElement>('title-block');
const downloadLink = document.createElement('a');
downloadLink.className = 'button download';
downloadLink.hidden = true;
element('title-block').after(downloadLink);
const fields = {
  drawing: element('tb-drawing'),
  source: element('tb-source'),
  layers: element('tb-layers'),
  triangles: element('tb-triangles'),
  entities: element('tb-entities'),
  format: element('tb-format'),
};

const versionLine = element('version');
versionLine.textContent = `Version ${import.meta.env.VITE_APP_VERSION}`;

const sourceUrl = import.meta.env.VITE_SOURCE_URL as string | undefined;
if (sourceUrl) {
  // The GPL asks that people who get the page can also get its source.
  const link = document.createElement('a');
  link.href = sourceUrl;
  link.textContent = 'Get this page’s source code.';
  versionLine.append(' ', link);
}

const numbers = new Intl.NumberFormat();
const BASE_FORMAT = 'AutoCAD 2000 DWG';
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });

let current: { file: File; glb: ArrayBuffer } | undefined;
let latestRequest = 0;
let downloadUrl: string | undefined;
let pendingAutoDownload = false;

worker.addEventListener('message', (event: MessageEvent<ConvertResponse>) => {
  const response = event.data;
  // Ignore results superseded by a newer file or option change.
  if (response.id !== latestRequest || !current) return;
  setBusy(false);

  if (response.ok) {
    showResult(current.file, response.dwg, response.stats, pendingAutoDownload);
  } else {
    clearResult();
    const advice = response.fileProblem
      ? ''
      : ' Try the 3D faces option, or reload the page and try again.';
    setStatus(`${response.message}${advice}`, 'error');
  }
  pendingAutoDownload = false;
});

worker.addEventListener('error', (event) => {
  setBusy(false);
  clearResult();
  setStatus(`The converter failed to start: ${event.message || 'unknown error'}.`, 'error');
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void openFile(file);
  // Let the same file be chosen again after an error.
  fileInput.value = '';
});

for (const input of document.querySelectorAll<HTMLInputElement>('.options input')) {
  input.addEventListener('change', () => {
    if (current) convert(false);
  });
}

document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  document.body.classList.add('dragging');
});

document.addEventListener('dragleave', (event) => {
  if (event.relatedTarget === null) document.body.classList.remove('dragging');
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  document.body.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file) void openFile(file);
});

async function openFile(file: File): Promise<void> {
  if (!/\.glb$/i.test(file.name)) {
    setStatus(`${file.name} isn't a .glb file. Choose a binary glTF model.`, 'error');
    return;
  }
  setStatus(`Reading ${file.name}…`);
  try {
    current = { file, glb: await file.arrayBuffer() };
  } catch {
    current = undefined;
    setStatus(`${file.name} couldn't be read. Check that the file is still there.`, 'error');
    return;
  }
  convert(true);
}

function convert(autoDownload: boolean): void {
  if (!current) return;
  pendingAutoDownload = autoDownload;
  latestRequest++;

  setBusy(true);
  setStatus(`Converting ${current.file.name}…`);

  // Send a copy so the original stays available when options change.
  const glb = current.glb.slice(0);
  const request: ConvertRequest = { id: latestRequest, glb, options: readOptions() };
  worker.postMessage(request, [glb]);
}

function readOptions(): ConvertOptions {
  const entity = document.querySelector<HTMLInputElement>('input[name="entity"]:checked');
  const units = document.querySelector<HTMLInputElement>('input[name="units"]:checked');
  return {
    entity: (entity?.value ?? '3dface') as EntityKind,
    yUpToZUp: zUpInput.checked,
    units: (units?.value ?? 'millimeters') as UnitName,
  };
}

function showResult(file: File, dwg: Uint8Array, stats: ConvertStats, autoDownload: boolean): void {
  const name = `${file.name.replace(/\.glb$/i, '') || 'model'}.dwg`;

  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(
    new Blob([dwg as Uint8Array<ArrayBuffer>], { type: 'application/acad' }),
  );
  downloadLink.href = downloadUrl;
  downloadLink.download = name;
  downloadLink.textContent = `Download ${name}`;
  downloadLink.hidden = false;

  const kind = readOptions().entity === 'polyface' ? 'polyface mesh' : '3D face';
  fields.drawing.textContent = name;
  fields.source.textContent = `${file.name}, ${formatBytes(file.size)}`;
  fields.layers.textContent = numbers.format(stats.layers);
  fields.triangles.textContent = numbers.format(stats.triangles);
  fields.entities.textContent = `${numbers.format(stats.entities)} ${plural(kind, stats.entities)}`;
  fields.format.textContent = `${BASE_FORMAT}, ${stats.units}`;

  titleBlock.classList.remove('filled');
  // Restart the fill-in animation on every new result.
  void titleBlock.offsetWidth;
  titleBlock.classList.add('filled');

  const skipped =
    stats.skippedPrimitives > 0
      ? ` ${numbers.format(stats.skippedPrimitives)} ${plural('point or line part', stats.skippedPrimitives)} left out.`
      : '';
  setStatus(`Converted to ${name}, ${formatBytes(dwg.byteLength)}.${skipped}`, 'done');

  if (autoDownload) downloadLink.click();
}

function clearResult(): void {
  for (const field of Object.values(fields)) field.textContent = '';
  // The format row states what the converter writes, so it stands even
  // before a drawing exists.
  fields.format.textContent = BASE_FORMAT;
  titleBlock.classList.remove('filled');
  downloadLink.hidden = true;
}

function setStatus(message: string, tone: 'info' | 'done' | 'error' = 'info'): void {
  statusLine.textContent = message;
  statusLine.dataset.tone = tone;
}

function setBusy(busy: boolean): void {
  document.body.toggleAttribute('aria-busy', busy);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(word: string, count: number): string {
  if (count === 1) return word;
  return word.endsWith('mesh') ? `${word}es` : `${word}s`;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id} in index.html`);
  return found as T;
}
