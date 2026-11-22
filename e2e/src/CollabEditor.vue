<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Editor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { useNodeCollaboration } from '@vaulter/vue'

const props = defineProps<{
  nodeId: string | number
  forceEditable?: boolean
}>()

// Реальный composable @vaulter/vue: тянет room-JWT с /nodes/{id}/collab/token и
// поднимает HocuspocusProvider над общим Y.Doc. К этому Y.Doc цепляем TipTap через
// расширение Collaboration — правки текут в Yjs и синкаются между браузерами.
const collab = useNodeCollaboration(props.nodeId)

const editor = ref<Editor | null>(null)
const status = ref('connecting')
const error = ref('')

onMounted(async () => {
  try {
    await collab.connect()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    status.value = 'error'
    return
  }

  // Боевое поведение: editable = !readOnly. forceEditable обходит это, чтобы тест мог
  // заставить viewer'а ПОПЫТАТЬСЯ писать и убедиться, что сервер дропает его апдейты.
  const editable = props.forceEditable ? true : !collab.readOnly.value

  editor.value = new Editor({
    extensions: [
      // history off — историю держит Yjs (UndoManager), иначе конфликт с CRDT.
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: collab.doc }),
    ],
    editable,
  })

  status.value = collab.readOnly.value ? 'connected:readonly' : 'connected:writable'
})

onBeforeUnmount(() => {
  editor.value?.destroy()
  collab.disconnect()
})
</script>

<template>
  <main class="wrap">
    <h2>Vaulter collab e2e — node {{ props.nodeId }}</h2>
    <p>status: <b data-testid="status">{{ status }}</b></p>
    <p>access: <b data-testid="readonly">{{ collab.readOnly.value ? 'read-only' : 'writable' }}</b></p>
    <p>peers: <b data-testid="peers">{{ collab.collaborators.value.length }}</b></p>
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
