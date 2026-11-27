import { Extension, Mark } from '@tiptap/core'
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

const BlockIdentity = Extension.create({
  name: 'blockIdentity',

  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: { blockId: { default: null } },
    }]
  },
})

export const REVIEW_SUGGESTION = 'reviewSuggestion'
export const REVIEW_STRUCTURE_PREFIX = 'vaulter:reviewStructure:'
export const REVIEW_STRUCTURE = REVIEW_STRUCTURE_PREFIX + FIELD

export function isReviewId(value) {
  return typeof value === 'string' && value.trim() !== ''
}

export function isRecord(value) {
  return value !== null && typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

const optionalId = (value) => value === null || isReviewId(value)
const reviewAttributes = {
  suggestionId: isReviewId,
  kind: (value) => ['insert', 'delete', 'mark_change'].includes(value),
  parentId: optionalId,
  groupId: optionalId,
  author: optionalId,
  markName: optionalId,
  markAttrs: (value) => value === null || isRecord(value),
  operation: (value) => value === null || ['added', 'removed'].includes(value),
}

export function isReviewMark(attrs) {
  return isRecord(attrs) && Object.keys(attrs).every((name) => Object.hasOwn(reviewAttributes, name))
    && Object.entries(reviewAttributes).every(([name, validate]) => validate(attrs[name] ?? null))
}

const ReviewSuggestion = Mark.create({
  name: REVIEW_SUGGESTION,
  inclusive: false,
  excludes: '',
  keepOnSplit: false,
  addAttributes() {
    return Object.fromEntries(Object.entries(reviewAttributes).map(([name, validate]) => [name, {
      default: null,
      validate(value) {
        if (!validate(value)) throw new RangeError(`Invalid reviewSuggestion.${name}`)
      },
    }]))
  },
})

const OPTIONAL_MARKS = {
  'vaulter/rich-text': [ReviewSuggestion],
}

const TYPES = {
  // StarterKit (with Underline), Link, Image, Table.
  'vaulter/rich-text': () => [
    StarterKit.configure({ link: false }),
    BlockIdentity,
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

/** Activate optional marks only when one of the original documents uses them. */
export function extensionsFor(type, ...originals) {
  if (!Object.hasOwn(TYPES, type)) {
    throw new Error(`The hub has no TipTap schema for document type "${type}"`)
  }

  const extensions = TYPES[type]()
  for (const extension of OPTIONAL_MARKS[type] ?? []) {
    if (originals.some((document) => !marksIn(document, extension.name).next().done)) extensions.push(extension)
  }
  return extensions
}

function* marksIn(node, name) {
  for (const mark of Array.isArray(node?.marks) ? node.marks : []) {
    if (mark?.type === name) yield mark
  }
  for (const child of Array.isArray(node?.content) ? node.content : []) yield* marksIn(child, name)
}

export function checkReviewMarks(original) {
  for (const mark of marksIn(original, REVIEW_SUGGESTION)) {
    if (!isReviewMark(mark.attrs)) throw new RangeError('Invalid reviewSuggestion attributes')
  }
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
