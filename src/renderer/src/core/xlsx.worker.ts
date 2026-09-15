/// <reference lib="webworker" />
import { convertWorkbook, type XlsxConverted } from './xlsxConvert'

/**
 * Off-main-thread XLSX import: the workbook is parsed here and converted into Arrow
 * columns; the IPC stream goes back in a transferred ArrayBuffer.
 */
export interface XlsxRequest {
  id: number
  bytes: ArrayBuffer
  sheet?: string
}

export type XlsxResponse = ({ id: number; ok: true } & XlsxConverted) | { id: number; ok: false; error: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (e: MessageEvent<XlsxRequest>) => {
  const { id, bytes, sheet } = e.data
  try {
    const res = convertWorkbook(new Uint8Array(bytes), sheet)
    scope.postMessage({ id, ok: true, ...res } satisfies XlsxResponse, [res.ipc.buffer as ArrayBuffer])
  } catch (err) {
    scope.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies XlsxResponse)
  }
}
