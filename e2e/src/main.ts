import { createApp, h } from 'vue'
import { VaulterPlugin, createVaulterClient } from '@vaulter/vue'
import CollabEditor from './CollabEditor.vue'

// Сцену поднимает Laravel (/e2e/setup); сюда node/user/force приходят в query.
//   ?node=<id>  — документ-узел (одна комната на оба браузера)
//   ?user=1|2   — актор (1=writer/Edit, 2=viewer/View) через заголовок X-E2E-User
//   ?force=1    — принудительно editable (для проверки server-side readOnly: viewer
//                 пытается писать, но хаб дропает его апдейты)
const params = new URLSearchParams(location.search)
const nodeId = params.get('node') ?? ''
const user = params.get('user') ?? '1'
const forceEditable = params.get('force') === '1'

// Клиент с заголовком тестовой аутентификации — middleware E2eActingAs читает его и
// логинит соответствующего пользователя. Боевой хост ставит свой auth/куки вместо этого.
const client = createVaulterClient({
  baseUrl: '/api/vaulter',
  headers: { 'X-E2E-User': user },
})

const app = createApp({
  render: () => h(CollabEditor, { nodeId, forceEditable }),
})

app.use(VaulterPlugin, { client })
app.mount('#app')
