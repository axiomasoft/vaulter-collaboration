import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { extensionsFor, FIELD, SUPPORTED_TYPES } from '../src/schema.js'

// The hub seeds and projects with src/schema.js; the backend validates with its
// TipTapSchema allow-list. packages/collaboration/tests/Fixtures/tiptap-schema.json is
// written by the PHP TipTapSchemaFixtureTest — both sides must name the same nodes and
// marks AND attributes, or a seed loses content / every store fails (toJSON() dumps every
// attribute an extension declares, nulls included — one the backend does not list is a 422).

const fixture = JSON.parse(readFileSync(new URL('../../collaboration/tests/Fixtures/tiptap-schema.json', import.meta.url), 'utf8'))

test('the hub knows exactly the collaborative types the backend pins', () => {
  assert.deepEqual([...SUPPORTED_TYPES].sort(), Object.keys(fixture).sort())
})

for (const type of Object.keys(fixture)) {
  test(`${type}: hub nodes and marks equal the backend allow-list`, () => {
    const schema = getSchema(extensionsFor(type))

    assert.deepEqual(Object.keys(schema.nodes).sort(), fixture[type].nodes)
    assert.deepEqual(Object.keys(schema.marks).sort(), fixture[type].marks)
  })
}

/** Every attribute an extension declares, per node/mark type that has any. */
function declaredAttributes(schema) {
  const out = {}

  for (const group of [schema.nodes, schema.marks]) {
    for (const [name, type] of Object.entries(group)) {
      const attrs = Object.keys(type.spec.attrs ?? {}).sort()

      if (attrs.length > 0) {
        out[name] = attrs
      }
    }
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

for (const type of Object.keys(fixture)) {
  test(`${type}: hub attributes equal the backend allow-list`, () => {
    assert.deepEqual(declaredAttributes(getSchema(extensionsFor(type))), fixture[type].attributes)
  })
}

const richText = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'see', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
    { type: 'image', attrs: { src: 'https://example.com/a.png', alt: 'a' } },
    { type: 'table', content: [{ type: 'tableRow', content: [
      { type: 'tableHeader', content: [{ type: 'paragraph' }] },
      { type: 'tableCell', content: [{ type: 'paragraph' }] },
    ] }] },
  ],
}

function attrKeys(node, found = {}) {
  for (const item of [node, ...(node.marks ?? [])]) {
    found[item.type] = [...new Set([...(found[item.type] ?? []), ...Object.keys(item.attrs ?? {})])].sort()
  }
  for (const child of node.content ?? []) {
    attrKeys(child, found)
  }

  return found
}

test('the hub projection of a document with a link, an image and a table only carries allowed attributes', () => {
  const projected = TiptapTransformer.fromYdoc(TiptapTransformer.toYdoc(richText, FIELD, extensionsFor('vaulter/rich-text')), FIELD)
  const found = attrKeys(projected)

  // The projection really carries the attributes the backend must accept.
  assert.ok(found.link.includes('title'))
  assert.ok(found.tableCell.includes('colspan'))

  for (const [type, keys] of Object.entries(found)) {
    assert.deepEqual(keys.filter((key) => !(fixture['vaulter/rich-text'].attributes[type] ?? []).includes(key)), [], type)
  }
})

test('the hub preserves rich-text block IDs when seeding and projecting Yjs state', () => {
  const content = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2, blockId: 'blk_heading' }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { blockId: 'blk_paragraph' }, content: [{ type: 'text', text: 'Body' }] },
    ],
  }
  const document = TiptapTransformer.toYdoc(content, FIELD, extensionsFor('vaulter/rich-text'))

  try {
    assert.deepEqual(TiptapTransformer.fromYdoc(document, FIELD), content)
  } finally {
    document.destroy()
  }
})
