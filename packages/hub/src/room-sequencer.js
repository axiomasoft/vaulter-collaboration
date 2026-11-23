import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { TiptapTransformer } from '@hocuspocus/transformer'
import { getSchema } from '@tiptap/core'
import * as Y from 'yjs'
import { COMMITTED_ORIGIN, LOAD_ORIGIN, sha256Hex } from './persistence.js'
import { extensionsFor, FIELD } from './schema.js'

export function refusal(code) {
  return Object.assign(new Error(code), { code })
}

function complete(doc) {
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) {
    throw refusal('missing_dependencies')
  }
}

export function cloneRoom(doc) {
  const copy = new Y.Doc({ gc: false })
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc), LOAD_ORIGIN)
  return copy
}

function blocks(root, blockId, found = []) {
  for (const child of root.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.getAttribute('blockId') === blockId) found.push(child)
    blocks(child, blockId, found)
  }
  return found
}

function blockOf(doc, id) {
  const matches = blocks(doc.getXmlFragment(FIELD), id)
  if (matches.length !== 1) throw refusal('precondition_failed')
  return matches[0]
}

function textContent(text) {
  const runs = text.toDelta()
  if (runs.some((run) => typeof run.insert !== 'string')) throw refusal('precondition_failed')
  return { runs, plain: runs.map((run) => run.insert).join('') }
}

function blockText(block) {
  let plain = ''
  const segments = []
  for (const child of block.toArray()) {
    if (child instanceof Y.XmlText) {
      const content = textContent(child)
      segments.push({ text: child, offset: plain.length, ...content })
      plain += content.plain
    } else {
      // Office's block offsets count each inline leaf as one UTF-16 code unit.
      plain += '\uFFFC'
    }
  }
  return { plain, segments }
}

function findNode(root, blockId) {
  if (root.attrs?.blockId === blockId) return root
  for (const child of root.content ?? []) {
    const found = findNode(child, blockId)
    if (found) return found
  }
  return null
}

function canonicalBlock(value) {
  if (Array.isArray(value)) return value.map(canonicalBlock)
  if (value === null || typeof value !== 'object') return value
  const result = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === 'attrs') {
      const attrs = Object.fromEntries(Object.entries(child).filter(([, attr]) => attr !== null))
      if (Object.keys(attrs).length) result.attrs = canonicalBlock(attrs)
    } else if (key === 'marks') {
      const marks = child.map(canonicalBlock).sort((a, b) => a.type.localeCompare(b.type))
      if (marks.length) result.marks = marks
    } else {
      result[key] = canonicalBlock(child)
    }
  }
  return result
}

function exactReplacement(block, effect, textEvidence) {
  const { expected, replacement } = effect
  if (typeof expected !== 'string' || expected === '' || typeof replacement !== 'string') {
    throw refusal('invalid_intent')
  }
  const { plain: blockPlain, segments } = blockText(block)
  const blockStart = blockPlain.indexOf(expected)
  if (blockStart < 0 || blockPlain.indexOf(expected, blockStart + 1) >= 0) throw refusal('precondition_failed')
  const blockEnd = blockStart + expected.length
  const segment = segments.find(({ offset, plain }) => offset <= blockStart && blockEnd <= offset + plain.length)
  if (!segment) throw refusal('precondition_failed')
  const { text, runs, plain } = segment
  const start = blockStart - segment.offset
  const end = start + expected.length
  let offset = 0
  const run = runs.find(({ insert }) => {
    const from = offset
    offset += insert.length
    return from <= start && end <= offset
  })
  if (!run) throw refusal('precondition_failed')
  const attrs = run.attributes ?? {}
  if (expected !== replacement) {
    text.delete(start, expected.length)
    if (replacement !== '') text.insert(start, replacement, attrs)
  }
  const leading = [...plain.slice(0, start)].at(-1) ?? ''
  const trailing = [...plain.slice(end)][0] ?? ''
  const windowStart = start - leading.length
  const windowEnd = start + replacement.length + trailing.length
  const after = textContent(text).plain
  if (after !== plain.slice(0, start) + replacement + plain.slice(end)) {
    throw refusal('postcondition_failed')
  }
  const relative = (at, assoc) => Buffer.from(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, at, assoc))).toString('base64')
  textEvidence.push({
    block_id: effect.block_id,
    start_utf16: blockStart,
    length_utf16: replacement.length,
    replacement,
    attributes: replacement === '' ? {} : attrs,
    window: leading + replacement + trailing,
    window_leading_utf16: leading.length,
    relative_start: relative(windowStart, -1),
    relative_end: relative(windowEnd, 0),
  })
}

