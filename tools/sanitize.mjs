#!/usr/bin/env node
/**
 * tools/sanitize.mjs - Layer 6: Deterministic Input Sanitization & Outbound Redaction Gate
 *
 * Implements Section 6 of AGENTS.md:
 * - Strips hidden HTML/CSS elements (display:none, opacity:0, font-size:0, hidden, comments).
 * - Strips zero-width/invisible Unicode characters and normalizes Cyrillic/Greek homoglyphs.
 * - Decodes embedded Base64 and Hex payloads in-flight to detect obfuscated prompt injections.
 * - Flags/neutralizes prompt injection signatures.
 * - Redacts outbound secrets, tickets, UUIDs, API keys, Bearer tokens, and local host paths.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ZERO_WIDTH_REGEX = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

const HOMOGLYPH_MAP = new Map([
  ['\u0430', 'a'], // Cyrillic а
  ['\u0410', 'A'], // Cyrillic А
  ['\u0435', 'e'], // Cyrillic е
  ['\u0415', 'E'], // Cyrillic Е
  ['\u0456', 'i'], // Cyrillic і
  ['\u0406', 'I'], // Cyrillic І
  ['\u043E', 'o'], // Cyrillic о
  ['\u041E', 'O'], // Cyrillic О
  ['\u0440', 'p'], // Cyrillic р
  ['\u0420', 'P'], // Cyrillic Р
  ['\u0441', 'c'], // Cyrillic с
  ['\u0421', 'C'], // Cyrillic С
  ['\u0443', 'y'], // Cyrillic у
  ['\u0423', 'Y'], // Cyrillic У
  ['\u0445', 'x'], // Cyrillic х
  ['\u0425', 'X'], // Cyrillic Х
  ['\u0455', 's'], // Cyrillic ѕ
  ['\u0405', 'S'], // Cyrillic Ѕ
  ['\u0458', 'j'], // Cyrillic ј
  ['\u03BF', 'o'], // Greek ο
  ['\u039F', 'O'], // Greek Ο
  ['\u03B1', 'a'], // Greek α
  ['\u03B5', 'e'], // Greek ε
]);

const HOMOGLYPH_REGEX = new RegExp(`[${Array.from(HOMOGLYPH_MAP.keys()).join('')}]`, 'g');

const HIDDEN_HTML_PATTERNS = [
  {
    name: 'html_comment',
    regex: /<!--[\s\S]*?-->/g,
  },
  {
    name: 'style_or_script_block',
    regex: /<(style|script|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi,
  },
  {
    name: 'hidden_attribute_element',
    regex: /<([a-z0-9]+)\b[^>]*\b(?:hidden|aria-hidden\s*=\s*["']?true["']?)[^>]*>[\s\S]*?<\/\1>/gi,
  },
  {
    name: 'hidden_css_element',
    regex:
      /<([a-z0-9]+)\b[^>]*\bstyle\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\.0+)?\b|font-size\s*:\s*0(?:px|em|rem|%)?\b|color\s*:\s*transparent)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
  },
];

const INJECTION_SIGNATURES = [
  {
    id: 'ignore_previous_instructions',
    regex: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|above|system)\s+(?:instructions|prompts|rules|directives)\b/i,
  },
  {
    id: 'system_override',
    regex: /\b(?:system\s+override|admin\s+mode|developer\s+mode|dan\s+mode|jailbreak\s+mode|unlock\s+restrictions)\b/i,
  },
  {
    id: 'new_system_prompt',
    regex: /\b(?:you\s+are\s+now\s+unrestricted|new\s+system\s+prompt|override\s+system\s+prompt|act\s+as\s+an\s+unfiltered)\b/i,
  },
  {
    id: 'secret_exfiltration',
    regex: /\b(?:print|reveal|exfiltrate|output|send|leak)\s+(?:all\s+|your\s+|the\s+)?(?:system\s+prompt|environment\s+variables|\.env|api\s+keys|megadev_key|megadev_ticket)\b/i,
  },
  {
    id: 'delimiter_injection',
    regex: /(?:<\|im_start\|>|<\|im_end\|>|\[INST\]|\[\/INST\]|###\s*System\s*:)/i,
  },
];

const OUTBOUND_REDACTION_RULES = [
  {
    name: 'megadev_ticket',
    regex: /\bv1\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_TICKET]',
  },
  {
    name: 'jwt_token',
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: '[REDACTED_JWT]',
  },
  {
    name: 'api_key',
    regex: /\b(?:sk-(?:or-v1-|proj-|live-|test-)?|ghp_|gho_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}\b/g,
    replacement: '[REDACTED_API_KEY]',
  },
  {
    name: 'bearer_token',
    regex: /\b(Bearer\s+)(?!\[REDACTED)[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: '$1[REDACTED_TOKEN]',
  },
  {
    name: 'uuid_key',
    regex: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: '[REDACTED_UUID]',
  },
  {
    name: 'windows_user_path',
    regex: /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`<>|]+/g,
    replacement: '[REDACTED_PATH]',
  },
  {
    name: 'unix_user_path',
    regex: /(?:^|(?<=\s|["'`]))\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/[^\s"'`<>|]+)*/g,
    replacement: '[REDACTED_PATH]',
  },
];

