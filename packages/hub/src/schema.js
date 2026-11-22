import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'

// The TipTap extensions the hub builds a room from when a document has no Yjs state
// yet (one-time seed from its JSON) and projects back to JSON on every store. They
// mirror the backend allow-list (TipTapSchema): a node the hub does not know is
// dropped from the seed, a node the backend does not know fails every store. Both
// sides are pinned to packages/collaboration/tests/Fixtures/tiptap-schema.json, which
// test/schema-parity.test.js compares against.
//
// Hosts that add nodes through vaulter-documents.tiptap.extra_* must add the matching
// extensions here too (see README).

/** The Y.XmlFragment the editor's Collaboration extension binds to. */
export const FIELD = 'default'

const TYPES = {
  // StarterKit (with Underline), Link, Image, Table.
  'vaulter/rich-text': () => [
    StarterKit.configure({ link: false }),
    Link,
    Image,
    Table,
    TableRow,
    TableHeader,
    TableCell,
  ],
  // Only what Markdown can represent.
  'vaulter/markdown': () => [
    StarterKit.configure({ link: false, underline: false }),
    Link,
  ],
}

export const SUPPORTED_TYPES = Object.freeze(Object.keys(TYPES))

/** The extensions of a document type; throws for a type the hub cannot seed. */
export function extensionsFor(type) {
  const build = TYPES[type]

  if (!build) {
    throw new Error(`The hub has no TipTap schema for document type "${type}"`)
  }

  return build()
}

/**
 * The attributes of `input` (a TipTap JSON document) that `projection` — the same document
 * after a round trip through the hub's schema — no longer carries, as "type.attribute"
 * names (values are never listed). A `null`/missing attribute is not a loss, and the
 * comparison is by SET of "type, attribute, value": ProseMirror merges adjacent text nodes
 * and reorders marks, which changes neither.
 */
export function lostAttributes(input, projection) {
  const present = new Set(attributeEntries(projection).map(([key]) => key))
  const lost = new Set()

  for (const [key, label] of attributeEntries(input)) {
    if (!present.has(key)) {
      lost.add(label)
    }
  }

  return [...lost].sort()
}

function attributeEntries(node, found = []) {
  if (node === null || typeof node !== 'object') {
    return found
  }

  for (const item of [node, ...(Array.isArray(node.marks) ? node.marks : [])]) {
    for (const [name, value] of Object.entries(item?.attrs ?? {})) {
      if (value !== null && value !== undefined) {
        found.push([`${item.type}|${name}|${JSON.stringify(value)}`, `${item.type}.${name}`])
      }
    }
  }

  for (const child of Array.isArray(node.content) ? node.content : []) {
    attributeEntries(child, found)
  }

  return found
}
