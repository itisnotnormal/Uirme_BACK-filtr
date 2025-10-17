const mongoose = require('mongoose');

const historicalAttendanceSchema = new mongoose.Schema({
  student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  event_name: { type: String, required: true },
  timestamp: { type: Date, default: Date.now },
  scanned_by: { type: String, required: true },
  school_id: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
  studentName: { type: String }, // Optional field for convenience
  archived_at: { type: Date },
});

// Нет уникального индекса, чтобы позволить исторические дубликаты по student_id + event_name

module.exports = mongoose.model('HistoricalAttendanceRecord', historicalAttendanceSchema);