/**
 * Checks if a decoded UTF-8 string looks like printable human/ASCII text.
 */
function isPrintableAscii(str) {
  if (!str || str.length < 6) {
    return false;
  }
  let printable = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      printable++;
    }
  }
  return printable / str.length >= 0.9;
}

/**
 * Normalizes Unicode homoglyphs and strips invisible/zero-width characters.
 */
export function normalizeUnicode(text, threats = []) {
  let result = text.normalize('NFKC');

  if (ZERO_WIDTH_REGEX.test(result)) {
    threats.push('invisible_zero_width_chars');
    result = result.replace(ZERO_WIDTH_REGEX, '');
  }

  if (HOMOGLYPH_REGEX.test(result)) {
    threats.push('unicode_homoglyphs');
    result = result.replace(HOMOGLYPH_REGEX, (ch) => HOMOGLYPH_MAP.get(ch) ?? ch);
  }

  return result;
}

/**
 * Strips hidden HTML/CSS blocks used for indirect prompt injection.
 */
export function stripHiddenHtml(text, threats = []) {
  let result = text;
  for (const rule of HIDDEN_HTML_PATTERNS) {
    if (rule.regex.test(result)) {
      threats.push(`hidden_markup:${rule.name}`);
      result = result.replace(rule.regex, ' ');
    }
    rule.regex.lastIndex = 0;
  }
  return result;
}

/**
 * Finds and decodes suspicious Base64 or Hex chunks in text so downstream
 * signature scanners can inspect the decoded payload.
 */
