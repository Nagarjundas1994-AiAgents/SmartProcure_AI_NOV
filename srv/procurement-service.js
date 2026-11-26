// Source: smartprocure-enterprise-development-handbook.html (published excerpt; may be incomplete).
    // ---------- US-01: create a purchase request ----------
    this.before('CREATE', PurchaseRequests, async req => {
      const r = req.data
      const me = await SELECT.one.from(db.Employees).where({ userId: req.user.id })
      if (!me) return req.reject(400, `No employee record for user ${req.user.id}`)
      if (!r.items?.length) return req.reject(400, 'A purchase request needs at least one item')

      let total = 0
      for (const [i, it] of r.items.entries()) {
        const m = it.material_ID && await SELECT.one.from(db.Materials, it.material_ID)
        if (it.material_ID && !m) return req.reject(400, `Item ${i + 1}: unknown material`)
        if (!(Number(it.quantity) > 0)) return req.reject(400, `Item ${i + 1}: quantity must be greater than 0`)
        if (!m && !it.description) return req.reject(400, `Item ${i + 1}: enter a material or a description`)
        it.itemNo = (i + 1) * 10
        it.description ??= m.description
        it.unit ??= m?.baseUnit ?? 'EA'
        it.estimatedPrice ??= m?.standardPrice ?? 0
        it.netAmount = round2(it.quantity * it.estimatedPrice)
        total += it.netAmount
      }

      // duplicate detection: the same person submitting the same title twice
      const open = await SELECT.from(db.PurchaseRequests).columns('requestNo', 'title').where({ requester_ID: me.ID, status: 'SUBMITTED' })
      const dup = open.find(o => o.title.trim().toLowerCase() === (r.title ?? '').trim().toLowerCase())
      if (dup) return req.reject(409, `Duplicate request: ${dup.requestNo} already has the title "${dup.title}"`)

      const all = await SELECT.from(db.PurchaseRequests).columns('requestNo')
      r.requestNo = nextNumber(`PR-${new Date().getFullYear()}-`, 4, all.map(x => x.requestNo))
      Object.assign(r, { requester_ID: me.ID, department_ID: me.department_ID, approver_ID: me.manager_ID,
                         status: 'SUBMITTED', currency_code: 'INR', totalAmount: round2(total) })
    })
    this.after('CREATE', PurchaseRequests, (_, req) => audit(req, 'CREATE', 'PurchaseRequest', req.data.requestNo, `total ${req.data.totalAmount}`))
// ---- next published handbook excerpt ----
    // ---------- US-03: approve / reject ----------
    const decideRequest = async (req, ID, decision, comment) => {
      if (decision === 'REJECTED' && !comment) return req.reject(400, 'A comment is mandatory when rejecting a request')
      const pr = await SELECT.one.from(db.PurchaseRequests, ID)
      if (!pr) return req.reject(404, 'Purchase request not found')
      if (pr.status !== 'SUBMITTED') return req.reject(409, `Request is ${pr.status}; only SUBMITTED requests can be decided`)
      const [approver, requester] = await Promise.all([SELECT.one.from(db.Employees, pr.approver_ID), SELECT.one.from(db.Employees, pr.requester_ID)])
      if (approver?.userId !== req.user.id) return req.reject(403, 'Only the assigned approver may decide this request')
      if (requester?.userId === req.user.id) return req.reject(403, 'You cannot decide your own request')
      if (decision === 'APPROVED' && Number(pr.totalAmount) > Number(approver.approvalLimit))
        return req.reject(400, `Amount ${pr.totalAmount} exceeds your approval limit ${approver.approvalLimit}`)

      await UPDATE(db.PurchaseRequests, ID).with({ status: decision })
      await INSERT.into(db.PurchaseApprovals).entries({ request_ID: ID, approver_ID: approver.ID, decision, comment, decidedAt: new Date().toISOString() })
      await audit(req, decision, 'PurchaseRequest', pr.requestNo, comment ?? '')
      return SELECT.one.from(db.PurchaseRequests, ID)
    }
    const decide = decision => req => decideRequest(req, req.params[0].ID, decision, req.data.comment?.trim())
    this.on('approveRequest', PurchaseRequests, decide('APPROVED'))
    this.on('rejectRequest', PurchaseRequests, decide('REJECTED'))
