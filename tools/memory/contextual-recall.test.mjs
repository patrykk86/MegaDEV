/**
 * @fileoverview Unit tests for tools/memory/contextual-recall.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  buildIndex,
  chunkDocument,
  extractMetadata,
  indexDirectories,
  recallContext,
  tokenize,
} from './contextual-recall.mjs';

describe('Contextual Recall: Tokenization & Metadata Extraction', () => {
  it('tokenizes text, removes stopwords and punctuation', () => {
    const text = 'The quick brown fox jumps over the lazy dog! 1234 #gotcha';
    const tokens = tokenize(text);
    assert.deepEqual(tokens, ['quick', 'brown', 'fox', 'jumps', 'lazy', 'dog', 'gotcha']);
  });

  it('extracts titles, frontmatter tags, inline tags, and markdown links', () => {
    const content = `---
tags: [architecture, security]
---
# Main Architecture Document

Here is a note with #gotcha and [[knowledge/sub-note]] plus [another link](docs/setup.md).
`;
    const meta = extractMetadata(content);
    assert.equal(meta.title, 'Main Architecture Document');
    assert.ok(meta.tags.includes('architecture'));
    assert.ok(meta.tags.includes('security'));
    assert.ok(meta.tags.includes('gotcha'));
    assert.ok(meta.links.includes('knowledge/sub-note'));
    assert.ok(meta.links.includes('docs/setup.md'));
  });
});

describe('Contextual Recall: Document Chunking', () => {
  it('splits document by section headings and computes chunk tokens', () => {
    const md = `
# Doc Title

## Section One
First paragraph of section one with detailed content.

## Section Two
Second paragraph of section two with other insights.
`;
    const chunks = chunkDocument(md);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].title, 'Section One');
    assert.equal(chunks[1].title, 'Section Two');
    assert.ok(chunks[0].tokens > 0);
  });
});

describe('Contextual Recall: Vector Indexing & Hybrid Recall', () => {
  const docs = [
    {
      id: 'doc-1',
      source: 'memory/database-patterns.md',
      content: `
# PostgreSQL Connection Pooling & Gotchas
When managing high-concurrency database workloads with Prisma or pgPool,
always ensure statement timeouts and connection leak monitors are enabled.
Tags: #postgres #pooling #database
`,
    },
    {
      id: 'doc-2',
      source: 'memory/auth-flows.md',
      content: `
# OAuth2 & JWT Session Management
Refresh tokens must be rotated cryptographically upon every exchange.
Store JWT tokens in httpOnly secure cookies to mitigate XSS risks.
Tags: #auth #security #jwt
`,
    },
    {
      id: 'doc-3',
      source: 'memory/fastapi-conventions.md',
      content: `
# FastAPI Pydantic v2 Best Practices
Always use model_validate and field_validator in Pydantic v2.
Avoid deprecated v1 root_validator and dict() calls.
Tags: #python #fastapi #pydantic
`,
    },
  ];

  it('retrieves relevant document by semantic keyword similarity', () => {
    const index = buildIndex(docs);
    assert.equal(index.totalChunks, 3);

    const query = 'How do I handle JWT cookie security and refresh token rotation?';
    const recall = recallContext(query, index, { topK: 2, minScore: 0.05 });

    assert.ok(recall.results.length >= 1);
    assert.equal(recall.results[0].docId, 'doc-2');
    assert.ok(recall.results[0].score > 0.1);
    assert.ok(recall.formattedPrompt.includes('OAuth2 & JWT Session Management'));
    assert.ok(recall.formattedPrompt.includes('<!-- CONTEXTUAL_RECALL_START -->'));
    assert.ok(recall.formattedPrompt.includes('<!-- CONTEXTUAL_RECALL_END -->'));
  });

  it('boosts document based on matching tags and graph links', () => {
    const index = buildIndex(docs);
    const query = 'Review our #postgres connection leaks';
    const recall = recallContext(query, index, { topK: 1, minScore: 0.05, graphBoost: 0.3 });

    assert.equal(recall.results.length, 1);
    assert.equal(recall.results[0].docId, 'doc-1');
  });

  it('respects token budget and topK limits', () => {
    const index = buildIndex(docs);
    const query = 'database jwt python conventions';
    const recall = recallContext(query, index, { topK: 1, maxTokens: 50 });

    assert.equal(recall.results.length, 1);
    assert.ok(recall.totalTokens <= 50);
  });
});

describe('Contextual Recall: Directory Scanning', () => {
  it('scans a temporary directory of notes and builds queryable index', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'megadev-recall-test-'));
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'note1.md'),
        '# Node Runtime Gotchas\nAlways handle unhandledRejection and childProcess spawn errors on Windows.\n',
        'utf-8'
      );
      fs.writeFileSync(
        path.join(tmpDir, 'note2.md'),
        '# Docker Swarm Deployments\nConfigure overlay networks and encrypted secret injection.\n',
        'utf-8'
      );

      const index = indexDirectories([tmpDir], { workspaceRoot: tmpDir });
      assert.equal(index.totalChunks, 2);

      const res = recallContext('child process spawn error on windows', index);
      assert.equal(res.results.length, 1);
      assert.equal(res.results[0].source, 'note1.md');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
