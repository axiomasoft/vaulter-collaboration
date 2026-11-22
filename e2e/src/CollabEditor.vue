<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { useVaulterClient, type CollaborationHandle } from '@vaulter/vue'
import { createCollaborationAdapter } from '@vaulter/vue-collaboration'
import type { Doc as YDoc } from 'yjs'

const props = defineProps<{
  nodeId: string | number
  forceEditable?: boolean
}>()

const client = useVaulterClient()
const adapter = createCollaborationAdapter({ client })
const collab = shallowRef<CollaborationHandle | null>(null)

const editor = shallowRef<Editor | null>(null)
let editorDoc: YDoc | undefined
const error = ref('')
const status = computed(() => {
  if (error.value) return 'error'
  if (!collab.value?.connected?.value) return 'connecting'

  return collab.value.readOnly.value ? 'connected:readonly' : 'connected:writable'
})

onMounted(async () => {
  try {
    collab.value = await adapter.open(props.nodeId, { client })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
})

watch(
  () => [collab.value?.doc, collab.value?.connected?.value, collab.value?.readOnly.value] as const,
  ([doc, connected, readOnly]) => {
    if (doc !== editorDoc) {
      editor.value?.destroy()
      editor.value = null
      editorDoc = doc as YDoc | undefined
    }
    if (!connected || !editorDoc) {
      editor.value?.setEditable(false)
      return
    }

    // Wait for the hub's seed before attaching TipTap's collaboration extension.
    // Боевое поведение: editable = !readOnly. forceEditable обходит это, чтобы тест мог
    // заставить viewer'а ПОПЫТАТЬСЯ писать и убедиться, что сервер дропает его апдейты.
    const editable = props.forceEditable || !readOnly
    if (editor.value) {
      editor.value.setEditable(editable)
      return
    }

    editor.value = new Editor({
      extensions: [
        // history off — историю держит Yjs (UndoManager), иначе конфликт с CRDT.
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: editorDoc }),
      ],
      editable,
    })
  },
)

onBeforeUnmount(() => {
  editor.value?.destroy()
  collab.value?.end()
})
</script>

<template>
  <main class="wrap">
    <h2>Vaulter collab e2e — node {{ props.nodeId }}</h2>
    <p>status: <b data-testid="status">{{ status }}</b></p>
    <p>access: <b data-testid="readonly">{{ collab?.readOnly?.value ? 'read-only' : 'writable' }}</b></p>
    <p>save: <b data-testid="save-status">{{ collab?.status.value ?? 'pending' }}</b></p>
    <p>peers: <b data-testid="peers">{{ collab?.collaborators?.value.length ?? 0 }}</b></p>
    <p v-if="error" data-testid="error" class="error">{{ error }}</p>
    <EditorContent
      v-if="editor"
      :editor="editor"
      data-testid="editor"
      class="editor"
    />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; }
.wrap { padding: 16px; max-width: 720px; }
.editor { border: 1px solid #cbd5e0; border-radius: 6px; min-height: 140px; padding: 10px; }
.editor:focus-within { outline: 2px solid #3366cc; }
.error { color: #c0392b; }
</style>
