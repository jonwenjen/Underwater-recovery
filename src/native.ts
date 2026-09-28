/**
 * Saving results inside the Android app (Capacitor). A WebView ignores
 * `<a download>`, so exports are written with the Filesystem plugin to
 * Documents/UnderwaterRecovery; if that folder is not writable the file goes
 * to the app cache and the share sheet opens (save to Photos, Drive, …).
 * Loaded only in the app (see `isNativeApp`), never on the website.
 */
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const FOLDER = 'UnderwaterRecovery';
/** A multiple of 3 bytes, so each chunk's base64 can be appended as-is. */
const CHUNK = 3 * 1024 * 1024;

const base64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(',') + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

/** Write in 3 MB pieces: a whole video as one base64 string would not fit in memory. */
async function write(blob: Blob, path: string, directory: Directory): Promise<string> {
  for (let o = 0; o < Math.max(1, blob.size); o += CHUNK) {
    const data = await base64(blob.slice(o, o + CHUNK));
    if (o === 0) await Filesystem.writeFile({ path, data, directory, recursive: true });
    else await Filesystem.appendFile({ path, data, directory });
  }
  return (await Filesystem.getUri({ path, directory })).uri;
}

/** Save `blob` as `name`; returns a line for the status bar. */
export async function saveNative(blob: Blob, name: string): Promise<string> {
  const path = `${FOLDER}/${name}`;
  try {
    await write(blob, path, Directory.Documents);
    return `已存到 文件/${path}`;
  } catch {
    const uri = await write(blob, path, Directory.Cache);
    await Share.share({ title: name, files: [uri] });
    return `已開啟分享：${name}`;
  }
}
