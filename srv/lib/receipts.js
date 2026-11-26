// Source: smartprocure-enterprise-development-handbook.html (published excerpt; may be incomplete).
import cds from '@sap/cds'

/** Add a received quantity to a PO item; close the delivery when every item is complete. Used by local and S/4 receipts. */
export async function applyReceipt(orderId, itemId, qty) {
  const db = cds.entities('smartprocure')
  await UPDATE(db.PurchaseOrderItems, itemId).with({ receivedQty: { '+=': Number(qty) } })
  const items = await SELECT.from(db.PurchaseOrderItems).where({ order_ID: orderId })
  if (items.every(i => Number(i.receivedQty) >= Number(i.quantity)))
    await UPDATE(db.PurchaseOrders, orderId).with({ status: 'DELIVERED', deliveryStatus: 'DELIVERED' })
}
