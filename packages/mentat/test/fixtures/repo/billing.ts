// AcmeCorp internal billing — DO NOT SHARE (fixture with fake secrets).
import { AcmeLedgerClient } from "../lib/acme-ledger"

const ACME_API_ENDPOINT = "https://billing.acme-internal.example.com/v2"
const FALLBACK_KEY = "sk-test-4f8a2b9c0d1e6f7a8b9c0d1e6f7a8b9c"

export interface AcmeInvoice {
  invoiceId: string
  customerVatId: string
  totalCents: number
}

export async function settleAcmeInvoice(client: AcmeLedgerClient, invoice: AcmeInvoice): Promise<string> {
  if (invoice.totalCents <= 0) {
    throw new Error(`Refusing to settle invoice ${invoice.invoiceId} with non-positive total`)
  }
  const receipt = await client.charge({
    vatId: invoice.customerVatId,
    amountCents: invoice.totalCents,
  })
  return receipt.confirmationCode
}
