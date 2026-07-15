import { invoke, isTauri } from './invoke';
import { Image as TauriImage } from '@tauri-apps/api/image';

const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/avif': 'avif',
};

const IMAGE_SAVE_EXTENSIONS = Array.from(new Set(Object.values(IMAGE_MIME_EXTENSIONS)));

type RemoteImageResponse = {
  data: string;
  mimeType: string;
};

function isHttpImageSource(src: string) {
  return /^https?:\/\//i.test(src.trim());
}

function isStoredMediaHttpSource(src: string) {
  try {
    const url = new URL(src.trim());
    return url.protocol === 'http:' && url.hostname === 'aqbot-media.localhost';
  } catch {
    return false;
  }
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function getMimeTypeFromDataUrl(src: string) {
  const match = src.match(/^data:([^;,]+)[;,]/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function getExtensionFromUrl(src: string) {
  try {
    const url = new URL(src);
    const match = url.pathname.match(/\.([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() ?? null;
  } catch {
    const match = src.split('?')[0]?.match(/\.([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() ?? null;
  }
}

function getExtensionForImage(src: string, mimeType?: string | null) {
  const normalizedMime = mimeType?.toLowerCase();
  if (normalizedMime && IMAGE_MIME_EXTENSIONS[normalizedMime]) {
    return IMAGE_MIME_EXTENSIONS[normalizedMime];
  }

  const dataMime = getMimeTypeFromDataUrl(src);
  if (dataMime && IMAGE_MIME_EXTENSIONS[dataMime]) {
    return IMAGE_MIME_EXTENSIONS[dataMime];
  }

  const urlExtension = getExtensionFromUrl(src);
  return urlExtension && IMAGE_SAVE_EXTENSIONS.includes(urlExtension) ? urlExtension : 'png';
}

function sanitizeFilenamePart(value: string) {
  const normalized = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'aqbot-image';
}

function ensureImageExtension(filename: string, src: string, mimeType?: string | null) {
  const extension = getExtensionForImage(src, mimeType);
  return /\.[a-z0-9]+$/i.test(filename) ? filename : `${filename}.${extension}`;
}

function browserDownloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function loadImageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to decode image.'));
    };
    image.src = url;
  });
}

function canvasToPngBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
        return;
      }
      reject(new Error('Failed to encode image.'));
    }, 'image/png');
  });
}

async function convertBlobToPng(blob: Blob) {
  if (blob.type === 'image/png') return blob;

  const image = await loadImageFromBlob(blob);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) {
    throw new Error('Image has no drawable size.');
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas is not available.');
  }
  context.drawImage(image, 0, 0, width, height);
  return canvasToPngBlob(canvas);
}

async function blobToBytes(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

export function getDefaultImageFilename(src: string, alt?: string | null) {
  const base = sanitizeFilenamePart(alt || 'aqbot-image');
  return ensureImageExtension(base, src, getMimeTypeFromDataUrl(src));
}

export async function resolveImageBlob(src: string) {
  if (!src) {
    throw new Error('Image source is empty.');
  }

  if (isTauri() && isHttpImageSource(src) && !isStoredMediaHttpSource(src)) {
    const response = await invoke<RemoteImageResponse>('fetch_remote_image', { url: src });
    return new Blob([base64ToBytes(response.data)], { type: response.mimeType });
  }

  const response = await fetch(src);
  if (!response.ok) {
    throw new Error(`Failed to fetch image: ${response.status}`);
  }

  const blob = await response.blob();
  const mimeType = blob.type || getMimeTypeFromDataUrl(src) || 'application/octet-stream';
  if (!mimeType.toLowerCase().startsWith('image/')) {
    throw new Error('The image source did not return an image.');
  }

  return blob.type ? blob : new Blob([await blob.arrayBuffer()], { type: mimeType });
}

export async function copyChatImage(src: string) {
  const sourceBlob = await resolveImageBlob(src);
  const pngBlob = await convertBlobToPng(sourceBlob);
  const pngBytes = await blobToBytes(pngBlob);

  if (isTauri()) {
    const { writeImage } = await import('@tauri-apps/plugin-clipboard-manager');
    const image = await TauriImage.fromBytes(pngBytes);
    await writeImage(image);
    return;
  }

  if (navigator.clipboard && typeof navigator.clipboard.write === 'function' && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return;
  }

  throw new Error('Image clipboard is not supported in this environment.');
}

export async function saveChatImage(src: string, defaultName = getDefaultImageFilename(src)) {
  const blob = await resolveImageBlob(src);
  const filename = ensureImageExtension(defaultName, src, blob.type);
  const bytes = await blobToBytes(blob);

  if (isTauri()) {
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const filePath = await save({
      defaultPath: filename,
      filters: [{ name: 'Images', extensions: IMAGE_SAVE_EXTENSIONS }],
    });
    if (!filePath) return false;

    await writeFile(filePath, bytes);
    return true;
  }

  browserDownloadBlob(filename, blob);
  return true;
}