export function decodeEmbeddedPayloads(text, threats = []) {
  let result = text;

  // 1. Hex sequences (e.g. 16+ hex chars representing ASCII bytes, or \xNN sequences)
  const hexEscapedRegex = /(?:\\x[0-9a-fA-F]{2}){6,}/g;
  result = result.replace(hexEscapedRegex, (match) => {
    const rawHex = match.replace(/\\x/g, '');
    const decoded = Buffer.from(rawHex, 'hex').toString('utf8');
    if (isPrintableAscii(decoded)) {
      threats.push('encoded_payload:hex_escaped');
      return `[DECODED_HEX: ${decoded}]`;
    }
    return match;
  });

  const contiguousHexRegex = /\b(?:0x)?([0-9a-fA-F]{16,})\b/g;
  result = result.replace(contiguousHexRegex, (match, hexPart) => {
    if (hexPart.length % 2 !== 0) {
      return match;
    }
    const decoded = Buffer.from(hexPart, 'hex').toString('utf8');
    if (isPrintableAscii(decoded) && /[a-zA-Z]{3,}/.test(decoded)) {
      threats.push('encoded_payload:hex');
      return `[DECODED_HEX: ${decoded}]`;
    }
    return match;
  });

  // 2. Base64 sequences (minimum 16 chars, valid padding)
  const base64Regex = /(?<![A-Za-z0-9+/=])([A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/g;
  result = result.replace(base64Regex, (match) => {
    if (match.length % 4 !== 0) {
      return match;
    }
    try {
      const buf = Buffer.from(match, 'base64');
      if (buf.toString('base64').replace(/=+$/, '') !== match.replace(/=+$/, '')) {
        return match;
      }
      const decoded = buf.toString('utf8');
      if (isPrintableAscii(decoded) && /\s/.test(decoded)) {
        threats.push('encoded_payload:base64');
        return `[DECODED_BASE64: ${decoded}]`;
      }
    } catch {
      // Ignore invalid base64
    }
    return match;
  });

  return result;
}

/**
 * Deterministic pre-processor for untrusted external text.
 *
 * @param {string} text - Raw input string
 * @param {object} [options] - Configuration options
 * @param {boolean} [options.neutralizeInjections=false] - Replace matched injection phrases with `[FILTERED_INJECTION]`
 * @returns {{ cleanText: string, isSuspicious: boolean, threats: string[], modified: boolean }}
 */
export function sanitizeInput(text, options = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('sanitizeInput expects a string input');
  }

  const { neutralizeInjections = false } = options;
  const rawThreats = [];

  // Step 1: Strip hidden HTML/CSS before inspecting text
  let working = stripHiddenHtml(text, rawThreats);

  // Step 2: Normalize Unicode homoglyphs & strip zero-width characters
  working = normalizeUnicode(working, rawThreats);

  // Step 3: Decode embedded Base64 / Hex payloads
  working = decodeEmbeddedPayloads(working, rawThreats);

  // Step 4: Normalize decoded content in case homoglyphs were Base64-encoded
  working = normalizeUnicode(working, rawThreats);

  // Step 5: Scan for prompt injection signatures
  for (const sig of INJECTION_SIGNATURES) {
    if (sig.regex.test(working)) {
      rawThreats.push(`prompt_injection:${sig.id}`);
      if (neutralizeInjections) {
        const globalRegex = new RegExp(sig.regex.source, `${sig.regex.flags.replace('g', '')}g`);
        working = working.replace(globalRegex, '[FILTERED_INJECTION]');
      }
    }
  }

  const threats = Array.from(new Set(rawThreats));
  const modified = working !== text;
  const isSuspicious = threats.length > 0;

  return {
    cleanText: working,
    isSuspicious,
    threats,
    modified,
  };
}

/**
 * Masks sensitive credentials, keys, tickets, UUIDs, and internal paths before
 * logging or network dispatch.
 *
 * @param {string} text - Outbound string or log entry
 * @param {Array<{ regex: RegExp, replacement: string }>|object} [customPatterns=[]] - Additional rules or options
 * @returns {string} Redacted string
 */
export function redactOutbound(text, customPatterns = []) {
  if (typeof text !== 'string') {
    throw new TypeError('redactOutbound expects a string input');
  }

  let redacted = text;
  const extraRules = Array.isArray(customPatterns) ? customPatterns : customPatterns.patterns ?? [];
  const maskEmails = !Array.isArray(customPatterns) && Boolean(customPatterns.maskEmails);

  for (const rule of OUTBOUND_REDACTION_RULES) {
    redacted = redacted.replace(rule.regex, rule.replacement);
  }

  if (maskEmails) {
    const emailRegex = /\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
    redacted = redacted.replace(emailRegex, '$1***@$2');
  }

  for (const custom of extraRules) {
    if (custom && custom.regex instanceof RegExp && typeof custom.replacement === 'string') {
      redacted = redacted.replace(custom.regex, custom.replacement);
    }
  }

  return redacted;
}

function runCli(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'Usage:',
        '  node tools/sanitize.mjs --clean "<text>" [--neutralize]',
        '  node tools/sanitize.mjs --clean-file <path> [--neutralize]',
        '  node tools/sanitize.mjs --redact "<text>" [--mask-emails]',
        '  node tools/sanitize.mjs --redact-file <path> [--mask-emails]',
      ].join('\n')
    );
    return 0;
  }

  const neutralize = args.includes('--neutralize');
  const maskEmails = args.includes('--mask-emails');

  const getTargetText = (flag, fileFlag) => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] !== undefined) {
      return args[idx + 1];
    }
    const fIdx = args.indexOf(fileFlag);
    if (fIdx !== -1 && args[fIdx + 1] !== undefined) {
      return fs.readFileSync(args[fIdx + 1], 'utf8');
    }
    return null;
  };

  if (args.includes('--clean') || args.includes('--clean-file')) {
    const input = getTargetText('--clean', '--clean-file');
    if (input === null) {
      console.error('Error: Missing input for --clean / --clean-file');
      return 1;
    }
    const result = sanitizeInput(input, { neutralizeInjections: neutralize });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (args.includes('--redact') || args.includes('--redact-file')) {
    const input = getTargetText('--redact', '--redact-file');
    if (input === null) {
      console.error('Error: Missing input for --redact / --redact-file');
      return 1;
    }
    console.log(redactOutbound(input, { maskEmails }));
    return 0;
  }

  console.error(`Unknown arguments: ${args.join(' ')}`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = runCli(process.argv);
}

