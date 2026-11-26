---
name: supplier-comparison
description: Compare suppliers for a material or recommend a supplier for a purchase request.
metadata:
  tags: [suppliers, quotations, recommendation]
  examples:
    - Compare suppliers for material RM-1001.
    - Recommend the best supplier for PR-2026-0001.
---

For a material number call compareSupplierQuotations. For a purchase request number call recommendSupplier.
Show a table: rank, supplier, unit price, delivery days, quality, risk, score.
Say which offers have unusualPrice = true and which suppliers have no valid certification.
The score is computed by the server (weights price 40, delivery 25, quality 25, risk 10); explain it, never recalculate it.
