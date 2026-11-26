import { isDeepStrictEqual } from 'node:util'
import * as Y from 'yjs'
import { FIELD, isRecord, isReviewId, isReviewMark, REVIEW_STRUCTURE, REVIEW_STRUCTURE_PREFIX } from './schema.js'

const structuralKinds = new Set(['mark_change', 'attr_change', 'block_split', 'block_join', 'list_change', 'table_change'])
// y-prosemirror suffixes overlapping mark names with an eight-character hash.
const reviewFormat = /^reviewSuggestion(?:--[a-zA-Z0-9+/=]{8})?$/

function validRecord(entry, id, subject) {
  const record = entry?.record
  return isRecord(entry) && Number.isSafeInteger(entry.order) && entry.order > 0 && isRecord(record)
    && isReviewId(id) && record.suggestionId === id && record.author === subject && isReviewId(record.author)
    && isReviewId(record.groupId) && isReviewId(record.blockId) && structuralKinds.has(record.kind)
    && Number.isSafeInteger(record.from) && record.from >= 0 && Number.isSafeInteger(record.to) && record.to >= record.from
    && (record.parentId === null || isReviewId(record.parentId))
    && typeof record.conflicted === 'boolean' && (record.conflictReason === null || isReviewId(record.conflictReason))
    && (record.conflictWithId === null || isReviewId(record.conflictWithId)) && isRecord(record.payload)
}

// Track marks on the underlying Yjs character clocks. Offsets can move when another writer
// inserts text earlier in the paragraph. Reusing foreign metadata on new text is a new mark.
function* reviewSpans(fragment) {
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement) {
      yield* reviewSpans(child)
    } else if (child instanceof Y.XmlText && child._hasFormatting) {
      const active = new Map()
      for (let item = child._start; item !== null; item = item.right) {
        if (item.deleted) continue
        const format = item.content
        if (format instanceof Y.ContentFormat && reviewFormat.test(format.key)) {
          if (format.value === null) active.delete(format.key)
          else active.set(format.key, format.value)
        } else if (item.countable) {
          const { client, clock } = item.id
          for (const attrs of active.values()) yield { attrs, client, from: clock, to: clock + item.length }
        }
      }
    }
  }
}

function covered(span, original) {
  let from = span.from
  for (const previous of original ?? []) {
    if (previous.client !== span.client || previous.to <= from || previous.from > from ||
        !isDeepStrictEqual(previous.attrs, span.attrs)) continue
    from = previous.to
    if (from >= span.to) return true
  }
  return false
}

function recordsIn(doc) {
  return doc.share.has(REVIEW_STRUCTURE) ? doc.getMap(REVIEW_STRUCTURE) : new Map()
}

/** Validate changes on a scratch document before the update can be appended. */
export function validReviewUpdate(before, after, subject, type) {
  const originalRoot = before.share.get(REVIEW_STRUCTURE)
  if (originalRoot && originalRoot.constructor !== Y.AbstractType && !(originalRoot instanceof Y.Map)) return false
  for (const [name, root] of after.share) {
    if (!name.startsWith(REVIEW_STRUCTURE_PREFIX)) continue
    if (type !== 'vaulter/rich-text' || name !== REVIEW_STRUCTURE || root._length !== 0) return false
  }
  const originalRecords = recordsIn(before)
  const records = recordsIn(after)
  const owners = new Map()
  const originalSpans = new Map()
  function remember(id, author) {
    if (!owners.has(id)) owners.set(id, new Set())
    owners.get(id).add(author)
  }
  const owned = (id) => !owners.has(id) || (owners.get(id).size === 1 && owners.get(id).has(subject))

  for (const [id, entry] of originalRecords) remember(id, entry?.record?.author)
  for (const span of reviewSpans(before.getXmlFragment(FIELD))) {
    const id = span.attrs?.suggestionId
    remember(id, span.attrs?.author)
    if (!originalSpans.has(id)) originalSpans.set(id, [])
    originalSpans.get(id).push(span)
  }
  for (const spans of originalSpans.values()) spans.sort((a, b) => a.from - b.from)

  for (const span of reviewSpans(after.getXmlFragment(FIELD))) {
    const attrs = span.attrs
    if (covered(span, originalSpans.get(attrs?.suggestionId))) continue
    if (type !== 'vaulter/rich-text' || !isReviewMark(attrs) || !isReviewId(attrs.groupId)
      || !isReviewId(subject) || attrs.author !== subject || !owned(attrs.suggestionId)) return false
  }
  for (const [id, entry] of records) {
    const previous = originalRecords.get(id)
    if (isDeepStrictEqual(entry, previous)) continue
    if (!validRecord(entry, id, subject) || !owned(id) || (previous && previous.order !== entry.order)) return false
  }
  for (const id of originalRecords.keys()) {
    if (!records.has(id) && !owned(id)) return false
  }
  return true
}
