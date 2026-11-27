import { Router } from 'express';
import { parse, createTransferSchema } from '../lib/validation.js';
import { createTransfer, listTransfers } from '../services/transfers.js';

const router = Router();

router.get('/', (req, res) => {
  res.json({ data: listTransfers(req.user.id) });
});

router.post('/', (req, res) => {
  const body = parse(createTransferSchema, req.body);
  const result = createTransfer(req.user.id, body);
  // 200 means "already done" (same reference). 201 means money just moved.
  res.status(result.duplicate ? 200 : 201).json({
    data: result.transfer,
    meta: { duplicate: result.duplicate },
  });
});

export default router;
