
// Verify the mediabunny demux path in Node (no WebCodecs needed for probing).
import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { readFileSync } from 'node:fs';

const buf = readFileSync('/Users/jonwenjen/.hermes/cache/scratch/t.mp4');
const file = new File([buf], 't.mp4', { type: 'video/mp4' });
const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
console.log('video track:', !!track);
if (track) {
  console.log('  size', track.displayWidth + 'x' + track.displayHeight, 'codec', track.codec);
  console.log('  duration', (await track.computeDuration()).toFixed(2), 's');
}
const audio = await input.getPrimaryAudioTrack();
console.log('audio track:', !!audio, audio ? 'codec ' + audio.codec : '');