export async function verifyCurrentRange(log, range) {
  const room = new Y.Doc({ gc: false })
  const sequence = createRoomSequencer({ room, generation: log.generation, load: async () => log })
  const absolute = (encoded) => Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(Buffer.from(encoded, 'base64')), room,
  )
  const failed = { text: '', textPassed: false, marks: [], marksPassed: false }
  try {
    await sequence.catchUp()
    const start = absolute(range.relative_start)
    const end = absolute(range.relative_end)
    if (!start || !end || start.type !== end.type || !(start.type instanceof Y.XmlText)
      || !(start.type.parent instanceof Y.XmlElement) || start.type.parent.getAttribute('blockId') !== range.block_id
      || start.index > end.index) return failed
    const { plain, runs } = textContent(start.type)
    const window = plain.slice(start.index, end.index)
    const from = start.index + range.window_leading_utf16
    const to = from + range.replacement.length
    const text = plain.slice(from, to)
    let offset = 0
    const attrs = []
    for (const run of runs) {
      const length = run.insert.length
      if (from !== to && from < offset + length && to > offset) attrs.push(run.attributes ?? {})
      offset += length
    }
    const marks = [...new Set(attrs.flatMap((value) => Object.keys(value).map((name) => name.split('--')[0])))].sort()
    return {
      text, textPassed: window === range.window && text === range.replacement,
      marks, marksPassed: to <= end.index && attrs.every((value) => isDeepStrictEqual(value, range.attributes)),
    }
  } finally {
    sequence.close()
    room.destroy()
  }
}

function appendParagraph(block, effect, id) {
  if (typeof effect.text !== 'string' || !block.parent || !(block.parent instanceof Y.XmlFragment || block.parent instanceof Y.XmlElement)) {
    throw refusal('invalid_intent')
  }
  const parent = block.parent
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.setAttribute('blockId', id)
  paragraph.insert(0, [new Y.XmlText(effect.text)])
  parent.insert(parent.toArray().indexOf(block) + 1, [paragraph])
}

export function prepareOnCopy(base, intent, clientId, commandId, type = 'vaulter/rich-text') {
  return prepareCommand(base, intent, clientId, commandId, type, Infinity)
}

/** Prepare on a disposable copy. Confirm the emitted bytes reproduce the entire checked tree. */
function prepareCommand(base, intent, clientId, commandId, type, maxBytes) {
  if (!Number.isInteger(clientId) || clientId < 1 || clientId >= 0x80000000 ||
      !Array.isArray(intent?.atomic_effects) || intent.atomic_effects.length === 0) {
    throw refusal('invalid_intent')
  }
  const copy = cloneRoom(base)
  const vector = Y.encodeStateVector(copy)
  copy.clientID = clientId
  try {
    const schema = getSchema(extensionsFor(type))
    const before = TiptapTransformer.fromYdoc(copy, FIELD)
    for (const condition of intent.preconditions ?? []) {
      const block = blockOf(copy, condition.block_id)
      if (condition.expected_block) {
        const node = findNode(before, condition.block_id)
        if (!node || !isDeepStrictEqual(
          canonicalBlock(schema.nodeFromJSON(node).toJSON()),
          canonicalBlock(schema.nodeFromJSON(condition.expected_block).toJSON()),
        )) {
          throw refusal('precondition_failed')
        }
      } else {
        const children = block.toArray()
        if (children.length !== 1 || !(children[0] instanceof Y.XmlText)) throw refusal('precondition_failed')
        const { plain, runs } = textContent(children[0])
        const marks = [...new Set(runs.flatMap((run) => Object.keys(run.attributes ?? {}).map((name) => name.split('--')[0])))].sort()
        if (plain !== condition.expected_text || !isDeepStrictEqual(marks, [...condition.expected_marks].sort())) {
          throw refusal('precondition_failed')
        }
      }
    }
    const ranges = []
    copy.transact(() => {
      intent.atomic_effects.forEach((effect, index) => {
        const block = blockOf(copy, effect.block_id)
        if (effect.effect === 'replace_exact') {
          exactReplacement(block, effect, ranges)
        } else if (effect.effect === 'insert_paragraph_after') {
          const id = `${commandId}-p${index}`
          if (blocks(copy.getXmlFragment(FIELD), id).length > 0) throw refusal('precondition_failed')
          appendParagraph(block, effect, id)
        } else {
          throw refusal('invalid_intent')
        }
      })
    })
    complete(copy)
    const after = TiptapTransformer.fromYdoc(copy, FIELD)
    schema.nodeFromJSON(after).check()
    for (const range of ranges) {
      const block = findNode(after, range.block_id)
      if (!block) throw refusal('postcondition_failed')
      range.block = block
    }
    const bytes = isDeepStrictEqual(before, after) ? null : Buffer.from(Y.encodeStateAsUpdate(copy, vector))
    if (bytes !== null) {
      if (Y.encodeStateAsUpdateV2(copy).length > maxBytes) throw refusal('document_too_large')
      const replay = cloneRoom(base)
      try {
        Y.applyUpdate(replay, bytes)
        complete(replay)
        if (!isDeepStrictEqual(TiptapTransformer.fromYdoc(replay, FIELD), after)) {
          throw refusal('postcondition_failed')
        }
      } finally {
        replay.destroy()
      }
    }
    return { bytes, evidence: { ranges } }
  } finally {
    copy.destroy()
  }
}

