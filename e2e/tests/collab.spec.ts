import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

// Живой Laravel-хост (минует Vite-прокси — это серверные вызовы из ранера).
const BACKEND = process.env.VAULTER_BACKEND_URL ?? 'http://127.0.0.1:8000'

/** Поднять свежую сцену: storage + документ-узел + гранты (writer=1, viewer=2). */
async function setupScene(request: APIRequestContext): Promise<{ node_id: number | string }> {
  const res = await request.get(`${BACKEND}/e2e/setup`)
  expect(res.ok(), 'GET /e2e/setup').toBeTruthy()
  return res.json()
}

/** Локатор реального contenteditable (ProseMirror) внутри EditorContent. */
function editorOf(page: Page) {
  return page.getByTestId('editor').locator('[contenteditable="true"], .ProseMirror')
}

async function typeInto(page: Page, text: string): Promise<void> {
  const editor = editorOf(page)
  await editor.click()
  await page.keyboard.type(text)
}

test('правки writer долетают до read-only viewer и снапшот персистится', async ({
  browser,
  request,
  baseURL,
}) => {
  const { node_id: node } = await setupScene(request)

  const writerCtx = await browser.newContext()
  const viewerCtx = await browser.newContext()
  const writer = await writerCtx.newPage()
  const viewer = await viewerCtx.newPage()

  await writer.goto(`${baseURL}/?node=${node}&user=1`)
  await viewer.goto(`${baseURL}/?node=${node}&user=2`)

  // Доступ кодируется из права на узле (бэкенд), а не из запроса.
  await expect(writer.getByTestId('status')).toHaveText('connected:writable')
  await expect(viewer.getByTestId('status')).toHaveText('connected:readonly')
  await expect(viewer.getByTestId('readonly')).toHaveText('read-only')

  // writer печатает → viewer видит это в своём редакторе (Yjs-синк через хаб).
  await typeInto(writer, 'привет от writer')
  await expect(editorOf(viewer)).toContainText('привет от writer')

  // Debounced-снапшот хаба долетел до v_node_document_versions.collab_state.
  await expect
    .poll(
      async () => (await (await request.get(`${BACKEND}/e2e/snapshot/${node}`)).json()).has_state,
      { timeout: 15_000, intervals: [1000] },
    )
    .toBe(true)

  await writerCtx.close()
  await viewerCtx.close()
})

test('read-only viewer не может писать в общую комнату (enforced на сервере)', async ({
  browser,
  request,
  baseURL,
}) => {
  const { node_id: node } = await setupScene(request)

  const writerCtx = await browser.newContext()
  const viewerCtx = await browser.newContext()
  const writer = await writerCtx.newPage()
  const viewer = await viewerCtx.newPage()

  await writer.goto(`${baseURL}/?node=${node}&user=1`)
  // force=1 — насильно делаем редактор viewer'а editable, чтобы он ПОПЫТАЛСЯ писать;
  // read_only-сессию хаб должен задавить на сокете (апдейты viewer'а дропаются).
  await viewer.goto(`${baseURL}/?node=${node}&user=2&force=1`)

  await expect(writer.getByTestId('status')).toHaveText('connected:writable')
  await expect(viewer.getByTestId('status')).toHaveText('connected:readonly')

  // writer ставит маркер, оба сходятся.
  await typeInto(writer, 'WRITER-OK')
  await expect(editorOf(viewer)).toContainText('WRITER-OK')

  // viewer пытается вписать своё — до writer это дойти НЕ должно.
  await typeInto(viewer, 'SNEAKY-VIEWER')
  await writer.waitForTimeout(2500)
  await expect(editorOf(writer)).not.toContainText('SNEAKY-VIEWER')
})
