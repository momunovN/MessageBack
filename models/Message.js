const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  type: { type: String, default: 'text' }, // text, image, voice
  text: { type: String },
  data: { type: String }, // base64 для фото/голоса
  timestamp: { type: Date, default: Date.now }
});

messageSchema.index({ from: 1, to: 1 });

module.exports = mongoose.models.Message || mongoose.model('Message', messageSchema);