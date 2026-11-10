// s03e01 transcribe-media: speech-to-text for the pack's memo and recording, reusing the call
// s02e03 proved (OpenRouter, openai/whisper-large-v3, verbose_json with segment timestamps).
// Writes <name>.segments.json beside the output so citations can point at a second.
//
// Usage: node s03e01/transcribe-media.mjs s03e01/pack/memo.m4a [s03e01/pack/recording.mp4]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

const apiKey = process.env.OPENROUTER_API_KEY;
const files = process.argv.slice(2).filter((value) => !value.startsWith('--'));

if (!apiKey) {
  console.error('OPENROUTER_API_KEY is missing from .env');
  process.exitCode = 1;
} else if (files.length === 0) {
  console.error('usage: node s03e01/transcribe-media.mjs <media> [media...]');
  process.exitCode = 2;
} else {
  for (const file of files) {
    const absolute = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
    const buffer = fs.readFileSync(absolute);
    const extension = path.extname(absolute).toLowerCase();
    const mime = extension === '.mp4' ? 'video/mp4' : extension === '.m4a' ? 'audio/mp4' : 'audio/mpeg';
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), path.basename(absolute));
    form.append('model', 'openai/whisper-large-v3');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    const wantWords = process.argv.includes('--words');
    if (wantWords) {
      form.append('timestamp_granularities[]', 'word');
    }

    const started = Date.now();
    const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await res.text();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = null;
    }
    if (!res.ok) {
      console.log(JSON.stringify({ file: path.basename(absolute), status: res.status, error: body.slice(0, 300) }, null, 2));
      continue;
    }
    const segments = (payload?.segments ?? []).map((segment) => ({
      start: Number(Number(segment.start ?? 0).toFixed(2)),
      end: Number(Number(segment.end ?? 0).toFixed(2)),
      text: String(segment.text ?? '').trim(),
    }));
    const out = path.join(DIR, `${path.basename(absolute, extension)}.segments.json`);
    fs.writeFileSync(out, `${JSON.stringify({ file: path.basename(absolute), duration: payload?.duration, segments }, null, 2)}\n`, 'utf-8');
    if (wantWords && Array.isArray(payload?.words)) {
      const words = payload.words.map((word) => ({ start: Number(Number(word.start ?? 0).toFixed(2)), word: String(word.word ?? '').trim() }));
      fs.writeFileSync(path.join(DIR, `${path.basename(absolute, extension)}.words.json`), `${JSON.stringify({ file: path.basename(absolute), words }, null, 2)}\n`, 'utf-8');
    }
    console.log(
      JSON.stringify(
        { file: path.basename(absolute), status: res.status, duration: payload?.duration, segments: segments.length, out: path.basename(out), ms: Date.now() - started },
        null,
        2,
      ),
    );
  }
}
