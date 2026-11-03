/**
 * @fileoverview Automated Contextual Recall Engine for MegaDEV (AGENTS.md Section 8).
 *
 * Implements hybrid sparse vector similarity, BM25-derived term weighting, and knowledge graph
 * tag/link boosting to dynamically retrieve past session notes, handoffs, and domain facts
 * without blowing the model's active context window budget.
 */

import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens } from './rule-budget.mjs';

const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'aren',
  'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further',
  'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'isn', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my',
  'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours',
  'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that',
  'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
  'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'wasn', 'we', 'were', 'weren', 'what',
  'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'won', 'would', 'you', 'your', 'yours',
]);

/**
 * Tokenize text into lowercased alphanumeric words, stripping stopwords.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  return text
    .toLowerCase()
    .replace(/[`*_~#>[\](){}|+=:;!?.,\\/"'-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
}

function parseFrontmatterTags(fmText) {
  const tags = new Set();
  const tagLine = fmText.match(/^tags:\s*\[?(.*?)\]?$/m);
  if (tagLine) {
    for (const t of tagLine[1].split(',')) {
      const clean = t.trim().replace(/^['"]|['"]$/g, '').toLowerCase();
      if (clean) {
        tags.add(clean);
      }
    }
  }
  return tags;
}

/**
 * Extracts links, tags, and title from markdown content.
 * @param {string} text
 * @returns {{ title: string, tags: string[], links: string[] }}
 */