function recordBytes(record) {
  const bytes = Buffer.from(record.payload, 'base64')
  if (bytes.length === 0 || record.sha256 !== sha256Hex(bytes)) throw refusal('journal_hash_mismatch')
  return bytes
}

/** One serial queue for browser updates, trusted server writes, command settlement and replay. */
export function createRoomSequencer({ room, generation, load, append, onBypass = () => {}, maxBytes = Infinity }) {
  let appliedSeq = -1
  let stopped = false
  let applying = false
  let chain = Promise.resolve()
  function guard(transaction) {
    if (transaction.origin === LOAD_ORIGIN || transaction.origin === COMMITTED_ORIGIN || stopped) return
    // Applying a remote Y.Text update may synchronously open a formatting-cleanup transaction.
    if (applying && transaction.origin === null) return
    stopped = true
    onBypass()
  }
  // Hocuspocus 4.9.0 may broadcast synchronously from its own update listener at the byte cap.
  // Close any connections before that listener can see bytes from an unrecognized transaction.
  room.getXmlFragment(FIELD)
  room.on('beforeTransaction', guard)

  function assertOpen() {
    if (stopped) throw refusal('stale_owner')
  }

  function enqueue(task) {
    const run = chain.then(() => {
      assertOpen()
      return task()
    })
    chain = run.catch(() => {})
    return run
  }

  async function catchUp(minimum = -1) {
    const log = await load(appliedSeq < 0 ? undefined : appliedSeq)
    assertOpen()
    if (log.generation !== generation) throw refusal('collaboration_epoch_mismatch')
    if (log.head_seq < Math.max(appliedSeq, minimum) || log.checkpoint_seq > log.head_seq) throw refusal('log_gap')
    if (log.head_seq === appliedSeq) return appliedSeq

    // Verify the entire new prefix on a scratch document before making any bytes visible.
    const checkpointNeeded = appliedSeq < log.checkpoint_seq
    const checkpoint = checkpointNeeded && log.checkpoint !== null ? Buffer.from(log.checkpoint, 'base64') : null
    if (checkpointNeeded && log.checkpoint_seq > 0 && checkpoint === null) throw refusal('log_gap')
    const copy = cloneRoom(room)
    let cursor = Math.max(appliedSeq, log.checkpoint_seq)
    const updates = []
    try {
      if (checkpoint !== null) Y.applyUpdate(copy, checkpoint, LOAD_ORIGIN)
      complete(copy)
      for (const record of log.tail) {
        if (record.seq <= cursor) continue
        if (record.seq !== cursor + 1 || record.seq > log.head_seq) throw refusal('log_gap')
        const bytes = recordBytes(record)
        Y.applyUpdate(copy, bytes, LOAD_ORIGIN)
        complete(copy)
        updates.push(bytes)
        cursor = record.seq
      }
      if (cursor !== log.head_seq) throw refusal('log_gap')
    } finally {
      copy.destroy()
    }
    applying = true
    try {
      if (checkpoint !== null) Y.applyUpdate(room, checkpoint, COMMITTED_ORIGIN)
      for (const bytes of updates) Y.applyUpdate(room, bytes, COMMITTED_ORIGIN)
    } finally {
      applying = false
    }
    appliedSeq = cursor
    // Deliver the accepted batch together once its whole prefix is live.
    room.flush?.()
    return appliedSeq
  }

  async function submitUpdate(update) {
    return enqueue(async () => {
      await catchUp()
      const { boundClientId, bytes } = update
      if (!Number.isInteger(boundClientId) || boundClientId < 0x80000000 || boundClientId > 0xffffffff) {
        throw refusal('client_id_conflict')
      }
      let decoded
      try {
        decoded = Y.decodeUpdateV2(Y.convertUpdateFormatV1ToV2(bytes))
      } catch {
        throw refusal('invalid_update')
      }
      const clock = Y.decodeStateVector(Y.encodeStateVector(room)).get(boundClientId) ?? 0
      if (decoded.structs.some((item) => item.id.client !== boundClientId)) throw refusal('client_id_conflict')
      const overlaps = decoded.structs.some((item) => item.id.clock < clock)
      if (!overlaps) {
        const copy = cloneRoom(room)
        try {
          Y.applyUpdate(copy, bytes, LOAD_ORIGIN)
          complete(copy)
          if ((decoded.structs.length > 0 || decoded.ds.clients.size === 0) && Y.encodeStateAsUpdateV2(copy).length > maxBytes) {
            throw refusal('document_too_large')
          }
        } finally {
          copy.destroy()
        }
      }
      // A repeated update can overlap known clocks only when SQL already has its exact receipt.
      const ack = await append({ ...update, baseSeq: appliedSeq, receiptOnly: overlaps })
      assertOpen()
      await catchUp(ack.seq)
      return ack
    })
  }

  function serverUpdate(change, clientId, persist) {
    return enqueue(async () => {
      await catchUp()
      const copy = cloneRoom(room)
      const before = Y.encodeStateAsUpdateV2(copy)
      const vector = Y.encodeStateVector(copy)
      copy.clientID = clientId
      try {
        copy.transact(() => {
          const result = change(copy)
          if (typeof result?.then === 'function') throw refusal('async_server_write')
        })
        complete(copy)
        const after = Y.encodeStateAsUpdateV2(copy)
        if (Buffer.from(before).equals(after)) return []
        if (after.length > maxBytes) throw refusal('document_too_large')
        const bytes = Buffer.from(Y.encodeStateAsUpdate(copy, vector))
        const updateId = crypto.randomUUID()
        const ack = await persist({ updateId, baseSeq: appliedSeq, sha256: sha256Hex(bytes), payload: bytes.toString('base64') })
        await catchUp(ack.seq)
        return [updateId]
      } finally {
        copy.destroy()
      }
    })
  }

  function runCommand(command, clientId, type, settle) {
    return enqueue(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await catchUp()
        let prepared
        try {
          prepared = prepareCommand(room, command.intent, clientId, command.command_id, type, maxBytes)
        } catch (error) {
          if (error?.code !== 'precondition_failed') throw error
          prepared = { reason: 'precondition_failed' }
        }
        const bytes = prepared.bytes
        try {
          const outcome = await settle({
            id: command.id, fingerprint: command.fingerprint, base_seq: appliedSeq,
            kind: prepared.reason ? 'reject' : 'commit', reason: prepared.reason, evidence: prepared.evidence,
            updates: bytes ? [{ update_id: crypto.randomUUID(), sha256: sha256Hex(bytes), payload: bytes.toString('base64') }] : [],
          })
          if (outcome.state === 'committed') await catchUp(outcome.to_seq)
          return outcome
        } catch (error) {
          if (error?.code !== 'base_moved') throw error
        }
      }
      throw refusal('base_moved')
    })
  }

  return {
    submitUpdate, serverUpdate, runCommand,
    catchUp: () => enqueue(catchUp),
    get appliedSeq() { return appliedSeq },
    close() {
      stopped = true
      room.off('beforeTransaction', guard)
    },
  }
}
