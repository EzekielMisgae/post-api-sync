const express = require('express');
const router = express.Router();

router.get('/users', (req, res) => {
  res.json([]);
});

router.route('/users/:id')
  .get((req, res) => res.json({ id: req.params.id }))
  .put((req, res) => res.json({ id: req.params.id }));

module.exports = router;