export function extractMetadata(text) {
  if (!text || typeof text !== 'string') {
    return { title: 'Untitled', tags: [], links: [] };
  }

  const titleMatch = text.match(/^#\s+(.+)$/m) ?? text.match(/^##\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

  const tags = new Set();
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    for (const t of parseFrontmatterTags(fmMatch[1])) {
      tags.add(t);
    }
  }

  const inlineTags = text.match(/(?:^|\s)#[a-zA-Z0-9_-]{2,30}\b/g) ?? [];
  for (const tag of inlineTags) {
    tags.add(tag.trim().replace(/^#/, '').toLowerCase());
  }

  const links = new Set();
  const mdLinks = text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
  for (const match of mdLinks) {
    const target = match[2].trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      links.add(target.replace(/\\/g, '/').toLowerCase());
    }
  }
  const wikiLinks = text.matchAll(/\[\[([^\]]+)\]\]/g);
  for (const match of wikiLinks) {
    links.add(match[1].trim().replace(/\\/g, '/').toLowerCase());
  }

  return { title, tags: Array.from(tags), links: Array.from(links) };
}

function subdivideParagraphs(trimmed, subTitle, maxChunkTokens) {
  const paragraphs = trimmed.split(/\r?\n\r?\n+/);
  const out = [];
  let buf = [];
  let bufTokens = 0;

  for (const p of paragraphs) {
    const pTrim = p.trim();
    if (!pTrim) {
      continue;
    }
    const tok = estimateTokens(pTrim);
    if (bufTokens + tok > maxChunkTokens && buf.length > 0) {
      const content = buf.join('\n\n');
      out.push({ title: subTitle, content, tokens: estimateTokens(content) });
      buf = [pTrim];
      bufTokens = tok;
    } else {
      buf.push(pTrim);
      bufTokens += tok;
    }
  }

  if (buf.length > 0) {
    const content = buf.join('\n\n');
    out.push({ title: subTitle, content, tokens: estimateTokens(content) });
  }
  return out;
}

function processSection(section, i, totalSections, maxChunkTokens) {
  const trimmed = section.trim();
  if (!trimmed) {
    return [];
  }

  const headingMatch = trimmed.match(/^#{2,3}\s+(.+)$/m);
  if (!headingMatch && i === 0 && totalSections > 1 && estimateTokens(trimmed) < 40) {
    return [];
  }

  const tokens = estimateTokens(trimmed);
  const subTitle = headingMatch ? headingMatch[1].trim() : `Section ${i + 1}`;

  if (tokens <= maxChunkTokens) {
    return [{ title: subTitle, content: trimmed, tokens }];
  }
  return subdivideParagraphs(trimmed, subTitle, maxChunkTokens);
}

/**
 * Splits document into logical sections / chunks.
 * @param {string} content
 * @param {object} options
 * @returns {Array<{ id: string, title: string, content: string, tokens: number }>}
 */
export function chunkDocument(content, { maxChunkTokens = 350 } = {}) {
  if (!content || typeof content !== 'string') {
    return [];
  }

  const sections = content.split(/(?=^#{2,3}\s+)/m);
  const chunks = [];
  let chunkIdx = 0;

  for (let i = 0; i < sections.length; i++) {
    const subs = processSection(sections[i], i, sections.length, maxChunkTokens);
    for (const sub of subs) {
      chunks.push({ id: `chunk-${chunkIdx++}`, ...sub });
    }
  }

  return chunks;
}

function processDocumentChunks(doc, docFreq) {
  const meta = extractMetadata(doc.content);
  const docTitle = doc.title ?? meta.title;
  const docTags = Array.from(new Set([...(doc.tags ?? []), ...meta.tags]));
  const docLinks = Array.from(new Set([...(doc.links ?? []), ...meta.links]));

  const rawChunks = chunkDocument(doc.content);
  const sourceChunks = rawChunks.length > 0 ? rawChunks : [
    { id: 'chunk-0', title: docTitle, content: doc.content, tokens: estimateTokens(doc.content) },
  ];

  const processed = [];
  for (const c of sourceChunks) {
    const tokens = tokenize(`${docTitle} ${c.title} ${c.content} ${docTags.join(' ')}`);
    const termCounts = new Map();
    for (const t of tokens) {
      termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    }
    for (const t of termCounts.keys()) {
      docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
    }
    processed.push({
      id: `${doc.id}#${c.id}`,
      docId: doc.id,
      source: doc.source,
      docTitle,
      chunkTitle: c.title,
      content: c.content,
      tokens: c.tokens,
      tags: docTags,
      links: docLinks,
      termCounts,
      totalTerms: tokens.length,
    });
  }
  return processed;
}

function computeChunkVector(chunk, idf) {
  const vector = new Map();
  let sumSq = 0;
  for (const [term, count] of chunk.termCounts.entries()) {
    const tf = count / (chunk.totalTerms || 1);
    const weight = tf * (idf.get(term) ?? 0);
    vector.set(term, weight);
    sumSq += weight * weight;
  }
  chunk.vector = vector;
  chunk.norm = Math.sqrt(sumSq) || 1;
}

/**
 * Builds a vector index for a collection of documents.
 * @param {Array<{ id: string, source: string, content: string, tags?: string[], links?: string[], title?: string }>} docs
 * @returns {object} Indexed corpus
 */
export function buildIndex(docs) {
  const chunks = [];
  const docFreq = new Map();

  for (const doc of docs) {
    const docChunks = processDocumentChunks(doc, docFreq);
    chunks.push(...docChunks);
  }

  const N = chunks.length;
  const idf = new Map();
  for (const [term, df] of docFreq.entries()) {
    idf.set(term, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  for (const chunk of chunks) {
    computeChunkVector(chunk, idf);
  }

  return { chunks, idf, totalChunks: N, docFreq };
}

function computeQueryVector(queryTokens, idf) {
  const qCounts = new Map();
  for (const t of queryTokens) {
    qCounts.set(t, (qCounts.get(t) ?? 0) + 1);
  }
  const qVector = new Map();
  let qSumSq = 0;
  for (const [term, count] of qCounts.entries()) {
    const tf = count / queryTokens.length;
    const weight = tf * (idf.get(term) ?? 1.0);
    qVector.set(term, weight);
    qSumSq += weight * weight;
  }
  return { qVector, qNorm: Math.sqrt(qSumSq) || 1 };
}

function scoreChunk(chunk, qVector, qNorm, queryLower, graphBoost) {
  let dot = 0;
  for (const [term, qWeight] of qVector.entries()) {
    const cWeight = chunk.vector.get(term);
    if (cWeight !== undefined) {
      dot += qWeight * cWeight;
    }
  }
  const cosineSim = dot / (qNorm * chunk.norm);

  let boost = 0;
  for (const tag of chunk.tags) {
    if (queryLower.includes(tag.toLowerCase())) {
      boost += graphBoost;
    }
  }
  for (const link of chunk.links) {
    const base = path.basename(link, path.extname(link)).toLowerCase();
    if (queryLower.includes(base)) {
      boost += graphBoost * 0.75;
    }
  }

  return { totalScore: cosineSim + boost, cosineSim };
}

function selectTopChunks(scored, topK, maxTokens) {
  scored.sort((a, b) => b.score - a.score);
  const selected = [];
  let tokenBudget = 0;

  for (const item of scored) {
    if (selected.length >= topK) {
      break;
    }
    if (tokenBudget + item.tokens > maxTokens && selected.length > 0) {
      continue;
    }
    selected.push(item);
    tokenBudget += item.tokens;
  }
  return { selected, tokenBudget };
}

/**
 * Searches the index using hybrid sparse vector similarity and graph tag/link boosting.
 *
 * @param {string} query - Search query
 * @param {object} index - Corpus index
 * @param {object} options
 * @returns {{ results: Array<any>, totalTokens: number, formattedPrompt: string }}
 */
export function recallContext(query, index, {
  topK = 3,
  minScore = 0.08,
  maxTokens = 1200,
  graphBoost = 0.25,
} = {}) {
  if (!query || typeof query !== 'string' || !index || !Array.isArray(index.chunks) || index.chunks.length === 0) {
    return { results: [], totalTokens: 0, formattedPrompt: '' };
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return { results: [], totalTokens: 0, formattedPrompt: '' };
  }

  const { qVector, qNorm } = computeQueryVector(queryTokens, index.idf);
  const queryLower = query.toLowerCase();
  const scored = [];

  for (const chunk of index.chunks) {
    const { totalScore, cosineSim } = scoreChunk(chunk, qVector, qNorm, queryLower, graphBoost);
    if (totalScore >= minScore) {
      scored.push({
        id: chunk.id,
        docId: chunk.docId,
        source: chunk.source,
        title: `${chunk.docTitle} - ${chunk.chunkTitle}`,
        content: chunk.content,
        tokens: chunk.tokens,
        score: Number(totalScore.toFixed(4)),
        cosineSim: Number(cosineSim.toFixed(4)),
        tags: chunk.tags,
      });
    }
  }

  const { selected, tokenBudget } = selectTopChunks(scored, topK, maxTokens);
  return {
    results: selected,
    totalTokens: tokenBudget,
    formattedPrompt: formatRecallPrompt(selected),
  };
}

/**
 * Formats recalled memory chunks into an injectable markdown prompt block.
 * @param {Array<any>} results
 * @returns {string}
 */
export function formatRecallPrompt(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return '';
  }

  const lines = [
    '<!-- CONTEXTUAL_RECALL_START -->',
    '## Relevant Contextual Knowledge & Past Notes',
    'The following past notes and context fragments were retrieved dynamically based on conversation similarity:',
    '',
  ];

  for (const item of results) {
    lines.push(`### [${item.title}] (${item.source}) (Relevance: ${item.score})`);
    if (item.tags && item.tags.length > 0) {
      lines.push(`*Tags: ${item.tags.join(', ')}*`);
    }
    lines.push('');
    lines.push(item.content.trim());
    lines.push('');
  }

  lines.push('<!-- CONTEXTUAL_RECALL_END -->');
  return lines.join('\n');
}

function scanFile(fullPath, workspaceRoot, docs) {
  try {
    const content = fs.readFileSync(fullPath, 'utf-8').trim();
    if (content.length > 0) {
      const relPath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
      docs.push({ id: relPath, source: relPath, content });
    }
  } catch {
    // Ignore unreadable files
  }
}

function scanDirectory(dir, workspaceRoot, docs, ignored) {
  if (!fs.existsSync(dir)) {
    return;
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!ignored.has(entry.name) && !entry.name.startsWith('.')) {
        scanDirectory(fullPath, workspaceRoot, docs, ignored);
      }
    } else if (entry.isFile() && /\.(md|txt)$/i.test(entry.name)) {
      scanFile(fullPath, workspaceRoot, docs);
    }
  }
}

/**
 * Recursively scans directories and files to build a contextual recall index.
 * @param {string[]} dirPaths - Directory or file paths to scan
 * @param {object} [options]
 * @param {string} [options.workspaceRoot=process.cwd()]
 * @returns {object} Corpus index
 */
export function indexDirectories(dirPaths, { workspaceRoot = process.cwd() } = {}) {
  const docs = [];
  const ignored = new Set(['node_modules', '.git', '.runs', 'dist', 'build', '.cache', 'venv', '__pycache__']);
  for (const d of dirPaths) {
    if (!fs.existsSync(d)) {
      continue;
    }
    try {
      const stat = fs.statSync(d);
      if (stat.isFile()) {
        scanFile(d, workspaceRoot, docs);
      } else if (stat.isDirectory()) {
        scanDirectory(d, workspaceRoot, docs, ignored);
      }
    } catch {
      // Ignore inaccessible paths
    }
  }
  return buildIndex(docs);
}
