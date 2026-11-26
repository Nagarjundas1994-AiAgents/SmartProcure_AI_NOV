// Source: smartprocure-enterprise-development-handbook.html (published excerpt; may be incomplete).
import cds from '@sap/cds'
import { integrationLog, audit, round2 } from '../lib/common.js'
import { applyReceipt } from '../lib/receipts.js'

const PAGE = () => Number(process.env.S4_PAGE_SIZE ?? 50)

/** Read every row of an S/4 entity, page by page ($top/$skip). A stable $orderby keeps the pages from overlapping. */
export async function fetchAll(srv, entity, keys) {
  const rows = []
  for (let skip = 0; ; skip += PAGE()) {
    const chunk = await srv.run(SELECT.from(entity).orderBy(...keys).limit(PAGE(), skip))
    rows.push(...chunk)
    if (chunk.length < PAGE()) return rows
  }
}

/**
 * US-06: pull purchase orders (header + items) and goods receipts from S/4HANA into HANA Cloud.
 * Field mapping: A_PurchaseOrder.PurchaseOrder -> PurchaseOrders.s4PoNumber, Supplier -> Suppliers.s4PartnerId,
 * Material -> Materials.materialNo, OrderQuantity -> quantity, NetPriceAmount -> unitPrice.
 */
export async function syncFromS4(req) {
  const db = cds.entities('smartprocure')
  const result = { read: 0, created: 0, updated: 0, receipts: 0 }
  const problems = []
  try {
    const po = await cds.connect.to('API_PURCHASEORDER_PROCESS_SRV')
    const md = await cds.connect.to('API_MATERIAL_DOCUMENT_SRV')
    const headers = await fetchAll(po, po.entities.A_PurchaseOrder, ['PurchaseOrder'])
    const items = await fetchAll(po, po.entities.A_PurchaseOrderItem, ['PurchaseOrder', 'PurchaseOrderItem'])
    const docs = await fetchAll(md, md.entities.A_MaterialDocumentItem, ['MaterialDocumentYear', 'MaterialDocument', 'MaterialDocumentItem'])
    result.read = headers.length

    for (const h of headers) {
      const supplier = await SELECT.one.from(db.Suppliers).where({ s4PartnerId: h.Supplier })
      if (!supplier) { problems.push(`PO ${h.PurchaseOrder}: supplier ${h.Supplier} is unknown`); continue }
      const lines = []
      for (const i of items.filter(x => x.PurchaseOrder === h.PurchaseOrder)) {
        const m = await SELECT.one.from(db.Materials).where({ materialNo: i.Material })
        if (!m) { problems.push(`PO ${h.PurchaseOrder}/${i.PurchaseOrderItem}: material ${i.Material} is unknown`); continue }
        lines.push({ itemNo: Number(i.PurchaseOrderItem), material_ID: m.ID, quantity: i.OrderQuantity, unitPrice: i.NetPriceAmount,
                     netAmount: round2(i.OrderQuantity * i.NetPriceAmount) })
      }
      const total = round2(lines.reduce((s, l) => s + l.netAmount, 0))
      const header = { supplier_ID: supplier.ID, currency_code: h.DocumentCurrency, orderDate: h.PurchaseOrderDate, totalAmount: total }

      const existing = await SELECT.one.from(db.PurchaseOrders).where({ s4PoNumber: h.PurchaseOrder })
      if (existing) { await UPDATE(db.PurchaseOrders, existing.ID).with(header); result.updated++; continue }
      if (await SELECT.one.from(db.PurchaseOrders).where({ poNumber: h.PurchaseOrder })) {
        problems.push(`PO ${h.PurchaseOrder}: the number is already used by a local order`); continue
      }
      await INSERT.into(db.PurchaseOrders).entries({ ...header, poNumber: h.PurchaseOrder, s4PoNumber: h.PurchaseOrder, status: 'CONFIRMED', items: lines })
      result.created++
    }

    for (const d of docs.filter(x => x.GoodsMovementType === '101' && x.PurchaseOrder)) {   // 101 = goods receipt for PO
      const grNumber = `S4-${d.MaterialDocument}-${Number(d.MaterialDocumentItem)}`
      if (await SELECT.one.from(db.GoodsReceipts).where({ grNumber })) continue              // idempotent: already imported
      const order = await SELECT.one.from(db.PurchaseOrders).where({ s4PoNumber: d.PurchaseOrder })
      const item = order && await SELECT.one.from(db.PurchaseOrderItems).where({ order_ID: order.ID, itemNo: Number(d.PurchaseOrderItem) })
      if (!item) { problems.push(`Material document ${d.MaterialDocument}: PO ${d.PurchaseOrder}/${d.PurchaseOrderItem} not found locally`); continue }
      await INSERT.into(db.GoodsReceipts).entries({ grNumber, order_ID: order.ID, item_ID: item.ID, quantity: d.QuantityInEntryUnit,
                                                    receivedOn: d.PostingDate, receivedBy: 'S4HANA', source: 'S4' })
      await applyReceipt(order.ID, item.ID, d.QuantityInEntryUnit)
      result.receipts++
    }
  } catch (e) {
    // the business transaction is rolled back by req.reject; the failure is logged in its own transaction
    await cds.tx(() => integrationLog('S4HANA', 'syncFromS4', 'FAILED', 0, 1, [e.message], req.user.id))
    return req.reject(502, `S/4HANA call failed: ${e.message}`)
  }
  await integrationLog('S4HANA', 'syncFromS4', problems.length ? 'PARTIAL' : 'SUCCESS', result.read, problems.length, problems, req.user.id)
  await audit(req, 'S4_SYNC', 'PurchaseOrder', '*', JSON.stringify(result))
  return result
}
