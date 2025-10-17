const mongoose = require('mongoose');

const StudentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  group: { type: String, required: true },
  specialty: { type: String, required: true },
  qr_code: { type: String, required: true, unique: true },
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, required: true },
  enrolled_events: [{ type: String }],
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Student', StudentSchema);