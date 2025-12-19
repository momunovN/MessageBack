const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  status: { type: String, default: 'pending' } // pending, accepted, rejected
}, { timestamps: true });

module.exports = mongoose.models.Request || mongoose.model('Request', requestSchema);