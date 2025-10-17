const mongoose = require('mongoose');

const SchoolSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  city: { type: String, required: true },
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('School', SchoolSchema);