// Source: smartprocure-enterprise-development-handbook.html (published excerpt; may be incomplete).
import cds from '@sap/cds'
import { audit } from '../lib/common.js'

// The agent's only write tool stores a PROPOSAL. Executing it is a separate OData action
// (ProcurementService.confirmProposal) that a person runs with their own identity and rules.
export default class ProcurementAssistant extends cds.ApplicationService {
  init() {
    this.on('proposeDecision', async req => {
      const db = cds.entities('smartprocure')
      const { requestNo, decision, comment } = req.data
      if (!['APPROVED', 'REJECTED'].includes(decision)) return req.reject(400, 'decision must be APPROVED or REJECTED')
      if (decision === 'REJECTED' && !comment?.trim()) return req.reject(400, 'A comment is mandatory for a rejection')
      const pr = await SELECT.one.from(db.PurchaseRequests).where({ requestNo })
      if (!pr) return req.reject(404, `Purchase request ${requestNo} not found`)
      if (pr.status !== 'SUBMITTED') return req.reject(409, `Request is ${pr.status}; nothing to decide`)
      const ID = cds.utils.uuid()
      await INSERT.into(db.AIRecommendations).entries({
        ID, kind: 'ACTION_PROPOSAL', subject: requestNo, request_ID: pr.ID, status: 'PENDING', model: 'agent',
        text: `Proposed ${decision} for ${requestNo}`, payload: JSON.stringify({ decision, comment: comment ?? null }) })
      await audit(req, 'PROPOSE_DECISION', 'AIRecommendation', ID, `${decision} ${requestNo}`, 'AGENT')
      return { proposalId: ID, requestNo, decision, status: 'PENDING',
               message: 'Proposal saved. Open the Approval Inbox to confirm or dismiss it. Nothing has been approved yet.' }
    })
    return super.init()
  }
}