// ---- next published handbook excerpt ----
    // ---------- US-04: purchase order from an approved request + chosen quotation ----------
    this.on('createPurchaseOrder', PurchaseRequests, async req => {
      const { ID } = req.params[0]
      const pr = await SELECT.one.from(db.PurchaseRequests, ID)
      if (!pr) return req.reject(404, 'Purchase request not found')
      if (pr.status !== 'APPROVED') return req.reject(409, `Request is ${pr.status}; only APPROVED requests can become orders`)
      const q = await SELECT.one.from(db.SupplierQuotations, req.data.quotation)
      if (!q || q.request_ID !== ID) return req.reject(400, 'The quotation does not belong to this request')
      if (q.validUntil && q.validUntil < today()) return req.reject(400, `Quotation ${q.quotationNo} expired on ${q.validUntil}`)
      const sup = await SELECT.one.from(db.Suppliers, q.supplier_ID)
      if (sup.state !== 'ACTIVE') return req.reject(400, `Supplier ${sup.name} is ${sup.state}`)

      const qItems = await SELECT.from(db.SupplierQuotationItems).where({ quotation_ID: q.ID })
      const all = await SELECT.from(db.PurchaseOrders).columns('poNumber')
      const poNumber = String(Math.max(4500000000, ...all.map(a => Number(a.poNumber))) + 1)
      const po = {
        ID: cds.utils.uuid(), poNumber, request_ID: ID, supplier_ID: q.supplier_ID, status: 'CREATED', orderDate: today(),
        promisedDate: new Date(Date.now() + (q.deliveryDays ?? 14) * 864e5).toISOString().slice(0, 10),
        currency_code: q.currency_code, totalAmount: q.totalAmount,
        items: qItems.map((x, i) => ({ itemNo: (i + 1) * 10, material_ID: x.material_ID, quantity: x.quantity, unitPrice: x.unitPrice, netAmount: x.netAmount }))
      }
      await INSERT.into(db.PurchaseOrders).entries(po)
      await UPDATE(db.PurchaseRequests, ID).with({ status: 'ORDERED' })
      await audit(req, 'CREATE_PO', 'PurchaseOrder', poNumber, `from ${pr.requestNo} / ${q.quotationNo}`)
      return SELECT.one.from(db.PurchaseOrders, po.ID)
    })

    // ---------- US-05: goods receipts ----------
    this.before('CREATE', GoodsReceipts, async req => {
      const g = req.data
      const [item, order] = await Promise.all([SELECT.one.from(db.PurchaseOrderItems, g.item_ID), SELECT.one.from(db.PurchaseOrders, g.order_ID)])
      if (!item || !order) return req.reject(400, 'Unknown purchase order or item')
      if (item.order_ID !== order.ID) return req.reject(400, 'The item does not belong to this purchase order')
      if (!OPEN_ORDER.includes(order.status)) return req.reject(409, `Order ${order.poNumber} is ${order.status}; no more receipts possible`)
      if (Number(item.receivedQty) + Number(g.quantity) > Number(item.quantity))
        return req.reject(409, `Over-delivery: ordered ${item.quantity}, already received ${item.receivedQty}`)
      const all = await SELECT.from(db.GoodsReceipts).columns('grNumber')
      g.grNumber = nextNumber(`GR-${new Date().getFullYear()}-`, 4, all.map(x => x.grNumber))
      g.receivedOn ??= today()
      g.receivedBy = req.user.id
      g.source = 'LOCAL'
    })
    this.after('CREATE', GoodsReceipts, async (_, req) => {
      const g = req.data   // the data after the before-handler added grNumber etc.
      await applyReceipt(g.order_ID, g.item_ID, g.quantity)
      await audit(req, 'GOODS_RECEIPT', 'GoodsReceipt', g.grNumber, `qty ${g.quantity}`)
    })
